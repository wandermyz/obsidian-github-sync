/**
 * End-to-end tests inside the real Obsidian desktop app.
 *
 *   npm run test:app                # desktop, then emulated phone
 *   npm run test:app -- desktop     # one mode only
 *   npm run test:app -- mobile
 *
 * Where tests/e2e/ drives the engine from Node, this installs the built plugin
 * (main.js, manifest.json, styles.css) into a scratch vault, launches Obsidian
 * on it, and goes through the same surfaces a user does: commands, the vault
 * API, notices, the settings tab, and the sign-in modal. "mobile" is Obsidian's
 * own `app.emulateMobile` at phone size — it covers Platform.isMobile and the
 * phone layout, not iOS's networking or file system.
 *
 * Quits and relaunches Obsidian; the user's vaults are reopened at the end.
 * Uses the token and repo from tests/e2e (`npm run test:e2e:login` once).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadEngine, repoRoot } from "../e2e/load-engine.mjs";
import { getAccessToken, loadConfig } from "../e2e/config.mjs";
import { PLUGIN_ID, createVault, emulatePhone, enablePlugin, launch, restore, waitFor } from "./obsidian.mjs";
import { commitEntries } from "../e2e/remote.mjs";

const RUN_ID = randomUUID().slice(0, 8);
const TMP_ROOT = path.join(repoRoot, ".e2e-tmp", `app-${RUN_ID}`);
const SCREENSHOTS = path.join(TMP_ROOT, "screenshots");
const P = `app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}]`;

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
	if (actual !== expected) {
		throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
	}
}

/** Commit straight to the branch, standing in for another device. `null` deletes. */
async function remoteCommit(client, ctx, folder, files, message) {
	const entries = [];
	for (const [relative, content] of Object.entries(files)) {
		const full = `${folder}/${relative}`;
		if (content === null) {
			entries.push({ path: full, mode: "100644", type: "blob", sha: null });
		} else {
			const sha = await client.createBlob(ctx.owner, ctx.repo, Buffer.from(content, "utf8"));
			entries.push({ path: full, mode: "100644", type: "blob", sha });
		}
	}
	const commit = await commitEntries(client, ctx, entries, message);
	// GitHub's reads can briefly lag a ref update. Wait until the branch reports
	// the new head, or the plugin may sync against the previous commit.
	await waitFor(
		async () => (await client.branchHead(ctx.owner, ctx.repo, ctx.branch)) === commit,
		15000,
		"the branch to show the new commit",
	);
}

async function remoteFiles(client, ctx, folder) {
	const head = await client.branchHead(ctx.owner, ctx.repo, ctx.branch);
	const tree = await client.listTree(ctx.owner, ctx.repo, head);
	return tree
		.filter((b) => b.path.startsWith(`${folder}/`))
		.map((b) => b.path.slice(folder.length + 1))
		.sort();
}

const readRemote = (client, ctx, folder, relative) =>
	client.readFile(ctx.owner, ctx.repo, `${folder}/${relative}`);

const exists = (root, relative) =>
	fs
		.access(path.join(root, relative))
		.then(() => true)
		.catch(() => false);

const readLocal = (root, relative) => fs.readFile(path.join(root, relative), "utf8");

