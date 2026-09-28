/**
 * Auto session lifecycle (POST /models/session).
 *
 * Docs checklist coverage (docs/custom-provider.md): request shape, malformed
 * payloads, cancellation, and the redaction rule for response bodies.
 *
 * session.ts caches the session at module scope, so the tests that must reach
 * the network use payloads that are already inside the five-minute safety
 * margin; the expiry-default and cache assertions run last.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	EXPECTED_API_BASE,
	jsonResponse,
	redirectAgentDir,
	SAMPLE_COPILOT_TOKEN,
	SAMPLE_SESSION_TOKEN,
	stubFetch,
	textResponse,
	uncacheableSessionPayload,
} from "./harness.ts";

// Must precede the import below: config.ts resolves its paths at module init.
redirectAgentDir();
const { getAutoSession } = await import("../src/session.ts");

const SESSION_URL = `${EXPECTED_API_BASE}/models/session`;

describe("getAutoSession", () => {
	test("posts the auto_mode hint with the Copilot token and client identity", async () => {
		const fetchStub = stubFetch(() =>
			jsonResponse({
				...uncacheableSessionPayload(["claude-sonnet-4.6", "gpt-5.4"]),
				discounted_costs: { "gpt-5.4": 0.5 },
			}),
		);
		try {
			const session = await getAutoSession(
				EXPECTED_API_BASE,
				SAMPLE_COPILOT_TOKEN,
			);
			assert.equal(session.sessionToken, SAMPLE_SESSION_TOKEN);
			assert.deepEqual(session.availableModels, [
				"claude-sonnet-4.6",
				"gpt-5.4",
			]);
			assert.deepEqual(session.discountedCosts, { "gpt-5.4": 0.5 });

			assert.equal(fetchStub.calls.length, 1);
			const [call] = fetchStub.calls;
			assert.equal(call.url, SESSION_URL);
			assert.equal(call.init?.method, "POST");
			assert.equal(
				call.headers.authorization,
				`Bearer ${SAMPLE_COPILOT_TOKEN}`,
			);
			assert.equal(call.headers["content-type"], "application/json");
			assert.equal(call.headers["copilot-integration-id"], "vscode-chat");
			assert.deepEqual(JSON.parse(String(call.init?.body)), {
				auto_mode: { model_hints: ["auto"] },
			});
		} finally {
			fetchStub.restore();
		}
	});

	test("defaults discounted_costs to an empty map when absent", async () => {
		const fetchStub = stubFetch(() =>
			jsonResponse({
				session_token: SAMPLE_SESSION_TOKEN,
				available_models: ["gpt-5.4"],
				expires_at: Math.floor(Date.now() / 1000),
			}),
		);
		try {
			const session = await getAutoSession(
				EXPECTED_API_BASE,
				SAMPLE_COPILOT_TOKEN,
			);
			assert.deepEqual(session.discountedCosts, {});
		} finally {
			fetchStub.restore();
		}
	});

	test("redacts the response body when the session open fails", async () => {
		const fetchStub = stubFetch(() =>
			textResponse(`{"session_token":"${SAMPLE_SESSION_TOKEN}"}`, 403),
		);
		try {
			await assert.rejects(
				getAutoSession(EXPECTED_API_BASE, SAMPLE_COPILOT_TOKEN),
				(error: Error) => {
					assert.match(error.message, /\/models\/session 403/);
					assert.match(error.message, /"session_token":"\[redacted\]"/);
					assert.ok(!error.message.includes(SAMPLE_SESSION_TOKEN));
					return true;
				},
			);
		} finally {
			fetchStub.restore();
		}
	});

	test("rejects a session payload that does not match the schema", async () => {
		const fetchStub = stubFetch(() =>
			jsonResponse({ session_token: SAMPLE_SESSION_TOKEN }),
		);
		try {
			await assert.rejects(
				getAutoSession(EXPECTED_API_BASE, SAMPLE_COPILOT_TOKEN),
				{ message: /invalid \/models\/session payload/ },
			);
		} finally {
			fetchStub.restore();
		}
	});

	test("converts cancellation into an AbortError", async () => {
		const controller = new AbortController();
		controller.abort();
		const fetchStub = stubFetch(() =>
			jsonResponse(uncacheableSessionPayload(["gpt-5.4"])),
		);
		try {
			await assert.rejects(
				getAutoSession(
					EXPECTED_API_BASE,
					SAMPLE_COPILOT_TOKEN,
					controller.signal,
				),
				{ name: "AbortError" },
			);
		} finally {
			fetchStub.restore();
		}
	});

	// The two tests below populate and then read the module-level cache, so they
	// must stay last in this file.
	test("falls back to a 25 minute lifetime when the server omits expires_at", async () => {
		const before = Date.now();
		const fetchStub = stubFetch(() =>
			jsonResponse({
				session_token: SAMPLE_SESSION_TOKEN,
				available_models: ["gpt-5.4"],
			}),
		);
		try {
			const session = await getAutoSession(
				EXPECTED_API_BASE,
				SAMPLE_COPILOT_TOKEN,
			);
			assert.ok(session.expiresAtMs >= before + 25 * 60 * 1000);
			assert.ok(session.expiresAtMs <= Date.now() + 25 * 60 * 1000);
		} finally {
			fetchStub.restore();
		}
	});

	test("serves the cached session while it is outside the refresh margin", async () => {
		const fetchStub = stubFetch(() => {
			throw new Error("session open should not have been attempted");
		});
		try {
			const session = await getAutoSession(
				EXPECTED_API_BASE,
				SAMPLE_COPILOT_TOKEN,
			);
			assert.deepEqual(session.availableModels, ["gpt-5.4"]);
			assert.equal(fetchStub.calls.length, 0);
		} finally {
			fetchStub.restore();
		}
	});
});
