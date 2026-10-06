/**
 * Pure helpers — no network, no filesystem, no env.
 *
 * Docs checklist coverage (docs/custom-provider.md): endpoint resolution and
 * the redaction rule "never write ... complete provider responses to ordinary
 * logs".
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	deriveApiBase,
	normalizeEnterpriseDomain,
	pickAutoModel,
	redactResponseBody,
	tokenExchangeUrl,
} from "../src/helpers.ts";

describe("deriveApiBase", () => {
	test("rewrites the proxy endpoint from a Business token", () => {
		assert.equal(
			deriveApiBase(
				"tid=x;exp=1;proxy-ep=proxy.business.githubcopilot.com;other=y",
			),
			"https://api.business.githubcopilot.com",
		);
	});

	test("rewrites the proxy endpoint from an Individual token", () => {
		assert.equal(
			deriveApiBase("proxy-ep=proxy.individual.githubcopilot.com"),
			"https://api.individual.githubcopilot.com",
		);
	});

	test("falls back to the individual host when the token carries no proxy-ep", () => {
		assert.equal(
			deriveApiBase("no-proxy-here"),
			"https://api.individual.githubcopilot.com",
		);
	});

	test("keeps a host that is not proxy-prefixed", () => {
		assert.equal(
			deriveApiBase("proxy-ep=enterprise.githubcopilot.com"),
			"https://enterprise.githubcopilot.com",
		);
	});
});

describe("GitHub Enterprise endpoints", () => {
	test("normalises a stored enterprise URL or bare domain to a hostname", () => {
		assert.equal(
			normalizeEnterpriseDomain("https://ghe.example.com/path"),
			"ghe.example.com",
		);
		assert.equal(
			normalizeEnterpriseDomain(" ghe.example.com "),
			"ghe.example.com",
		);
		assert.equal(normalizeEnterpriseDomain(""), undefined);
		assert.equal(normalizeEnterpriseDomain(undefined), undefined);
	});

	test("exchanges tokens against api.<domain>, defaulting to github.com", () => {
		assert.equal(
			tokenExchangeUrl(),
			"https://api.github.com/copilot_internal/v2/token",
		);
		assert.equal(
			tokenExchangeUrl("ghe.example.com"),
			"https://api.ghe.example.com/copilot_internal/v2/token",
		);
	});

	test("falls back to copilot-api.<domain> when the token carries no proxy-ep", () => {
		assert.equal(
			deriveApiBase("no-proxy-here", "ghe.example.com"),
			"https://copilot-api.ghe.example.com",
		);
	});
});

describe("pickAutoModel", () => {
	const known = new Set([
		"claude-sonnet-4.6",
		"gpt-5.4",
		"gpt-5.3-codex",
		"gpt-5-mini",
	]);

	test("preserves GitHub's pool order across supported API families", () => {
		assert.equal(
			pickAutoModel(["claude-sonnet-4.6", "gpt-5.4", "gpt-5-mini"], known),
			"claude-sonnet-4.6",
		);
		assert.equal(pickAutoModel(["gpt-5-mini", "gpt-5.4"], known), "gpt-5-mini");
	});

	test("skips pool entries Pi does not know", () => {
		assert.equal(
			pickAutoModel(["gemini-3.5-flash", "gpt-5.4"], known),
			"gpt-5.4",
		);
	});

	test("returns undefined when nothing in the pool is known", () => {
		assert.equal(
			pickAutoModel(["gemini-3.5-flash", "kimi-k3"], known),
			undefined,
		);
		assert.equal(pickAutoModel([], known), undefined);
	});
});

describe("redactResponseBody", () => {
	test("passes an ordinary error body through untouched", () => {
		const body =
			'{"message":"Bad credentials","documentation_url":"https://x"}';
		assert.equal(redactResponseBody(body), body);
	});

	test("redacts token-bearing JSON fields but keeps the surrounding shape", () => {
		const out = redactResponseBody(
			'{"token":"tid=abc;exp=1","refresh_token":"gho_secret","message":"nope"}',
		);
		assert.equal(
			out,
			'{"token":"[redacted]","refresh_token":"[redacted]","message":"nope"}',
		);
	});

	test("redacts JSON token fields regardless of case or spacing", () => {
		assert.equal(
			redactResponseBody('{"Access_Token" : "abc"}'),
			'{"Access_Token" : "[redacted]"}',
		);
	});

	test("redacts bare GitHub tokens outside JSON", () => {
		assert.equal(
			redactResponseBody(
				"upstream rejected gho_16CharactersLongToken0000000000 for user",
			),
			"upstream rejected [redacted] for user",
		);
	});

	test("redacts a bare Copilot token through to its next delimiter", () => {
		assert.equal(
			redactResponseBody("echoed tid=deadbeef;exp=1 end"),
			"echoed tid=[redacted] end",
		);
	});

	test("truncates long bodies and reports how much was dropped", () => {
		const out = redactResponseBody("x".repeat(250), 200);
		assert.equal(out, `${"x".repeat(200)}... [truncated 50 chars]`);
	});

	test("does not truncate a body exactly at the limit", () => {
		assert.equal(redactResponseBody("x".repeat(200), 200), "x".repeat(200));
	});

	test("measures truncation after redaction, not before", () => {
		// A long secret shrinks to "[redacted]", so the result stays under the cap.
		const out = redactResponseBody(`{"token":"${"a".repeat(400)}"}`, 200);
		assert.equal(out, '{"token":"[redacted]"}');
	});
});
