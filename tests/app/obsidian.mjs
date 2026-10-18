/**
 * Drive the real Obsidian desktop app over the Chrome DevTools Protocol.
 *
 * Playwright's connectOverCDP hangs on Obsidian's windows, and all the tests
 * need is "evaluate this in the app" and "take a screenshot", so this speaks
 * the protocol directly over Node's built-in WebSocket.
 *
 * Obsidian is single-instance and opening a second vault from a running one
 * leaves a window that never answers the debugger. So instead of opening the
 * test vault alongside the user's, `launch()` quits Obsidian, marks only the
 * test vault as open in obsidian.json, and starts it with a debugging port.
 * `restore()` puts obsidian.json back and relaunches Obsidian normally.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const PORT = 9222;
const CONFIG = path.join(os.homedir(), "Library/Application Support/obsidian/obsidian.json");
export const PLUGIN_ID = "github-enterprise-sync";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function obsidianRunning() {
	try {
		await run("pgrep", ["-x", "Obsidian"]);
		return true;
	} catch {
		return false;
	}
}

async function quitObsidian() {
	if (!(await obsidianRunning())) return;
	await run("osascript", ["-e", 'quit app "Obsidian"']).catch(() => {});
	for (let i = 0; i < 20 && (await obsidianRunning()); i++) await sleep(250);
	// A window stuck mid-load can veto a polite quit.
	if (await obsidianRunning()) await run("pkill", ["-9", "-x", "Obsidian"]).catch(() => {});
	for (let i = 0; i < 20 && (await obsidianRunning()); i++) await sleep(250);
}

/** obsidian.json as found before the first launch; "" when there was none (fresh install). */
let savedConfig = null;
/** The page from the last launch, so restore() can undo mobile emulation. */
let current = null;

/** Quit Obsidian and relaunch it with only `vaultPath` open and a debug port. */
export async function launch(vaultPath) {
	await quitObsidian();
	const raw = await fs.readFile(CONFIG, "utf8").catch(() => "");
	savedConfig ??= raw;

	const config = raw ? JSON.parse(raw) : { vaults: {} };
	config.vaults ??= {};
	await fs.mkdir(path.dirname(CONFIG), { recursive: true });
	for (const vault of Object.values(config.vaults)) vault.open = false;
	let id = Object.keys(config.vaults).find((k) => config.vaults[k].path === vaultPath);
	id ??= randomBytes(8).toString("hex");
	config.vaults[id] = { path: vaultPath, ts: Date.now(), open: true };
	await fs.writeFile(CONFIG, JSON.stringify(config));

	await run("open", ["-a", "Obsidian", "--args", `--remote-debugging-port=${PORT}`]);
	const page = await waitFor(async () => {
		const list = await (await fetch(`http://localhost:${PORT}/json/list`)).json();
		const target = list.find((t) => t.type === "page");
		if (!target) return null;
		const page = await Page.connect(target.webSocketDebuggerUrl);
		const base = await page.eval("window.app?.vault?.adapter?.basePath ?? null").catch(() => null);
		if (base === vaultPath) return page;
		page.close();
		return null;
	}, process.env.CI ? 120000 : 30000, "Obsidian to open the test vault");
	// Let the workspace finish laying out before anything pokes at it.
	await page.eval("new Promise((r) => app.workspace.onLayoutReady(r))");
	// Obsidian 1.14 opens settings in a pop-out window on desktop. Keep it in
	// the main one, where this connection and screenshots can see it.
	await page.eval("app.setting.shouldUsePopout = () => false, true");
	// A previous run may have left mobile emulation switched on.
	if (await page.eval("app.isMobile")) {
		await page.eval("app.emulateMobile(false)");
		await waitFor(() => page.eval("!app.isMobile"), 10000, "mobile emulation to turn off");
	}
	current = page;
	return page;
}

/**
 * Put the user's Obsidian back the way it was. The test vault is dropped from
 * the vault list entirely, since its folder is about to be deleted.
 */
export async function restore() {
	// Mobile emulation is saved in localStorage, which every vault shares —
	// left on, the user's own vault would reopen in the phone layout.
	if (current) {
		await current.eval("app.emulateMobile(false)", 5000).catch(() => {});
		await current.eval('localStorage.removeItem("EmulateMobile")', 5000).catch(() => {});
		current.close();
		current = null;
	}
	await quitObsidian();
	if (savedConfig !== null) {
		if (savedConfig) await fs.writeFile(CONFIG, savedConfig);
		else await fs.rm(CONFIG, { force: true });
		savedConfig = null;
	}
	// On a CI runner there's nobody to give Obsidian back to.
	if (!process.env.CI) await run("open", ["-a", "Obsidian"]);
}

export async function waitFor(fn, timeoutMs, what) {
	const deadline = Date.now() + timeoutMs;
	let lastErr;
	while (Date.now() < deadline) {
		try {
			const value = await fn();
			if (value) return value;
		} catch (err) {
			lastErr = err;
		}
		await sleep(250);
	}
	throw new Error(`Timed out waiting for ${what}${lastErr ? ` (${lastErr.message})` : ""}`);
}

