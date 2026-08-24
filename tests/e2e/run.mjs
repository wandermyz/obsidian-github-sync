/**
 * End-to-end tests against a real GitHub repository.
 *
 * These exercise the shipped engine (src/sync.ts + src/github.ts) bundled
 * through esbuild with `obsidian` aliased to a Node shim, so what's tested is
 * what ships — not a reimplementation.
 *
 * Every run works inside its own folder in the remote repo and its own scratch
 * vault on disk, and removes both afterwards, so concurrent or abandoned runs
 * can't interfere with each other.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadEngine, repoRoot } from "./load-engine.mjs";
import { fakeVault } from "./obsidian-shim.mjs";
import { getAccessToken, loadConfig } from "./config.mjs";

const RUN_ID = randomUUID().slice(0, 8);
const REMOTE_FOLDER = `e2e/${RUN_ID}`;
const TMP_ROOT = path.join(repoRoot, ".e2e-tmp", RUN_ID);

let passed = 0;
const failures = [];

async function test(name, fn) {
	process.stdout.write(`  ${name} ... `);
	try {
		await fn();
		passed++;
		console.log("ok");
	} catch (err) {
		failures.push({ name, err });
		console.log("FAILED");
		console.log(`      ${err.stack ?? err.message}`);
	}
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
	if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`);
}

/**
 * Commit files straight to the branch, standing in for "another device pushed".
 * `null` content deletes the path.
 */
async function remoteCommit(client, ctx, files, message) {
	const head = await client.branchHead(ctx.owner, ctx.repo, ctx.branch);
	const entries = [];
	for (const [relative, content] of Object.entries(files)) {
		const full = `${REMOTE_FOLDER}/${relative}`;
		if (content === null) {
			entries.push({ path: full, mode: "100644", type: "blob", sha: null });
		} else {
			const sha = await client.createBlob(ctx.owner, ctx.repo, Buffer.from(content, "utf8"));
			entries.push({ path: full, mode: "100644", type: "blob", sha });
		}
	}
	const tree = await client.createTree(ctx.owner, ctx.repo, head, entries);
	const commit = await client.createCommit(ctx.owner, ctx.repo, message, tree, [head]);
	await client.updateRef(ctx.owner, ctx.repo, ctx.branch, commit);
	return commit;
}

/** Paths under the run's remote folder at the current head, relative to it. */
async function remoteFiles(client, ctx) {
	const head = await client.branchHead(ctx.owner, ctx.repo, ctx.branch);
	const tree = await client.listTree(ctx.owner, ctx.repo, head);
	return tree
		.filter((b) => b.path.startsWith(`${REMOTE_FOLDER}/`))
		.map((b) => b.path.slice(REMOTE_FOLDER.length + 1))
		.sort();
}

async function readRemote(client, ctx, relative) {
	return client.readFile(ctx.owner, ctx.repo, `${REMOTE_FOLDER}/${relative}`);
}

/** A fresh scratch vault plus an engine pointed at this run's remote folder. */
async function makeVault(engine, client, ctx, name) {
	const root = path.join(TMP_ROOT, name);
	await fs.mkdir(root, { recursive: true });
	const vault = fakeVault(root);
	const sync = new engine.SyncEngine(vault, client, {
		owner: ctx.owner,
		repo: ctx.repo,
		branch: ctx.branch,
		targetFolder: "",
		remoteFolder: REMOTE_FOLDER,
		deviceLabel: name,
	});
	return { root, vault, sync };
}

/** Pull then push, the way the plugin's sync command does. */
async function pullThenPush(sync, state) {
	const plan = await sync.plan(state);
	const pulled = await sync.apply(plan, state);
	const pushed = await sync.push(pulled.state);
	return { plan, pull: pulled.report, push: pushed.report, state: pushed.state };
}

const write = (root, relative, text) =>
	fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true }).then(() =>
		fs.writeFile(path.join(root, relative), text, "utf8"),
	);

const read = (root, relative) => fs.readFile(path.join(root, relative), "utf8");

const exists = (root, relative) =>
	fs
		.access(path.join(root, relative))
		.then(() => true)
		.catch(() => false);

