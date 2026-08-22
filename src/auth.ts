import { requestUrl } from "obsidian";

/** Endpoints for github.com or a GitHub Enterprise Server install. */
export interface GitHubHost {
	/** e.g. https://github.com or https://github.mycorp.com */
	webBase: string;
	/** e.g. https://api.github.com or https://github.mycorp.com/api/v3 */
	apiBase: string;
}

export function hostFromWebBase(webBase: string): GitHubHost {
	const base = webBase.replace(/\/+$/, "");
	const isDotCom = /^https:\/\/(www\.)?github\.com$/i.test(base);
	return {
		webBase: base,
		apiBase: isDotCom ? "https://api.github.com" : `${base}/api/v3`,
	};
}

export interface DeviceCodeResponse {
	device_code: string;
	user_code: string;
	verification_uri: string;
	expires_in: number;
	interval: number;
}

export interface AccessTokenResponse {
	access_token: string;
	token_type: string;
	scope: string;
	/** Present only when the OAuth app has expiring tokens enabled. */
	expires_in?: number;
	refresh_token?: string;
	refresh_token_expires_in?: number;
}

/**
 * Exchange a refresh token for a fresh access token.
 *
 * Only relevant when the OAuth app opts into expiring tokens; then the access
 * token lasts ~8h and the refresh token ~6 months. GitHub rotates the refresh
 * token on every use, so the caller must persist both halves of the response.
 */
export async function refreshAccessToken(
	host: GitHubHost,
	clientId: string,
	refreshToken: string,
): Promise<AccessTokenResponse> {
	const res = await requestUrl({
		url: `${host.webBase}/login/oauth/access_token`,
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/json" },
		body: JSON.stringify({
			client_id: clientId,
			refresh_token: refreshToken,
			grant_type: "refresh_token",
		}),
		throw: false,
	});
	const json = res.json ?? {};
	if (!json.access_token) {
		throw new Error(
			json.error_description ?? json.error ?? `Token refresh failed (HTTP ${res.status})`,
		);
	}
	return json as AccessTokenResponse;
}

/**
 * Step 1 of the OAuth device flow: ask GitHub for a device code and the
 * short user code the person types into their own browser.
 */
export async function requestDeviceCode(
	host: GitHubHost,
	clientId: string,
	scope: string,
): Promise<DeviceCodeResponse> {
	const res = await requestUrl({
		url: `${host.webBase}/login/device/code`,
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/json" },
		body: JSON.stringify({ client_id: clientId, scope }),
		throw: false,
	});
	const json = res.json ?? {};
	if (res.status >= 400 || json.error) {
		throw new Error(
			json.error_description ?? json.error ?? `Device code request failed (HTTP ${res.status})`,
		);
	}
	return json as DeviceCodeResponse;
}

/** A single poll of the token endpoint. Returns null while still pending. */
async function pollOnce(
	host: GitHubHost,
	clientId: string,
	deviceCode: string,
): Promise<{ token?: AccessTokenResponse; slowDown?: boolean }> {
	const res = await requestUrl({
		url: `${host.webBase}/login/oauth/access_token`,
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/json" },
		body: JSON.stringify({
			client_id: clientId,
			device_code: deviceCode,
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
		}),
		throw: false,
	});
	const json = res.json ?? {};
	if (json.access_token) return { token: json as AccessTokenResponse };

	switch (json.error) {
		case "authorization_pending":
			return {};
		case "slow_down":
			return { slowDown: true };
		case "expired_token":
			throw new Error("The device code expired. Start sign-in again.");
		case "access_denied":
			throw new Error("Authorization was denied in the browser.");
		default:
			throw new Error(
				json.error_description ?? json.error ?? `Token request failed (HTTP ${res.status})`,
			);
	}
}

/**
 * Step 2: poll until the user finishes in their browser.
 * `signal` lets the modal cancel the wait.
 */
export async function pollForToken(
	host: GitHubHost,
	clientId: string,
	device: DeviceCodeResponse,
	signal: AbortSignal,
): Promise<AccessTokenResponse> {
	let intervalMs = Math.max(device.interval, 5) * 1000;
	const deadline = Date.now() + device.expires_in * 1000;

	while (Date.now() < deadline) {
		await sleep(intervalMs, signal);
		if (signal.aborted) throw new Error("Sign-in cancelled.");
		const { token, slowDown } = await pollOnce(host, clientId, device.device_code);
		if (token) return token;
		if (slowDown) intervalMs += 5000;
	}
	throw new Error("The device code expired. Start sign-in again.");
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = window.setTimeout(resolve, ms);
		signal.addEventListener("abort", () => {
			window.clearTimeout(timer);
			resolve();
		});
	});
}
