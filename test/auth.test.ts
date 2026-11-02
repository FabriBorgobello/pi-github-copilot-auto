/**
 * Copilot credentials come from Pi's github-copilot provider; this module only
 * picks the request auth out of the model registry and explains failures.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	EXPECTED_API_BASE,
	fakeRegistry,
	redirectAgentDir,
	SAMPLE_COPILOT_TOKEN,
} from "./harness.ts";

// Must precede the import below: config.ts resolves its log path at module init.
redirectAgentDir();
const { copilotModels, getCopilotAuth } = await import("../src/auth.ts");

describe("getCopilotAuth", () => {
	test("returns Pi's Copilot token and the API base derived for it", async () => {
		const enterprise = "https://copilot-api.example.ghe.com";
		const auth = await getCopilotAuth(
			await fakeRegistry({ baseUrl: enterprise }),
		);
		assert.deepEqual(auth, {
			token: SAMPLE_COPILOT_TOKEN,
			apiBase: enterprise,
		});
	});

	test("falls back to the model's base URL when Pi derives none", async () => {
		const registry = await fakeRegistry();
		const auth = await getCopilotAuth({
			...registry,
			getApiKeyAndHeaders: async () => ({
				ok: true as const,
				apiKey: SAMPLE_COPILOT_TOKEN,
			}),
		});
		assert.equal(auth.apiBase, EXPECTED_API_BASE);
	});

	test("asks for /login when Pi has no Copilot models available", async () => {
		await assert.rejects(getCopilotAuth(await fakeRegistry({ login: false })), {
			message: /no GitHub Copilot login found\. Run \/login/,
		});
	});

	test("passes Pi's auth error through with the /login hint", async () => {
		const registry = await fakeRegistry();
		await assert.rejects(
			getCopilotAuth({
				...registry,
				getApiKeyAndHeaders: async () => ({
					ok: false as const,
					error: "Token refresh failed.",
				}),
			}),
			{ message: /Token refresh failed\. Run \/login/ },
		);
	});

	test("lists only github-copilot models", async () => {
		const registry = await fakeRegistry();
		const other = { ...registry.getAvailable()[0], provider: "anthropic" };
		const models = copilotModels({
			...registry,
			getAvailable: () => [...registry.getAvailable(), other],
		});
		for (const model of models.values())
			assert.equal(model.provider, "github-copilot");
	});
});