async function main() {
	const config = await loadConfig();
	console.log(`\nobsidian-github-sync e2e`);
	console.log(`  repo:   ${config.owner}/${config.repo}`);
	console.log(`  folder: ${REMOTE_FOLDER}`);

	const engine = await loadEngine();
	const token = await getAccessToken(config, engine, { interactive: false });
	const host = engine.hostFromWebBase(config.webBase);
	const client = new engine.GitHubClient(host, token);

	const user = await client.currentUser();
	const branch = config.branch || (await client.defaultBranch(config.owner, config.repo));
	const ctx = { owner: config.owner, repo: config.repo, branch };
	console.log(`  as:     ${user.login} on branch ${branch}\n`);

	try {
		await run(engine, client, ctx);
	} finally {
		await cleanup(client, ctx);
		await fs.rm(TMP_ROOT, { recursive: true, force: true });
	}

	console.log(`\n${passed} passed, ${failures.length} failed`);
	if (failures.length) {
		for (const f of failures) console.log(`  FAILED: ${f.name}`);
		process.exitCode = 1;
	}
}

async function run(engine, client, ctx) {
	// Device A's state carries across tests: that's the point — later tests
	// depend on the incremental bookkeeping earlier ones produced.
	let a = null;
	let stateA = null;

	await test("full sync materializes the remote folder", async () => {
		await remoteCommit(
			client,
			ctx,
			{ "Note.md": "# Note\nhello\n", "folder/Nested.md": "nested\n" },
			`e2e ${RUN_ID}: seed`,
		);

		a = await makeVault(engine, client, ctx, "device-a");
		const plan = await a.sync.plan(null);
		assertEqual(plan.mode, "full", "first sync should be full");

		const { report, state } = await a.sync.apply(plan, null);
		stateA = state;

		assertEqual(report.added, 2, "files added");
		assertEqual(report.integrityFailures.length, 0, "integrity failures");
		assertEqual(report.verifiedFiles, 2, "verified files");
		assertEqual(await read(a.root, "Note.md"), "# Note\nhello\n", "Note.md contents");
		assertEqual(await read(a.root, "folder/Nested.md"), "nested\n", "nested contents");
		assert(state.commit, "state should record the commit");
	});

	await test("incremental sync applies a remote edit, add and delete", async () => {
		await remoteCommit(
			client,
			ctx,
			{ "Note.md": "# Note\nedited\n", "Added.md": "new\n", "folder/Nested.md": null },
			`e2e ${RUN_ID}: edit, add, delete`,
		);

		const plan = await a.sync.plan(stateA);
		assertEqual(plan.mode, "incremental", "should be incremental");

		const { report, state } = await a.sync.apply(plan, stateA);
		stateA = state;

		assertEqual(report.updated, 1, "updated");
		assertEqual(report.added, 1, "added");
		assertEqual(report.deleted, 1, "deleted");
		assertEqual(await read(a.root, "Note.md"), "# Note\nedited\n", "edited contents");
		assertEqual(await exists(a.root, "folder/Nested.md"), false, "deleted file should be gone");
	});

	await test("no-op sync reports already-current", async () => {
		const plan = await a.sync.plan(stateA);
		assertEqual(plan.writes.length, 0, "writes");
		assertEqual(plan.deletes.length, 0, "deletes");

		const { report } = await a.sync.push(stateA);
		assertEqual(report.uploaded.length, 0, "nothing to upload");
		assertEqual(report.commit, null, "no commit for an empty push");
		assertEqual(report.raced, false, "not raced");
	});

	await test("push uploads a new file, an edit and a deletion", async () => {
		await write(a.root, "Local.md", "written locally\n");
		await write(a.root, "Note.md", "# Note\nlocally edited\n");
		await fs.rm(path.join(a.root, "Added.md"));

		const { report, state } = await a.sync.push(stateA);
		stateA = state;

		assertEqual(report.blocked, null, "should not be blocked");
		assertEqual(report.raced, false, "should not race");
		assert(report.commit, "push should produce a commit");
		assertEqual(report.uploaded.sort().join(","), "Local.md,Note.md", "uploaded paths");
		assertEqual(report.removed.join(","), "Added.md", "removed paths");

		const remote = await remoteFiles(client, ctx);
		assertEqual(remote.join(","), "Local.md,Note.md", "remote tree after push");
		assertEqual(await readRemote(client, ctx, "Local.md"), "written locally\n", "remote contents");
		assertEqual(state.commit, report.commit, "state advances to the pushed commit");
	});

	await test("a second device pulls what the first pushed", async () => {
		const b = await makeVault(engine, client, ctx, "device-b");
		const plan = await b.sync.plan(null);
		const { report } = await b.sync.apply(plan, null);

		assertEqual(report.added, 2, "device B added");
		assertEqual(await read(b.root, "Local.md"), "written locally\n", "device B contents");
		assertEqual(await exists(b.root, "Added.md"), false, "deleted file not resurrected");
	});

	await test("a concurrent push is detected rather than clobbered", async () => {
		// Local edit staged against a state that is one commit behind.
		await write(a.root, "Local.md", "device A's version\n");
		const stale = stateA;
		await remoteCommit(client, ctx, { "Local.md": "device B's version\n" }, `e2e ${RUN_ID}: B edits`);

		const { report } = await a.sync.push(stale);
		assertEqual(report.raced, true, "push should report a race");
		assertEqual(report.commit, null, "raced push must not commit");
		assertEqual(
			await readRemote(client, ctx, "Local.md"),
			"device B's version\n",
			"remote must be untouched by the raced push",
		);
	});

	await test("both-sides edit produces a conflict copy and pushes it", async () => {
		// Continues from the race above: the local file still holds device A's
		// text, and the remote holds device B's.
		const plan = await a.sync.plan(stateA);
		const { report, state } = await a.sync.apply(plan, stateA);
		stateA = state;

		assertEqual(report.conflicts.length, 1, "one conflict");
		const copy = report.conflicts[0];
		assert(copy.startsWith("Local (conflict "), `unexpected conflict name: ${copy}`);
		assert(copy.endsWith(".md"), `conflict copy should keep the extension: ${copy}`);
		assertEqual(await read(a.root, copy), "device A's version\n", "conflict copy keeps local bytes");
		assertEqual(await read(a.root, "Local.md"), "device B's version\n", "canonical path takes remote");
		assertEqual(report.skippedLocalEdits.length, 0, "nothing should be skipped");

		const pushed = await a.sync.push(stateA);
		stateA = pushed.state;
		assertEqual(pushed.report.uploaded.join(","), copy, "conflict copy is pushed");

		const remote = await remoteFiles(client, ctx);
		assert(remote.includes(copy), `remote should list the conflict copy: ${remote.join(", ")}`);
		assertEqual(await readRemote(client, ctx, copy), "device A's version\n", "remote conflict bytes");
	});

	await test("mass deletion is refused", async () => {
		const bulk = {};
		for (let i = 0; i < 20; i++) bulk[`bulk/File ${i}.md`] = `file ${i}\n`;
		await remoteCommit(client, ctx, bulk, `e2e ${RUN_ID}: bulk`);

		const plan = await a.sync.plan(stateA);
		const { state } = await a.sync.apply(plan, stateA);
		stateA = state;

		await fs.rm(path.join(a.root, "bulk"), { recursive: true });

		const { report } = await a.sync.push(stateA);
		assert(report.blocked, "bulk deletion should be blocked");
		assertEqual(report.commit, null, "blocked push must not commit");
		assertEqual((await remoteFiles(client, ctx)).length, 23, "remote must be intact");

		// Put the files back so the state stays truthful for anything after this.
		for (const [relative, content] of Object.entries(bulk)) await write(a.root, relative, content);
	});

	await test("the plugin's own config folder is never synced", async () => {
		await remoteCommit(
			client,
			ctx,
			{ ".obsidian/plugins/github-sync/data.json": '{"accessToken":"nope"}' },
			`e2e ${RUN_ID}: hostile .obsidian`,
		);

		const plan = await a.sync.plan(stateA);
		assert(
			!plan.writes.some((w) => w.path.includes(".obsidian")),
			"a .obsidian path was planned for write",
		);

		const { state } = await a.sync.apply(plan, stateA);
		stateA = state;
		assertEqual(await exists(a.root, ".obsidian/plugins/github-sync/data.json"), false, ".obsidian written");
	});
}

/** Remove everything this run put in the repo, in one commit. */
async function cleanup(client, ctx) {
	try {
		const files = await remoteFiles(client, ctx);
		if (!files.length) return;
		const entries = files.map((f) => ({
			path: `${REMOTE_FOLDER}/${f}`,
			mode: "100644",
			type: "blob",
			sha: null,
		}));
		const head = await client.branchHead(ctx.owner, ctx.repo, ctx.branch);
		const tree = await client.createTree(ctx.owner, ctx.repo, head, entries);
		const commit = await client.createCommit(
			ctx.owner,
			ctx.repo,
			`e2e ${RUN_ID}: cleanup`,
			tree,
			[head],
		);
		await client.updateRef(ctx.owner, ctx.repo, ctx.branch, commit);
		console.log(`\n  cleaned up ${REMOTE_FOLDER} (${files.length} files)`);
	} catch (err) {
		console.warn(`\n  cleanup of ${REMOTE_FOLDER} failed: ${err.message}`);
	}
}

main().catch((err) => {
	console.error(`\n${err.stack ?? err.message}`);
	process.exitCode = 1;
});
