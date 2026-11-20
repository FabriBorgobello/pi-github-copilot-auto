/**
 * /copilot-auto-doctor — the report users paste into an issue.
 *
 * It is glue over the tested pieces, so the contract asserted here is that the
 * report resolves the whole chain, routes only its fixed prompt, and prints
 * no credential.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	autoPayload,
	EXPECTED_API_BASE,
	fakeRegistry,
	jsonResponse,
	redirectAgentDir,
	SAMPLE_COPILOT_TOKEN,
	SAMPLE_SESSION_TOKEN,
	stubFetch,
	textResponse,
} from "./harness.ts";

// Must precede the imports below: config.ts resolves its log path at module init.
redirectAgentDir();
const { DOCTOR_PROMPT, runDoctor } = await import("../src/doctor.ts");
const { copilotModels } = await import("../src/auth.ts");
const { AutoRouter } = await import("../src/router.ts");

describe("runDoctor", () => {
	test("reports /auto's pick for a fixed prompt without printing any credential", async () => {
		const registry = await fakeRegistry();
		const [target] = copilotModels(registry).keys();
		assert.ok(target, "Pi's github-copilot catalog is empty");

		const fetchStub = stubFetch(() => jsonResponse(autoPayload(target)));
		try {
			const report = await runDoctor(registry);

			assert.match(report, /^Copilot Auto doctor$/m);
			assert.ok(report.includes(`API base: ${EXPECTED_API_BASE}`));
			assert.ok(
				report.includes(
					`Auto endpoint: ${EXPECTED_API_BASE}/auto (tier balance)`,
				),
			);
			assert.ok(
				report.includes(
					`Auto pick for a test prompt: ${target} (Auto selected ${target}.), available in Pi`,
				),
				report,
			);
			assert.match(report, /Last route: none yet/);
			assert.equal(fetchStub.calls.length, 1);
			assert.equal(
				JSON.parse(String(fetchStub.calls[0].init?.body)).prompt,
				DOCTOR_PROMPT,
			);

			for (const secret of [SAMPLE_COPILOT_TOKEN, SAMPLE_SESSION_TOKEN])
				assert.ok(
					!report.includes(secret),
					`the doctor report leaked ${secret}`,
				);
		} finally {
			fetchStub.restore();
		}
	});

	test("flags a pick Pi does not know", async () => {
		const fetchStub = stubFetch(() => jsonResponse(autoPayload("brand-new")));
		try {
			const report = await runDoctor(await fakeRegistry());
			assert.match(report, /brand-new .*NOT available in Pi; run `pi update`/);
		} finally {
			fetchStub.restore();
		}
	});

	test("reports an /auto failure instead of failing the whole report", async () => {
		const fetchStub = stubFetch(() => textResponse("not enabled", 404));
		try {
			const report = await runDoctor(await fakeRegistry());
			assert.match(
				report,
				/Auto pick for a test prompt: failed: Copilot Auto: \/auto 404: not enabled/,
			);
		} finally {
			fetchStub.restore();
		}
	});

	test("reports the last route held in memory", async () => {
		const registry = await fakeRegistry();
		const known = copilotModels(registry);
		const [target] = known.keys();
		const fetchStub = stubFetch(() => jsonResponse(autoPayload(target)));
		try {
			const router = new AutoRouter();
			await router.resolve({
				base: EXPECTED_API_BASE,
				copilotToken: SAMPLE_COPILOT_TOKEN,
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
				known,
				reason: "user",
			});

			const report = await runDoctor(registry, router);

			assert.ok(
				report.includes(
					`Last route: ${target} (Auto selected ${target}.), tier balance`,
				),
				report,
			);
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