/** One DevTools connection to one Obsidian window. */
export class Page {
	static async connect(url) {
		const ws = new WebSocket(url);
		await new Promise((resolve, reject) => {
			ws.onopen = resolve;
			ws.onerror = () => reject(new Error(`Could not connect to ${url}`));
		});
		return new Page(ws);
	}

	constructor(ws) {
		this.ws = ws;
		this.nextId = 1;
		this.pending = new Map();
		ws.onmessage = (event) => {
			const msg = JSON.parse(event.data);
			const waiter = this.pending.get(msg.id);
			if (!waiter) return;
			this.pending.delete(msg.id);
			if (msg.error) waiter.reject(new Error(msg.error.message));
			else waiter.resolve(msg.result);
		};
	}

	send(method, params = {}, timeoutMs = 60000) {
		const id = this.nextId++;
		this.ws.send(JSON.stringify({ id, method, params }));
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${method} timed out`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (v) => (clearTimeout(timer), resolve(v)),
				reject: (e) => (clearTimeout(timer), reject(e)),
			});
		});
	}

	/** Evaluate an expression in the app; promises are awaited, results returned by value. */
	async eval(expression, timeoutMs) {
		const res = await this.send(
			"Runtime.evaluate",
			{ expression, awaitPromise: true, returnByValue: true },
			timeoutMs,
		);
		if (res.exceptionDetails) {
			const detail = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text;
			throw new Error(`In Obsidian: ${detail}`);
		}
		return res.result.value;
	}

	/** Emulate a viewport, e.g. a phone. `null` clears the override. */
	async setViewport(metrics) {
		if (metrics === null) return this.send("Emulation.clearDeviceMetricsOverride");
		return this.send("Emulation.setDeviceMetricsOverride", metrics);
	}

	/** A real key press, routed through Obsidian's own keymap. */
	async press(key, code = key) {
		for (const type of ["keyDown", "keyUp"]) {
			await this.send("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: key === "Escape" ? 27 : 0 });
		}
	}

	async screenshot(file) {
		const { data } = await this.send("Page.captureScreenshot", { format: "png" });
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, Buffer.from(data, "base64"));
	}

	close() {
		this.ws.close();
	}
}

/**
 * Lay down a vault with the freshly built plugin installed and configured.
 * The plugin isn't enabled here — Obsidian would show its restricted-mode
 * prompt — but by `enablePlugin()` once the app is up.
 */
export async function createVault(root, { repoRoot, settings, local }) {
	const pluginDir = path.join(root, ".obsidian", "plugins", PLUGIN_ID);
	await fs.mkdir(pluginDir, { recursive: true });
	for (const file of ["main.js", "manifest.json", "styles.css"]) {
		await fs.copyFile(path.join(repoRoot, file), path.join(pluginDir, file));
	}
	await fs.writeFile(path.join(pluginDir, "data.json"), JSON.stringify(settings, null, 2));
	await fs.writeFile(path.join(pluginDir, "local.json"), JSON.stringify(local, null, 2));
}

/**
 * A vault opened for the first time with a plugins folder gets Obsidian's
 * "Do you trust the author of this vault?" prompt, a moment after load. Answer
 * it the way the user would, so it doesn't sit over everything that follows.
 */
async function acceptTrustPrompt(page) {
	const button = `[...document.querySelectorAll(".modal button")].find((b) => b.innerText.startsWith("Trust author"))`;
	const appeared = await waitFor(() => page.eval(`!!${button}`), 5000, "trust prompt").catch(() => false);
	if (!appeared) return;
	await page.eval(`${button}.click(), true`);
	// Trusting jumps to the community plugins page. Close it, or notices and
	// modals land in that window instead of the main one.
	await sleep(500);
	await page.eval("app.setting.close(), true");
}

/** Leave restricted mode and turn the plugin on, as a user would in settings. */
export async function enablePlugin(page) {
	await acceptTrustPrompt(page);
	await page.eval(`(async () => {
		await app.plugins.setEnable(true);
		await app.plugins.loadManifests();
		await app.plugins.enablePluginAndSave(${JSON.stringify(PLUGIN_ID)});
	})()`);
	await waitFor(
		() => page.eval(`!!app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}]?._loaded`),
		10000,
		"the plugin to load",
	);
}

/** Phone-sized viewport, so emulated mobile renders the phone layout, not the tablet one. */
export const PHONE = { width: 390, height: 844, deviceScaleFactor: 3, mobile: true };

/** Switch the app into mobile emulation. Call before enabling the plugin. */
export async function emulatePhone(page) {
	await page.setViewport(PHONE);
	await page.eval("app.emulateMobile(true)");
	await waitFor(() => page.eval("document.body.classList.contains('is-phone')"), 10000, "phone layout");
}
