// The same rules Obsidian's community-plugin review runs.
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
	{
		ignores: ["node_modules/", "main.js", ".test-build/"],
	},
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: {
					allowDefaultProject: ["eslint.config.mjs", "esbuild.config.mjs", "tests/run.mjs"],
				},
			},
		},
	},
	{
		// The kit is shared with Tabletop and checked under strict (tsconfig.kit.json),
		// where its non-null assertions are needed: lint it with the same settings.
		files: ["kit/**/*.ts"],
		languageOptions: {
			parserOptions: {
				projectService: false,
				project: "./tsconfig.kit.json",
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
	{
		// The tests run under Node's test runner, never in Obsidian: node: modules are
		// what they import, test() returns a promise the runner awaits, and the
		// fixtures spell out vault paths on purpose.
		files: ["tests/**"],
		rules: {
			"obsidianmd/no-nodejs-modules": "off",
			"obsidianmd/hardcoded-config-path": "off",
			"@typescript-eslint/no-floating-promises": "off",
		},
	},
]);
