/**
 * Offline tests for plan(), driven by a stub client.
 *
 * Planning is pure decision-making over API responses, so it can be pinned
 * without touching the network — which lets these cover shapes the live e2e
 * repo can't produce on demand, like a compare entry with no blob SHA.
 */
import assert from "node:assert/strict";
import { loadEngine } from "../e2e/load-engine.mjs";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const HEAD = "c".repeat(40);

/** A vault adapter that does nothing; plan() never touches the disk. */
const vault = { adapter: {}, configDir: ".obsidian", getFileByPath: () => null };

const OPTS = {
	owner: "o",
	repo: "r",
	branch: "main",
	targetFolder: "",
	remoteFolder: "",
	deviceLabel: "test",
};

function stubClient(overrides) {
	return {
		branchHead: async () => HEAD,
		compare: async () => ({ status: "ahead", files: [], truncated: false, total_commits: 1 }),
		listTree: async () => [],
		...overrides,
	};
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("a compare entry with a null sha forces a full sync", async (engine) => {
	let listedTree = false;
	const client = stubClient({
		compare: async () => ({
			status: "ahead",
			total_commits: 1,
			truncated: false,
			files: [
				{ filename: "notes/kept.md", status: "modified", sha: SHA_A },
				// GitHub omits the blob SHA for entries it won't attribute to a
				// blob. This used to be interpolated straight into the request URL,
				// producing GET /git/blobs/null and a 422.
				{ filename: "vendor/thing", status: "added", sha: null },
			],
		}),
		listTree: async () => {
			listedTree = true;
			return [{ path: "notes/kept.md", sha: SHA_A, size: 1 }];
		},
	});

	const plan = await new engine.SyncEngine(vault, client, OPTS).plan({
		commit: SHA_B,
		blobs: {},
	});

	assert.equal(plan.mode, "full", "should abandon the diff, not plan a null-sha write");
	assert.ok(listedTree, "the full plan should come from the tree listing");
	for (const write of plan.writes) {
		assert.match(write.blobSha, /^[0-9a-f]{40}$/, `bad sha planned for ${write.path}`);
	}
});

test("a missing sha field is treated the same as an explicit null", async (engine) => {
	const client = stubClient({
		compare: async () => ({
			status: "ahead",
			total_commits: 1,
			truncated: false,
			files: [{ filename: "notes/a.md", status: "modified" }],
		}),
	});

	const plan = await new engine.SyncEngine(vault, client, OPTS).plan({
		commit: SHA_B,
		blobs: {},
	});
	assert.equal(plan.mode, "full");
});

test("a normal diff still plans incrementally", async (engine) => {
	const client = stubClient({
		compare: async () => ({
			status: "ahead",
			total_commits: 1,
			truncated: false,
			files: [
				{ filename: "notes/a.md", status: "modified", sha: SHA_A },
				{ filename: "notes/gone.md", status: "removed", sha: SHA_B },
			],
		}),
		listTree: async () => {
			throw new Error("should not fall back to a full sync");
		},
	});

	const plan = await new engine.SyncEngine(vault, client, OPTS).plan({
		commit: SHA_B,
		blobs: {},
	});

	assert.equal(plan.mode, "incremental");
	assert.deepEqual(plan.writes, [{ path: "notes/a.md", blobSha: SHA_A }]);
	assert.deepEqual(plan.deletes, ["notes/gone.md"]);
});

test("a renamed config folder is never planned for write", async (engine) => {
	const client = stubClient({
		listTree: async () => [
			{ path: "notes/a.md", sha: SHA_A, size: 1 },
			// The user moved Obsidian's config out of `.obsidian`; a repo must not
			// be able to write into the new location either.
			{ path: ".config/plugins/x/local.json", sha: SHA_B, size: 1 },
			{ path: "sub/.config/plugins/x/data.json", sha: SHA_B, size: 1 },
		],
	});

	const plan = await new engine.SyncEngine({ adapter: {}, configDir: ".config", getFileByPath: () => null }, client, OPTS).plan(null);
	assert.deepEqual(plan.writes, [{ path: "notes/a.md", blobSha: SHA_A }]);
});

test("readBlob rejects a malformed sha before issuing a request", async (engine) => {
	const client = new engine.GitHubClient({ api: "https://api.github.com" }, "token");
	await assert.rejects(
		() => client.readBlob("o", "r", null),
		/malformed SHA/,
		"should fail locally rather than 422 at the API",
	);
});

test("the built-in app is used on github.com when no client ID is set", async (engine) => {
	const dotcom = engine.hostFromWebBase("https://github.com");
	assert.equal(engine.resolveClientId("", dotcom), engine.DEFAULT_APP.clientId);
	assert.equal(engine.resolveClientId("  ", dotcom), engine.DEFAULT_APP.clientId);
	assert.equal(engine.resolveClientId("Ov23custom", dotcom), "Ov23custom", "a configured ID wins");
});

test("GitHub Enterprise Server has no built-in app", async (engine) => {
	const ghes = engine.hostFromWebBase("https://github.example.com");
	assert.equal(engine.resolveClientId("", ghes), "", "an app on github.com doesn't exist on GHES");
	assert.equal(engine.resolveClientId("Iv23onprem", ghes), "Iv23onprem");
});

test("GitHub Apps and OAuth apps are told apart by client ID", async (engine) => {
	assert.equal(engine.isGitHubApp(engine.DEFAULT_APP.clientId), true);
	assert.equal(engine.isGitHubApp("Iv1.0123456789abcdef"), true);
	assert.equal(engine.isGitHubApp("Ov23lij3rM1mv0XDnuiA"), false);
	assert.equal(engine.isGitHubApp("0123456789abcdef0123"), false, "legacy OAuth app IDs are hex");
});

const lagError = (message) => Object.assign(new Error(`GitHub API 422 on /git/commits: ${message}`), { status: 422 });

test("a write GitHub hasn't replicated yet is retried", async (engine) => {
	let calls = 0;
	const result = await engine.retryOnLag(async () => {
		if (++calls < 3) throw lagError("Tree SHA does not exist");
		return "commit-sha";
	}, [0, 0, 0]);
	assert.equal(result, "commit-sha");
	assert.equal(calls, 3);
});

test("a rejected fast-forward is not mistaken for lag", async (engine) => {
	let calls = 0;
	await assert.rejects(
		engine.retryOnLag(async () => {
			calls++;
			throw lagError("Update is not a fast forward");
		}, [0, 0, 0]),
		/not a fast forward/,
	);
	assert.equal(calls, 1, "the push's race detection depends on seeing this at once");
});

test("lag retries give up eventually", async (engine) => {
	let calls = 0;
	await assert.rejects(
		engine.retryOnLag(async () => {
			calls++;
			throw lagError("Tree SHA does not exist");
		}, [0, 0]),
		/does not exist/,
	);
	assert.equal(calls, 3);
});

/** An in-memory DataAdapter: just enough of the filesystem for apply(). */
function memoryAdapter(files) {
	const store = new Map(Object.entries(files).map(([p, text]) => [p, bytes(text)]));
	return {
		store,
		exists: async (p) => store.has(p) || [...store.keys()].some((k) => k.startsWith(`${p}/`)),
		readBinary: async (p) => store.get(p),
		writeBinary: async (p, data) => void store.set(p, data),
		mkdir: async () => {},
		trashLocal: async (p) => void store.delete(p),
		// Flat listing of a folder's direct children, as Obsidian's adapter returns it.
		list: async (dir) => {
			const prefix = dir === "/" || dir === "" ? "" : `${dir}/`;
			const files = new Set();
			const folders = new Set();
			for (const key of store.keys()) {
				if (!key.startsWith(prefix)) continue;
				const rest = key.slice(prefix.length);
				const slash = rest.indexOf("/");
				if (slash === -1) files.add(key);
				else folders.add(prefix + rest.slice(0, slash));
			}
			return { files: [...files], folders: [...folders] };
		},
	};
}

/**
 * A vault with an empty index, so every read and write falls through to the
 * adapter — the same path the engine takes for files Obsidian hasn't indexed.
 */
function memoryVault(adapter) {
	return {
		adapter,
		configDir: ".obsidian",
		getFileByPath: () => null,
		createBinary: async (p, data) => adapter.writeBinary(p, data),
		createFolder: async () => {},
	};
}

function bytes(text) {
	const b = new TextEncoder().encode(text);
	return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

/** A client serving blobs by SHA; `failOn` makes one download throw, like a big file on mobile. */
function blobClient(blobs, failOn) {
	return {
		readBlob: async (_o, _r, sha) => {
			if (sha === failOn) throw new Error("network error");
			return bytes(blobs[sha]);
		},
	};
}

test("a file already at the remote version is not a conflict", async (engine) => {
	// The vault was updated by an earlier pull that crashed before saving state,
	// so the recorded SHA is stale but the disk already matches the remote.
	const oldSha = await engine.gitBlobShaOfText("v1");
	const newSha = await engine.gitBlobShaOfText("v2");
	const adapter = memoryAdapter({ "a.md": "v2" });
	const sync = new engine.SyncEngine(memoryVault(adapter), blobClient({}), OPTS, {});

	const { report, state } = await sync.apply(
		{ mode: "incremental", reason: "", targetCommit: HEAD, writes: [{ path: "a.md", blobSha: newSha }], deletes: [], unchanged: 0 },
		{ commit: SHA_B, blobs: { "a.md": oldSha }, lastSyncedAt: 0 },
	);

	assert.deepEqual(report.conflicts, []);
	assert.deepEqual([...adapter.store.keys()], ["a.md"], "no conflict copy should be written");
	assert.equal(state.blobs["a.md"], newSha);
	assert.equal(state.commit, HEAD);
});

test("a genuine local edit still gets a conflict copy", async (engine) => {
	const oldSha = await engine.gitBlobShaOfText("v1");
	const newSha = await engine.gitBlobShaOfText("v2");
	const adapter = memoryAdapter({ "a.md": "mine" });
	const sync = new engine.SyncEngine(memoryVault(adapter), blobClient({ [newSha]: "v2" }), OPTS, {});

	const { report } = await sync.apply(
		{ mode: "incremental", reason: "", targetCommit: HEAD, writes: [{ path: "a.md", blobSha: newSha }], deletes: [], unchanged: 0 },
		{ commit: SHA_B, blobs: { "a.md": oldSha }, lastSyncedAt: 0 },
	);

	assert.equal(report.conflicts.length, 1);
	assert.equal(new TextDecoder().decode(adapter.store.get(report.conflicts[0])), "mine");
	assert.equal(new TextDecoder().decode(adapter.store.get("a.md")), "v2");
});

test("a pull that fails partway checkpoints the files it already wrote", async (engine) => {
	const [a1, a2, b1, b2] = await Promise.all(["a1", "a2", "b1", "b2"].map(engine.gitBlobShaOfText));
	const adapter = memoryAdapter({ "a.md": "a1", "big.db": "b1" });
	const sync = new engine.SyncEngine(memoryVault(adapter), blobClient({ [a2]: "a2" }, b2), OPTS, {});
	const base = { commit: SHA_B, blobs: { "a.md": a1, "big.db": b1 }, lastSyncedAt: 0 };
	const plan = {
		mode: "incremental", reason: "", targetCommit: HEAD, deletes: [], unchanged: 0,
		writes: [{ path: "a.md", blobSha: a2 }, { path: "big.db", blobSha: b2 }],
	};

	let saved = null;
	await assert.rejects(() => sync.apply(plan, base, undefined, async (s) => void (saved = s)), /network error/);

	assert.ok(saved, "progress should be checkpointed before the error propagates");
	assert.equal(saved.commit, SHA_B, "the commit pointer must not advance on a partial pull");
	assert.equal(saved.blobs["a.md"], a2, "the file that landed is recorded at its new version");
	assert.equal(saved.blobs["big.db"], b1);

	// The retry — the run that used to turn a.md into a conflict copy.
	const retry = new engine.SyncEngine(memoryVault(adapter), blobClient({ [a2]: "a2", [b2]: "b2" }), OPTS, {});
	const { report } = await retry.apply(plan, saved);
	assert.deepEqual(report.conflicts, []);
	assert.deepEqual([...adapter.store.keys()].sort(), ["a.md", "big.db"]);
});

test("a full resync discards local changes without leaving anything to push", async (engine) => {
	const [same, remoteB, mine] = await Promise.all(["same", "remote b", "mine"].map(engine.gitBlobShaOfText));
	const adapter = memoryAdapter({ "a.md": "same", "b.md": "mine", "local-only.md": "draft", "sub/new.md": "x" });
	const client = {
		...blobClient({ [same]: "same", [remoteB]: "remote b" }),
		branchHead: async () => HEAD,
		listTree: async () => [
			{ path: "a.md", sha: same, size: 1 },
			{ path: "b.md", sha: remoteB, size: 1 },
		],
	};
	const sync = new engine.SyncEngine(memoryVault(adapter), client, OPTS, {});

	const plan = await sync.planResync();
	assert.deepEqual(plan.overwritten, ["b.md"], "only the file whose content differs is reported as lost");
	assert.deepEqual(plan.localOnly.sort(), ["local-only.md", "sub/new.md"]);

	const { report, state } = await sync.apply(plan, null);
	assert.deepEqual(report.conflicts, [], "a resync must not keep conflict copies, which the next sync would push");
	assert.deepEqual([...adapter.store.keys()].sort(), ["a.md", "b.md"]);
	assert.equal(new TextDecoder().decode(adapter.store.get("b.md")), "remote b");
	assert.equal(state.commit, HEAD);
	assert.deepEqual(state.blobs, { "a.md": same, "b.md": remoteB });
	assert.notEqual(state.blobs["b.md"], mine);
});

const engine = await loadEngine();
let failed = 0;

for (const { name, fn } of tests) {
	try {
		await fn(engine);
		console.log(`  ok   ${name}`);
	} catch (err) {
		failed++;
		console.error(`  FAIL ${name}\n       ${err.message}`);
	}
}

console.log(`\n${tests.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
