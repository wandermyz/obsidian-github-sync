#!/usr/bin/env node
/**
 * Copy the built plugin into the local test vault.
 *
 *   node scripts/deploy-dev.mjs [vault-path]
 *
 * Defaults to ./plugins-dev-vault, the gitignored vault in this repo.
 * Obsidian reloads a plugin when you toggle it off/on, or via the
 * "Reload app without saving" command.
 */
import { copyFile, mkdir, access } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vault = path.resolve(process.argv[2] ?? path.join(repoRoot, "plugins-dev-vault"));
const pluginId = JSON.parse(
	await (await import("fs/promises")).readFile(path.join(repoRoot, "manifest.json"), "utf8"),
).id;

const target = path.join(vault, ".obsidian", "plugins", pluginId);
await mkdir(target, { recursive: true });

for (const file of ["main.js", "manifest.json"]) {
	const src = path.join(repoRoot, file);
	try {
		await access(src);
	} catch {
		console.error(`Missing ${file} — run "npm run build" first.`);
		process.exit(1);
	}
	await copyFile(src, path.join(target, file));
	console.log(`  ${file} -> ${path.join(target, file)}`);
}

console.log(`\nDeployed ${pluginId} to ${vault}`);
