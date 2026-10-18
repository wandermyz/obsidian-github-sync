/**
 * Screenshots for the README / community directory listing.
 *
 *   npm run screenshots
 *
 * Commits a small demo vault to `notes/` in the e2e repo, syncs it into a
 * fresh Obsidian vault through the real plugin, captures desktop and phone
 * views, then removes the demo folder again. Output: docs/screenshots/.
 *
 * Quits and relaunches Obsidian, like `npm run test:app`.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadEngine, repoRoot } from "../e2e/load-engine.mjs";
import { getAccessToken, loadConfig } from "../e2e/config.mjs";
import { PLUGIN_ID, createVault, emulatePhone, enablePlugin, launch, restore, waitFor } from "./obsidian.mjs";

const RUN_ID = randomUUID().slice(0, 8);
const FOLDER = "notes";
const VAULT = path.join(repoRoot, ".e2e-tmp", `shots-${RUN_ID}`, "Team Notes");
const OUT = path.join(repoRoot, "docs", "screenshots");
const P = `app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}]`;
const DESKTOP = { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false };
const OPEN_NOTE = "Projects/Mobile access.md";

const DEMO = {
	"Projects/Mobile access.md": `---
status: in progress
owner: platform-team
---

Notes live in our GitHub Enterprise repository, so they stay inside the company
network policy — and now they're readable on the phone too.

## Why the REST API

- No Git binary on iOS, and no \`isomorphic-git\` cloning a whole history.
- Each sync asks GitHub for the diff since the last commit, then downloads only
  the files that changed.
- Sign-in uses the **OAuth device flow** in the system browser, so the existing
  enterprise SSO session just works.

## Rollout

- [x] Pilot with the platform team
- [x] Conflict copies instead of silent overwrites
- [ ] Roll out to the docs guild
`,
	"Projects/Q4 roadmap.md": "# Q4 roadmap\n\n1. Mobile access\n2. Search over meeting notes\n3. Archive old projects\n",
	"Meetings/2026-10-14 Planning.md":
		"# Planning — 2026-10-14\n\n- Agreed to pilot [[Mobile access]] with two teams.\n- Next review in two weeks.\n",
	"Meetings/2026-10-16 Retro.md": "# Retro — 2026-10-16\n\n**Went well:** sync on the train works.\n",
	"Handbook/Onboarding.md": "# Onboarding\n\nClone nothing. Install Obsidian, enable GitHub Enterprise Sync, sign in.\n",
	"Handbook/Writing style.md": "# Writing style\n\nShort sentences. Sentence case headings.\n",
	"README.md": "# Team notes\n\nShared notes, synced with GitHub Enterprise.\n",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function commitFolder(client, ctx, files, message) {
	const head = await client.branchHead(ctx.owner, ctx.repo, ctx.branch);
	const entries = [];
	for (const [relative, content] of Object.entries(files)) {
		const sha = content === null ? null : await client.createBlob(ctx.owner, ctx.repo, Buffer.from(content, "utf8"));
		entries.push({ path: `${FOLDER}/${relative}`, mode: "100644", type: "blob", sha });
	}
	const tree = await client.createTree(ctx.owner, ctx.repo, head, entries);
	const commit = await client.createCommit(ctx.owner, ctx.repo, message, tree, [head]);
	await client.updateRef(ctx.owner, ctx.repo, ctx.branch, commit);
	await waitFor(async () => (await client.branchHead(ctx.owner, ctx.repo, ctx.branch)) === commit, 15000, "new head");
}

async function main() {
	const config = await loadConfig();
	const engine = await loadEngine();
	const accessToken = await getAccessToken(config, engine, { interactive: false });
	const client = new engine.GitHubClient(engine.hostFromWebBase(config.webBase), accessToken);
	const branch = config.branch || (await client.defaultBranch(config.owner, config.repo));
	const ctx = { owner: config.owner, repo: config.repo, branch };
	const { login } = await client.currentUser();
	const cached = process.env.E2E_TOKEN
		? {}
		: JSON.parse(await fs.readFile(path.join(repoRoot, ".e2e-token.json"), "utf8"));

	await commitFolder(client, ctx, DEMO, "Add demo notes for screenshots");
	try {
		for (const mode of ["desktop", "mobile"]) {
			await fs.rm(VAULT, { recursive: true, force: true });
			await createVault(VAULT, {
				repoRoot,
				settings: {
					clientId: config.clientId,
					githubWebBase: config.webBase,
					scope: config.scope,
					syncRepo: `${ctx.owner}/${ctx.repo}`,
					branch,
					remoteFolder: FOLDER,
					targetFolder: "",
					// Off so nothing races the sync below; switched on before the
					// settings screenshot, which should show a typical setup.
					syncOnStartup: false,
					autoSyncEnabled: true,
					autoSyncMinutes: 15,
				},
				local: {
					accessToken,
					login,
					accessTokenExpiresAt: cached.accessTokenExpiresAt ?? 0,
					// Never used — the access token outlives the run — but without
					// one the settings tab reads "no refresh token", which isn't
					// what a normally signed-in user sees.
					refreshToken: "placeholder",
					refreshTokenExpiresAt: Date.now() + 180 * 24 * 3600 * 1000,
					syncState: null,
					deviceLabel: "",
				},
			});
			const page = await launch(VAULT);
			if (mode === "mobile") await emulatePhone(page);
			else await page.setViewport(DESKTOP);
			await enablePlugin(page);
			await capture(page, mode, { ctx, login, clientId: config.clientId });
		}
	} finally {
		await restore().catch((err) => console.log(`could not restore Obsidian: ${err.message}`));
		await commitFolder(
			client,
			ctx,
			Object.fromEntries(Object.keys(DEMO).map((k) => [k, null])),
			"Remove demo notes",
		).catch((err) => console.log(`cleanup failed: ${err.message}`));
		await fs.rm(path.dirname(VAULT), { recursive: true, force: true });
	}
	console.log(`Screenshots in ${path.relative(repoRoot, OUT)}/`);
}

/**
 * Swap identifying values for stand-ins in what's on screen — the OAuth app's
 * client ID, the signed-in login, and the repo (which names the account).
 * Only the rendered text and input values change; nothing reaches the plugin's
 * settings, since setting `.value` directly fires no change event.
 */
