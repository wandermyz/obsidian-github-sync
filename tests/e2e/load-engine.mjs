/**
 * Bundle the plugin's engine modules for Node, with `obsidian` aliased to the
 * shim next door.
 *
 * The alternative — a TypeScript loader — would run the same code but with
 * different module resolution than the real build. Going through esbuild means
 * the e2e tests exercise what actually ships.
 */
import esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");

const shimPlugin = {
	name: "obsidian-shim",
	setup(build) {
		build.onResolve({ filter: /^obsidian$/ }, () => ({
			path: path.join(here, "obsidian-shim.mjs"),
		}));
	},
};

/** Bundles src/ into one ESM file and imports it. Returns the module. */
export async function loadEngine() {
	const outfile = path.join(here, ".build", "engine.mjs");

	await esbuild.build({
		stdin: {
			contents: `
				export * from "../../src/sync";
				export * from "../../src/github";
				export * from "../../src/auth";
				export * from "../../src/gitHash";
			`,
			resolveDir: here,
			loader: "ts",
		},
		bundle: true,
		format: "esm",
		platform: "node",
		target: "node18",
		outfile,
		plugins: [shimPlugin],
		logLevel: "warning",
		absWorkingDir: root,
	});

	// Cache-bust so a rebuild within one process isn't ignored.
	return import(`${new URL(`file://${outfile.replace(/\\/g, "/")}`).href}?t=${Date.now()}`);
}

export { here as e2eDir, root as repoRoot };