async function main() {
	const modes = process.argv[2] ? [process.argv[2]] : ["desktop", "mobile"];
	for (const mode of modes) {
		if (mode !== "desktop" && mode !== "mobile") throw new Error(`Unknown mode "${mode}"`);
	}

	const config = await loadConfig();
	const engine = await loadEngine();
	const accessToken = await getAccessToken(config, engine, { interactive: false });
	const client = new engine.GitHubClient(engine.hostFromWebBase(config.webBase), accessToken);
	const branch = config.branch || (await client.defaultBranch(config.owner, config.repo));
	const ctx = { owner: config.owner, repo: config.repo, branch };
	const { login } = await client.currentUser();

	// Only the access token goes into the vault. Handing the plugin the refresh
	// token would let it rotate the one the e2e cache depends on.
	const cached = process.env.E2E_TOKEN
		? {}
		: JSON.parse(await fs.readFile(path.join(repoRoot, ".e2e-token.json"), "utf8"));

	console.log(`\ngithub-enterprise-sync app e2e (Obsidian desktop)`);
	console.log(`  repo:   ${ctx.owner}/${ctx.repo} on ${branch}, as ${login}`);

	const folders = [];
	try {
		for (const mode of modes) {
			const folder = `app-e2e/${RUN_ID}-${mode}`;
			folders.push(folder);
			console.log(`\n[${mode}] folder ${folder}`);
			const vaultRoot = path.join(TMP_ROOT, `vault-${mode}`);
			await createVault(vaultRoot, {
				repoRoot,
				settings: {
					clientId: config.clientId,
					githubWebBase: config.webBase,
					scope: config.scope,
					syncRepo: `${ctx.owner}/${ctx.repo}`,
					branch,
					remoteFolder: folder,
					targetFolder: "",
					syncOnStartup: false,
					autoSyncEnabled: false,
					autoSyncMinutes: 15,
				},
				local: {
					accessToken,
					login,
					accessTokenExpiresAt: cached.accessTokenExpiresAt ?? 0,
					refreshToken: "",
					refreshTokenExpiresAt: 0,
					syncState: null,
					deviceLabel: "",
				},
			});

			const page = await launch(vaultRoot);
			if (mode === "mobile") await emulatePhone(page);
			await enablePlugin(page);
			await runSuite({ page, client, accessToken, ctx, folder, vaultRoot, mode });
		}
	} finally {
		await restore().catch((err) => console.log(`  could not restore Obsidian: ${err.message}`));
		await cleanup(client, ctx, folders).catch((err) => console.log(`  cleanup failed: ${err.message}`));
		for (const mode of modes) await fs.rm(path.join(TMP_ROOT, `vault-${mode}`), { recursive: true, force: true });
	}

	console.log(`\n${passed} passed, ${failures.length} failed`);
	console.log(`Screenshots: ${SCREENSHOTS}`);
	if (failures.length) {
		for (const f of failures) console.log(`  FAILED: ${f.name}`);
		process.exitCode = 1;
	}
}

