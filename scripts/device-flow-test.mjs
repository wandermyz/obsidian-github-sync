#!/usr/bin/env node
/**
 * Standalone device-flow check — no Obsidian required.
 *
 *   node scripts/device-flow-test.mjs <client_id> [owner/repo] [https://github.com]
 *
 * Prints the user code, waits for you to authorize in a browser, then lists
 * the repo root and reads the first file. Same request sequence the plugin uses.
 */
const [clientId, testRepo, hostArg] = process.argv.slice(2);
if (!clientId) {
	console.error("usage: node scripts/device-flow-test.mjs <client_id> [owner/repo] [host]");
	process.exit(1);
}

const webBase = (hostArg ?? "https://github.com").replace(/\/+$/, "");
const apiBase = /^https:\/\/(www\.)?github\.com$/i.test(webBase)
	? "https://api.github.com"
	: `${webBase}/api/v3`;
const SCOPE = "repo read:org";

const postJson = async (url, body) => {
	const res = await fetch(url, {
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return res.json();
};

const device = await postJson(`${webBase}/login/device/code`, {
	client_id: clientId,
	scope: SCOPE,
});
if (device.error) throw new Error(device.error_description ?? device.error);

console.log(`\n  Open: ${device.verification_uri}`);
console.log(`  Code: ${device.user_code}\n`);

let interval = Math.max(device.interval ?? 5, 5) * 1000;
const deadline = Date.now() + (device.expires_in ?? 900) * 1000;
let token;

while (Date.now() < deadline) {
	await new Promise((r) => setTimeout(r, interval));
	const json = await postJson(`${webBase}/login/oauth/access_token`, {
		client_id: clientId,
		device_code: device.device_code,
		grant_type: "urn:ietf:params:oauth:grant-type:device_code",
	});
	if (json.access_token) {
		token = json.access_token;
		break;
	}
	if (json.error === "slow_down") interval += 5000;
	else if (json.error !== "authorization_pending")
		throw new Error(json.error_description ?? json.error);
	process.stdout.write(".");
}
if (!token) throw new Error("device code expired");

const api = async (path, accept = "application/vnd.github+json") => {
	const res = await fetch(`${apiBase}${path}`, {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: accept,
			"X-GitHub-Api-Version": "2022-11-28",
		},
	});
	if (!res.ok) throw new Error(`GitHub ${res.status} on ${path}: ${await res.text()}`);
	return accept.includes("raw") ? res.text() : res.json();
};

const user = await api("/user");
console.log(`\n\nAuthenticated as ${user.login}`);
console.log(`Granted scopes: ${SCOPE}`);

if (!testRepo) {
	console.log("No owner/repo given — skipping file read.");
	process.exit(0);
}

const [owner, repo] = testRepo.split("/");
const entries = await api(`/repos/${owner}/${repo}/contents`);
console.log(`\n${testRepo} root — ${entries.length} entries:`);
for (const e of entries.slice(0, 20)) console.log(`  ${e.type === "dir" ? "/" : " "} ${e.name}`);

const first = entries.find((e) => e.type === "file");
if (first) {
	const content = await api(
		`/repos/${owner}/${repo}/contents/${encodeURI(first.path)}`,
		"application/vnd.github.raw+json",
	);
	console.log(`\nRead ${first.path} (${content.length} chars):`);
	console.log(content.slice(0, 400));
}
console.log("\nDevice flow + repo read: OK");
