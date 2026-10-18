// Obsidian's own lint rules — the same checks the community directory's
// automated review runs — applied to the plugin source.
import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";

export default tseslint.config(
	{ ignores: ["main.js", "node_modules/", "tests/", "scripts/", "*.mjs"] },
	...obsidianmd.configs.recommended,
	{
		files: ["src/**/*.ts"],
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: { project: "./tsconfig.json", tsconfigRootDir: import.meta.dirname },
		},
	},
);
