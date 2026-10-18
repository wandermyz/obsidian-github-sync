import esbuild from "esbuild";
import { builtinModules } from "node:module";
import process from "process";

// Node's own list, rather than the builtin-modules package. The plugin runs on
// mobile and imports none of these; marking them external just keeps esbuild
// from trying to bundle one if a dependency ever reaches for it.
const builtins = builtinModules.flatMap((m) => [m, `node:${m}`]);

const prod = process.argv[2] === "production";

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", ...builtins],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
