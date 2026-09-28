/**
 * Network-free unit checks for the pure helpers.
 * Run: node --experimental-strip-types test.ts   (or: bun test.ts)
 */
import assert from "node:assert/strict";
import { deriveApiBase, pickAutoModel } from "./src/helpers.ts";

// deriveApiBase: proxy-ep -> api host, Business + Individual + fallback
assert.equal(
	deriveApiBase(
		"tid=x;exp=1;proxy-ep=proxy.business.githubcopilot.com;other=y",
	),
	"https://api.business.githubcopilot.com",
);
assert.equal(
	deriveApiBase("proxy-ep=proxy.individual.githubcopilot.com"),
	"https://api.individual.githubcopilot.com",
);
assert.equal(
	deriveApiBase("no-proxy-here"),
	"https://api.individual.githubcopilot.com",
);

// pickAutoModel: preserves GitHub's pool order across supported API families.
const known = new Set([
	"claude-sonnet-4.6",
	"gpt-5.4",
	"gpt-5.3-codex",
	"gpt-5-mini",
]);
assert.equal(
	pickAutoModel(["claude-sonnet-4.6", "gpt-5.4", "gpt-5-mini"], known),
	"claude-sonnet-4.6",
);
assert.equal(pickAutoModel(["gpt-5-mini", "gpt-5.4"], known), "gpt-5-mini");
// no known supported model in the pool -> undefined (caller raises a clear error)
assert.equal(pickAutoModel(["gemini-3.5-flash", "kimi-k3"], known), undefined);
assert.equal(pickAutoModel([], known), undefined);

console.log("ok: all copilot-auto helper checks passed");