async function redact(page, ctx, login, clientId) {
	const swaps = [
		[clientId, `${clientId.slice(0, 6)}${"•".repeat(Math.max(0, clientId.length - 6))}`],
		[`${ctx.owner}/${ctx.repo}`, "acme-corp/team-notes"],
		[login, "octocat"],
	];
	await page.eval(`(() => {
		const swaps = ${JSON.stringify(swaps)};
		const swap = (text) => swaps.reduce((t, [from, to]) => t.split(from).join(to), text);
		const root = app.setting.containerEl;
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		for (let n = walker.nextNode(); n; n = walker.nextNode()) n.nodeValue = swap(n.nodeValue);
		for (const input of root.querySelectorAll("input")) input.value = swap(input.value);
		return true;
	})()`);
}

async function capture(page, mode, ids) {
	const shot = async (name, settle = 600) => {
		await sleep(settle); // let transitions settle
		await page.screenshot(path.join(OUT, `${mode}-${name}.png`));
		console.log(`  ${mode}-${name}.png`);
	};
	const clearNotices = () => page.eval(`document.querySelectorAll(".notice").forEach((n) => n.remove()), true`);

	// An "auto" run reports only when something changed, which is the notice
	// worth showing: what a background sync looks like.
	await page.eval(`${P}.sync("auto").then(() => true)`, 120000);
	await waitFor(() => page.eval(`!!app.vault.getFileByPath(${JSON.stringify(OPEN_NOTE)})`), 10000, "demo indexed");
	await page.eval(`app.workspace.getLeaf().openFile(app.vault.getFileByPath(${JSON.stringify(OPEN_NOTE)})).then(() => true)`);
	await waitFor(
		() => page.eval(`[...document.querySelectorAll(".notice")].some((n) => n.innerText.includes("added"))`),
		2000,
		"the sync notice",
	);

	if (mode === "desktop") {
		await page.eval(`(() => {
			const explorer = app.workspace.getLeavesOfType("file-explorer")[0]?.view;
			for (const folder of ["Projects", "Meetings"]) explorer?.fileItems[folder]?.setCollapsed(false);
			return true;
		})()`);
		await shot("sync", 300);
	} else {
		await shot("note", 300);
		await clearNotices();
		await page.eval(`app.workspace.leftSplit.expand(), true`);
		await page.eval(`(() => {
			const explorer = app.workspace.getLeavesOfType("file-explorer")[0]?.view;
			for (const folder of ["Projects", "Meetings"]) explorer?.fileItems[folder]?.setCollapsed(false);
			return true;
		})()`);
		await shot("files");
		await page.eval(`app.workspace.leftSplit.collapse(), true`);
	}
	await clearNotices();

	await page.eval(`${P}.settings.syncOnStartup = true`);
	await page.eval(`app.setting.open(), app.setting.openTabById("${PLUGIN_ID}"), true`);
	await waitFor(
		() => page.eval(`app.setting.containerEl.isConnected && app.setting.activeTab?.id === "${PLUGIN_ID}"`),
		5000,
		"settings tab",
	);
	await redact(page, ids.ctx, ids.login, ids.clientId);
	await shot("settings");
	await page.eval("app.setting.close(), true");

	await page.eval(`app.commands.executeCommandById("${PLUGIN_ID}:sign-in")`);
	await waitFor(
		() => page.eval(`/[A-Z0-9]{4}-[A-Z0-9]{4}/.test(document.querySelector(".github-enterprise-sync-device-code")?.innerText ?? "")`),
		15000,
		"device code",
	);
	await shot("sign-in");
	await page.press("Escape");
}

await main();
