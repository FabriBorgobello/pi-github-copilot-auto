/**
 * /copilot-auto-doctor — the report users paste into an issue.
 *
 * It is glue over the tested pieces, so the contract asserted here is that the
 * report resolves the whole chain and prints no credential.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	EXPECTED_API_BASE,
	fakeRegistry,
	jsonResponse,
	redirectAgentDir,
	SAMPLE_COPILOT_TOKEN,
	SAMPLE_SESSION_TOKEN,
	type StubbedCall,
	stubFetch,
	textResponse,
	uncacheableSessionPayload,
} from "./harness.ts";

// Must precede the imports below: config.ts resolves its log path at module init.
redirectAgentDir();
const { runDoctor } = await import("../src/doctor.ts");
const { copilotModels } = await import("../src/auth.ts");
const { AutoRouter } = await import("../src/router.ts");

describe("runDoctor", () => {
	test("reports the resolved route without printing any credential", async () => {
		const registry = await fakeRegistry();
		const [target] = copilotModels(registry).keys();
		assert.ok(target, "Pi's github-copilot catalog is empty");

		const fetchStub = stubFetch(() =>
			jsonResponse(uncacheableSessionPayload([target, "unknown-model"])),
		);
		try {
			const report = await runDoctor(registry);

			assert.match(report, /^Copilot Auto doctor$/m);
			assert.ok(report.includes(`API base: ${EXPECTED_API_BASE}`));
			assert.ok(
				report.includes(
					`Default route (first available pool model): ${target}`,
				),
			);
			assert.ok(report.includes("Auto pool returned by GitHub: 2"));
			assert.ok(report.includes("Pi-available matches in pool: 1"));
			assert.ok(
				report.includes(
					`Router endpoint: ${EXPECTED_API_BASE}/models/session/intent`,
				),
			);
			assert.match(report, /Last router outcome: none yet/);
			// Doctor never routes a prompt: the session open only.
			assert.equal(fetchStub.calls.length, 1);
			assert.ok(fetchStub.calls[0].url.endsWith("/models/session"));

			for (const secret of [SAMPLE_COPILOT_TOKEN, SAMPLE_SESSION_TOKEN])
				assert.ok(
					!report.includes(secret),
					`the doctor report leaked ${secret}`,
				);
		} finally {
			fetchStub.restore();
		}
	});

	test("reports the last router outcome held in memory, without a new request", async () => {
		const registry = await fakeRegistry();
		const known = copilotModels(registry);
		const [target] = known.keys();
		const fetchStub = stubFetch((call: StubbedCall) => {
			if (call.url.endsWith("/models/session/intent"))
				return jsonResponse({
					predicted_label: "needs_reasoning",
					confidence: 0.9,
					candidate_models: [target],
				});
			if (call.url.endsWith("/models/session"))
				return jsonResponse(uncacheableSessionPayload([target]));
			return textResponse("unexpected", 404);
		});
		try {
			// A routed request earlier in the process leaves its decision behind.
			const router = new AutoRouter();
			await router.resolve({
				base: EXPECTED_API_BASE,
				copilotToken: SAMPLE_COPILOT_TOKEN,
				session: {
					sessionToken: SAMPLE_SESSION_TOKEN,
					availableModels: [target],
					discountedCosts: {},
					expiresAtMs: Date.now() + 60_000,
				},
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
				known,
				reason: "user",
			});
			const routerCalls = fetchStub.calls.length;

			const report = await runDoctor(registry, router);

			assert.ok(
				report.includes(
					`Last router outcome: ${target} via router (needs_reasoning, confidence 0.90)`,
				),
				report,
			);
			// Session open only; the doctor itself never routes.
			assert.equal(fetchStub.calls.length - routerCalls, 1);
			assert.ok(!report.includes(SAMPLE_SESSION_TOKEN));
		} finally {
			fetchStub.restore();
		}
	});

	test("fails with an actionable message when there is no login", async () => {
		await assert.rejects(runDoctor(await fakeRegistry({ login: false })), {
			message: /no GitHub Copilot login found\. Run \/login/,
		});
	});
});