async function runSuite({ page, client, accessToken, ctx, folder, vaultRoot, mode }) {
	const tag = `app-e2e ${RUN_ID} ${mode}`;
	const shot = (name) => page.screenshot(path.join(SCREENSHOTS, `${mode}-${name}.png`));

	const notices = () => page.eval(`[...document.querySelectorAll(".notice")].map((n) => n.innerText)`);
	const clearNotices = () => page.eval(`document.querySelectorAll(".notice").forEach((n) => n.remove())`);
	/** Run the real "Sync now" command and wait for that run to finish. */
	const syncViaCommand = async () => {
		const before = await page.eval(`${P}.local.syncState?.lastSyncedAt ?? 0`);
		await clearNotices();
		const ran = await page.eval(`app.commands.executeCommandById("${PLUGIN_ID}:sync-now")`);
		assert(ran, "sync-now command did not run");
		await waitFor(
			() => page.eval(`!${P}.syncing && (${P}.local.syncState?.lastSyncedAt ?? 0) > ${before}`),
			60000,
			"sync to finish",
		);
	};
	/** Wait until Obsidian's vault index sees a file the plugin wrote behind its back. */
	const indexed = (relative) =>
		waitFor(() => page.eval(`!!app.vault.getFileByPath(${JSON.stringify(relative)})`), 10000, `${relative} indexed`);

	await test("plugin loads with its commands, status bar and styles", async () => {
		const commands = await page.eval(
			`Object.keys(app.commands.commands).filter((id) => id.startsWith("${PLUGIN_ID}:")).sort()`,
		);
		assertEqual(
			commands.join(","),
			["full-resync", "sign-in", "sign-out", "sync-now", "verify-access"].map((c) => `${PLUGIN_ID}:${c}`).join(","),
			"commands",
		);
		const styled = await page.eval(
			`[...document.styleSheets].some((s) => [...s.cssRules].some((r) => r.cssText?.includes("github-enterprise-sync-device-code")))`,
		);
		assert(styled, "styles.css was not loaded");
	});

	await test("first sync pulls the remote folder into the vault", async () => {
		await remoteCommit(
			client,
			ctx,
			folder,
			{
				"Welcome.md": "# Welcome\nfrom GitHub\n",
				"Projects/Plan.md": "- [ ] ship it\n",
				// Obsidian's index skips dotfiles, so this one exercises the
				// adapter fallback rather than the Vault API.
				".github/settings.yml": "hidden: true\n",
			},
			`${tag}: seed`,
		);
		await syncViaCommand();
		assertEqual(await readLocal(vaultRoot, "Welcome.md"), "# Welcome\nfrom GitHub\n", "Welcome.md");
		assertEqual(await readLocal(vaultRoot, "Projects/Plan.md"), "- [ ] ship it\n", "Plan.md");
		assertEqual(await readLocal(vaultRoot, ".github/settings.yml"), "hidden: true\n", "hidden file");
		await indexed("Projects/Plan.md");
		const shown = (await notices()).join("\n");
		assert(/GitHub Enterprise Sync \(full\): 3 added/.test(shown), `unexpected notice: ${shown}`);
		const status = await page.eval(`${P}.statusBar?.innerText ?? ""`);
		assert(status.includes("just now"), `status bar says "${status}"`);
	});

	await test("notes created and edited in Obsidian are pushed", async () => {
		await page.eval(`app.vault.create("From Obsidian.md", "written in ${mode}\\n").then(() => true)`);
		await page.eval(
			`app.vault.process(app.vault.getFileByPath("Welcome.md"), (t) => t + "edited locally\\n").then(() => true)`,
		);
		await syncViaCommand();
		assertEqual(await readRemote(client, ctx, folder, "From Obsidian.md"), `written in ${mode}\n`, "new note");
		assertEqual(
			await readRemote(client, ctx, folder, "Welcome.md"),
			"# Welcome\nfrom GitHub\nedited locally\n",
			"edited note",
		);
		const head = await client.branchHead(ctx.owner, ctx.repo, ctx.branch);
		const res = await fetch(`https://api.github.com/repos/${ctx.owner}/${ctx.repo}/commits/${head}`, {
			headers: { Authorization: `Bearer ${accessToken}` },
		});
		const message = (await res.json()).commit.message;
		const platform = mode === "mobile" ? "mobile" : "desktop";
		assert(
			new RegExp(`From ${platform}-\\w+ via GitHub Enterprise Sync`).test(message),
			`commit message: ${message}`,
		);
	});

	await test("remote edits and local deletes round-trip", async () => {
		// With the note open, the Vault API's modify is what keeps the editor
		// showing the pulled text rather than a stale buffer.
		await page.eval(`app.workspace.getLeaf().openFile(app.vault.getFileByPath("Projects/Plan.md")).then(() => true)`);
		await remoteCommit(client, ctx, folder, { "Projects/Plan.md": "- [x] ship it\n" }, `${tag}: remote edit`);
		await page.eval(`app.vault.delete(app.vault.getFileByPath("From Obsidian.md")).then(() => true)`);
		await syncViaCommand();
		assertEqual(await readLocal(vaultRoot, "Projects/Plan.md"), "- [x] ship it\n", "pulled edit");
		await waitFor(
			() => page.eval(`app.workspace.activeEditor?.editor?.getValue() === "- [x] ship it\\n"`),
			5000,
			"the open editor to show the pulled edit",
		);
		const remote = await remoteFiles(client, ctx, folder);
		assert(!remote.includes("From Obsidian.md"), `deleted note still on remote: ${remote}`);
	});

	await test("editing both sides keeps both versions", async () => {
		await remoteCommit(client, ctx, folder, { "Welcome.md": "remote version\n" }, `${tag}: conflict`);
		await page.eval(`app.vault.process(app.vault.getFileByPath("Welcome.md"), () => "local version\\n").then(() => true)`);
		await syncViaCommand();
		assertEqual(await readLocal(vaultRoot, "Welcome.md"), "remote version\n", "canonical path");
		const files = await fs.readdir(vaultRoot);
		const copy = files.find((f) => f.startsWith("Welcome") && f !== "Welcome.md");
		assert(copy, `no conflict copy in ${files}`);
		assertEqual(await readLocal(vaultRoot, copy), "local version\n", "conflict copy");
		assert((await remoteFiles(client, ctx, folder)).includes(copy), "conflict copy not pushed");
		const shown = (await notices()).join("\n");
		assert(/changed both here and remotely/.test(shown), `no conflict notice: ${shown}`);
	});

	await test("a repo cannot write into the vault's config folder", async () => {
		const configDir = await page.eval("app.vault.configDir");
		const target = `${configDir}/plugins/${PLUGIN_ID}/local.json`;
		await remoteCommit(client, ctx, folder, { [target]: '{"accessToken":"stolen"}' }, `${tag}: hostile config`);
		await syncViaCommand();
		const local = JSON.parse(await readLocal(vaultRoot, target));
		assert(local.accessToken !== "stolen", "the plugin's local.json was overwritten from the repo");
	});

	await test("settings tab renders", async () => {
		await page.eval(`app.setting.open(), app.setting.openTabById("${PLUGIN_ID}"), true`);
		const text = await waitFor(
			() => page.eval(`app.setting.containerEl.isConnected && app.setting.activeTab?.containerEl.innerText`),
			5000,
			"settings tab",
		);
		for (const label of ["GitHub host", "OAuth app client ID", "Repository", "Automatic sync", `Signed in as ${await page.eval(`${P}.local.login`)}`]) {
			assert(text.includes(label), `settings tab is missing "${label}"`);
		}
		await shot("settings");
		await page.eval("app.setting.close(), true");
	});

	await test("settings are searchable and controls persist", async () => {
		await page.eval(`app.setting.open(), app.setting.openTabById("${PLUGIN_ID}"), true`);
		const row = (name) =>
			`[...app.setting.activeTab.containerEl.querySelectorAll(".setting-item")].find((el) => el.querySelector(".setting-item-name")?.innerText === ${JSON.stringify(name)})`;
		await waitFor(() => page.eval(`!!${row("Periodic sync")}`), 5000, "Periodic sync row");

		// Periodic sync is off, so its interval row is hidden until it's switched on.
		const intervalShown = () => page.eval(`(() => { const r = ${row("Sync interval")}; return !!r && r.offsetParent !== null; })()`);
		assertEqual(await intervalShown(), false, "interval visible while periodic sync is off");
		await page.eval(`${row("Periodic sync")}.querySelector(".checkbox-container").click(), true`);
		await waitFor(() => page.eval(`${P}.settings.autoSyncEnabled === true`), 5000, "toggle to save");
		await waitFor(intervalShown, 5000, "interval row to appear");
		const saved = JSON.parse(await fs.readFile(path.join(vaultRoot, await page.eval("app.vault.configDir"), "plugins", PLUGIN_ID, "data.json"), "utf8"));
		assertEqual(saved.autoSyncEnabled, true, "data.json autoSyncEnabled");
		assert(await page.eval(`${P}.autoSyncTimer !== null`), "periodic timer not started");
		await page.eval(`${row("Periodic sync")}.querySelector(".checkbox-container").click(), true`);
		await waitFor(() => page.eval(`${P}.settings.autoSyncEnabled === false && ${P}.autoSyncTimer === null`), 5000, "toggle off");

		// The declarative definitions are what Obsidian's settings search indexes.
		// On a phone the search box lives on the root settings page, not here.
		if (mode === "mobile") {
			await page.eval("app.setting.close(), true");
			return;
		}
		const search = `document.querySelector(".mod-settings input[type=search], .mod-settings .search-input-container input")`;
		await page.eval(`(() => { const i = ${search}; i.value = "remote folder"; i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
		await waitFor(
			() => page.eval(`[...document.querySelectorAll(".mod-settings .setting-item-name")].some((n) => n.innerText === "Remote folder" && n.offsetParent !== null)`),
			5000,
			"a search hit for Remote folder",
		);
		await shot("settings-search");
		await page.eval("app.setting.close(), true");
	});

	await test("sign-in opens the device-code modal", async () => {
		await page.eval(`app.commands.executeCommandById("${PLUGIN_ID}:sign-in")`);
		const modal = `document.querySelector(".github-enterprise-sync-device-status")?.closest(".modal")`;
		const text = await waitFor(
			async () => {
				const t = await page.eval(`${modal}?.innerText ?? ""`);
				return /[A-Z0-9]{4}-[A-Z0-9]{4}/.test(t) ? t : null;
			},
			15000,
			"a device code",
		);
		assert(text.includes("github.com/login/device"), `modal text: ${text}`);
		const styled = await page.eval(
			`getComputedStyle(document.querySelector(".github-enterprise-sync-device-code")).fontWeight`,
		);
		assertEqual(styled, "700", "device code styling");
		await shot("sign-in");
		// Closing aborts the poll, so the unused code just expires.
		await page.press("Escape");
		await waitFor(() => page.eval(`!${modal}`), 5000, "the modal to close");
	});
}

async function cleanup(client, ctx, folders) {
	const head = await client.branchHead(ctx.owner, ctx.repo, ctx.branch);
	const tree = await client.listTree(ctx.owner, ctx.repo, head);
	const doomed = tree.filter((b) => folders.some((f) => b.path.startsWith(`${f}/`)));
	if (!doomed.length) return;
	const entries = doomed.map((b) => ({ path: b.path, mode: "100644", type: "blob", sha: null }));
	await commitEntries(client, ctx, entries, `app-e2e ${RUN_ID}: cleanup`);
	console.log(`  removed ${doomed.length} remote file(s)`);
}

await main();
