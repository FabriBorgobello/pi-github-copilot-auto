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
			assert.ok(report.includes(`Selected route: ${target}`));
			assert.ok(report.includes("Auto pool returned by GitHub: 2"));
			assert.ok(report.includes("Pi-supported matches in pool: 1"));

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

	test("fails with an actionable message when there is no login", async () => {
		writeStoredCopilot(authPath, {});
		await assert.rejects(runDoctor(), {
			message: /no github-copilot login found/,
		});
	});
});
