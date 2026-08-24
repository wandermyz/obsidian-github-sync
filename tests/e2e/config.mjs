/**
 * Config and credentials for the e2e tests.
 *
 * Both live outside git: `.env.e2e` names a real repository the tests push to,
 * and `.e2e-token.json` is a live OAuth token. The token is cached so the
 * device flow — which needs a human at a browser — runs once rather than on
 * every test run.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { repoRoot } from "./load-engine.mjs";

const ENV_FILE = path.join(repoRoot, ".env.e2e");
const TOKEN_FILE = path.join(repoRoot, ".e2e-token.json");

/** Renew this long before expiry, so a run can't die mid-push. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export async function loadConfig() {
	let raw;
	try {
		raw = await fs.readFile(ENV_FILE, "utf8");
	} catch {
		throw new Error(
			`Missing ${path.basename(ENV_FILE)}. Copy .env.e2e.example to .env.e2e and fill it in.`,
		);
	}

	const env = {};
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq === -1) continue;
		env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
	}

	const required = ["E2E_REPO", "E2E_CLIENT_ID"];
	const missing = required.filter((k) => !env[k]);
	if (missing.length) throw new Error(`${path.basename(ENV_FILE)} is missing: ${missing.join(", ")}`);

	const [owner, repo] = env.E2E_REPO.split("/");
	if (!owner || !repo) throw new Error(`E2E_REPO must be "owner/repo", got "${env.E2E_REPO}"`);

	return {
		owner,
		repo,
		branch: env.E2E_BRANCH || "",
		clientId: env.E2E_CLIENT_ID,
		webBase: env.E2E_GITHUB_WEB_BASE || "https://github.com",
		scope: env.E2E_SCOPE || "repo read:org",
	};
}

async function readCachedToken() {
	try {
		return JSON.parse(await fs.readFile(TOKEN_FILE, "utf8"));
	} catch {
		return null;
	}
}

async function writeCachedToken(cached) {
	await fs.writeFile(TOKEN_FILE, JSON.stringify(cached, null, 2), { mode: 0o600 });
}

/**
 * Turn a token response into the cached shape.
 *
 * GitHub only sends `expires_in` when the OAuth app has expiring tokens
 * enabled; a 0 here means "never expires", matching what the plugin stores.
 */
function toCached(response, clientId, webBase) {
	const now = Date.now();
	return {
		clientId,
		webBase,
		accessToken: response.access_token,
		accessTokenExpiresAt: response.expires_in ? now + response.expires_in * 1000 : 0,
		refreshToken: response.refresh_token ?? "",
		refreshTokenExpiresAt: response.refresh_token_expires_in
			? now + response.refresh_token_expires_in * 1000
			: 0,
	};
}

/**
 * A usable access token, doing as little as possible to get one:
 * cached → refreshed → device flow.
 *
 * The cache is keyed by client ID and host, so pointing the tests at a
 * different OAuth app or a different GitHub doesn't silently reuse a token that
 * can't work there.
 */
export async function getAccessToken(config, engine, { interactive = true } = {}) {
	const host = engine.hostFromWebBase(config.webBase);
	const cached = await readCachedToken();
	const matches = cached && cached.clientId === config.clientId && cached.webBase === config.webBase;

	if (matches) {
		const fresh =
			!cached.accessTokenExpiresAt || cached.accessTokenExpiresAt - REFRESH_MARGIN_MS > Date.now();
		if (fresh && cached.accessToken) return cached.accessToken;

		if (cached.refreshToken) {
			try {
				const refreshed = await engine.refreshAccessToken(host, config.clientId, cached.refreshToken);
				// GitHub rotates the refresh token on use; persist both halves.
				await writeCachedToken(toCached(refreshed, config.clientId, config.webBase));
				console.log("  cached token refreshed");
				return refreshed.access_token;
			} catch (err) {
				console.warn(`  token refresh failed (${err.message}); falling back to device flow`);
			}
		}
	}

	if (!interactive) {
		throw new Error(
			"No usable cached token. Run `npm run test:e2e:login` once in a terminal — " +
				"the device flow needs a browser, and the test run itself must stay non-interactive.",
		);
	}

	const response = await runDeviceFlow(config, host);
	await writeCachedToken(toCached(response, config.clientId, config.webBase));
	console.log(`  token cached in ${path.basename(TOKEN_FILE)}`);
	return response.access_token;
}

/**
 * The interactive part. Deliberately not using src/auth.ts's pollForToken: that
 * one depends on `window.setTimeout` and an AbortSignal from the modal.
 */
async function runDeviceFlow(config, host) {
	const post = async (url, body) => {
		const res = await fetch(url, {
			method: "POST",
			headers: { Accept: "application/json", "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		return res.json();
	};

	const device = await post(`${host.webBase}/login/device/code`, {
		client_id: config.clientId,
		scope: config.scope,
	});
	if (device.error) throw new Error(device.error_description ?? device.error);

	console.log(`\n  No usable cached token — sign in once.`);
	console.log(`  Open: ${device.verification_uri}`);
	console.log(`  Code: ${device.user_code}\n`);

	let interval = Math.max(device.interval ?? 5, 5) * 1000;
	const deadline = Date.now() + (device.expires_in ?? 900) * 1000;

	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, interval));
		const json = await post(`${host.webBase}/login/oauth/access_token`, {
			client_id: config.clientId,
			device_code: device.device_code,
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
		});
		if (json.access_token) {
			process.stdout.write("\n");
			return json;
		}
		if (json.error === "slow_down") interval += 5000;
		else if (json.error !== "authorization_pending")
			throw new Error(json.error_description ?? json.error);
		process.stdout.write(".");
	}
	throw new Error("Device code expired before authorization.");
}
