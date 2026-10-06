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
	jsonResponse,
	redirectAgentDir,
	SAMPLE_COPILOT_TOKEN,
	SAMPLE_GITHUB_TOKEN,
	SAMPLE_SESSION_TOKEN,
	type StubbedCall,
	stubFetch,
	uncacheableSessionPayload,
	uncacheableTokenPayload,
	writeStoredCopilot,
} from "./harness.ts";

// Must precede the imports below: config.ts resolves its paths at module init.
const authPath = redirectAgentDir();
const { runDoctor } = await import("../src/doctor.ts");
const { supportedCopilotModels } = await import("../src/model-support.ts");
const { AutoRouter } = await import("../src/router.ts");

describe("runDoctor", () => {
	test("reports the resolved route without printing any credential", async () => {
		const known = [...supportedCopilotModels().keys()];
		assert.ok(known.length > 0, "Pi's github-copilot catalog is empty");
		const [target] = known;

		writeStoredCopilot(authPath, { refresh: SAMPLE_GITHUB_TOKEN });
		const fetchStub = stubFetch((call: StubbedCall) =>
			call.url.includes("copilot_internal")
				? jsonResponse(uncacheableTokenPayload())
				: jsonResponse(uncacheableSessionPayload([target, "unknown-model"])),
		);
		try {
			const report = await runDoctor();

			assert.match(report, /^Copilot Auto doctor$/m);
			assert.ok(report.includes(`File: ${authPath}`));
			assert.ok(report.includes(`API base: ${EXPECTED_API_BASE}`));
			assert.ok(
				report.includes(
					`Default route (first supported pool model): ${target}`,
				),
			);
			assert.ok(report.includes("Auto pool returned by GitHub: 2"));
			assert.ok(report.includes("Pi-supported matches in pool: 1"));
			assert.ok(
				report.includes(
					`Router endpoint: ${EXPECTED_API_BASE}/models/session/intent`,
				),
			);
			assert.match(report, /Last router outcome: none yet/);
			// Doctor never routes a prompt: token exchange + session only.
			assert.equal(fetchStub.calls.length, 2);
			assert.ok(
				fetchStub.calls.every((call) => !call.url.endsWith("/intent")),
				"the doctor made a router request",
			);

			for (const secret of [
				SAMPLE_GITHUB_TOKEN,
				SAMPLE_COPILOT_TOKEN,
				SAMPLE_SESSION_TOKEN,
			])
				assert.ok(
					!report.includes(secret),
					`the doctor report leaked ${secret}`,
				);
		} finally {
			fetchStub.restore();
		}
	});

	test("reports the last router outcome held in memory, without a new request", async () => {
		const known = supportedCopilotModels();
		const [target] = known.keys();
		writeStoredCopilot(authPath, { refresh: SAMPLE_GITHUB_TOKEN });
		const fetchStub = stubFetch((call: StubbedCall) => {
			if (call.url.includes("copilot_internal"))
				return jsonResponse(uncacheableTokenPayload());
			if (call.url.endsWith("/models/session/intent"))
				return jsonResponse({
					predicted_label: "needs_reasoning",
					confidence: 0.9,
					candidate_models: [target],
				});
			return jsonResponse(uncacheableSessionPayload([target]));
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
			});
			const routerCalls = fetchStub.calls.length;

			const report = await runDoctor(router);

			assert.ok(
				report.includes(
					`Last router outcome: ${target} via router (needs_reasoning, confidence 0.90)`,
				),
				report,
			);
			// Token exchange + session open only; the doctor itself never routes.
			assert.equal(fetchStub.calls.length - routerCalls, 2);
			assert.ok(!report.includes(SAMPLE_SESSION_TOKEN));
		} finally {
			fetchStub.restore();
		}
	});

	test("fails with an actionable message when there is no login", async () => {
		writeStoredCopilot(authPath, {});
		await assert.rejects(runDoctor(), {
			message: /no github-copilot login found/,
		});
	});
});
