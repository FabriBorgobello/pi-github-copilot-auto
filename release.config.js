/**
 * semantic-release: runs in CI on every push to main.
 *
 * Version line is deliberately pinned to 0.x: the `breaking: true -> minor`
 * rule below overrides semantic-release's default of promoting a breaking
 * change to 1.0.0, so breaking changes land as 0.2.0, 0.3.0, ... instead.
 * When the public API is stable and you want to ship 1.0.0, delete that one
 * rule and push a commit with a `BREAKING CHANGE:` footer.
 */
export default {
	branches: ["main"],
	plugins: [
		[
			"@semantic-release/commit-analyzer",
			{
				// Evaluated before the built-in rules; defaults still apply as
				// fallback (feat -> minor, fix/perf -> patch, docs/chore -> none).
				releaseRules: [{ breaking: true, release: "minor" }],
			},
		],
		"@semantic-release/release-notes-generator",
		"@semantic-release/changelog",
		"@semantic-release/npm",
		[
			"@semantic-release/git",
			{
				// Only these two; the plugin default also lists npm lockfiles,
				// which this repo does not use. The default commit message
				// ("chore(release): <version> [skip ci]") is kept as-is.
				assets: ["CHANGELOG.md", "package.json"],
			},
		],
		"@semantic-release/github",
	],
};
