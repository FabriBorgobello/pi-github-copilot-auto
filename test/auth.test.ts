/**
 * Copilot token lifecycle.
 *
 * Docs checklist coverage (docs/custom-provider.md): "authentication refresh
 * and cancellation", plus the redaction rule for provider response bodies.
 *
 * node --test gives each test file its own process, but module state is shared
 * within a file: auth.ts caches the exchanged token at module scope. Tests that
 * must reach the network therefore use payloads whose expiry is already inside
 * the five-minute safety margin, and the two cache assertions run last.
 */
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import {
	clearStoredCopilot,
	jsonResponse,
	redirectAgentDir,
	SAMPLE_COPILOT_TOKEN,
	SAMPLE_GITHUB_TOKEN,
	stubFetch,
	textResponse,
	uncacheableTokenPayload,
	writeStoredCopilot,
} from "./harness.ts";

// Must precede the import below: config.ts resolves AUTH_PATH at module init.
const authPath = redirectAgentDir();
const { getCopilotToken, getStoredCopilotStatus } = await import(
	"../src/auth.ts"
);

const TOKEN_EXCHANGE_URL = "https://api.github.com/copilot_internal/v2/token";

describe("getCopilotToken", () => {
	test("reports a missing auth file with the path and the fix", async () => {
		clearStoredCopilot(authPath);
		await assert.rejects(getCopilotToken(), (error: Error) => {
			assert.match(error.message, /cannot read/);
			assert.match(error.message, /Run \/login and pick GitHub Copilot/);
			assert.ok(error.message.includes(authPath));
			return true;
		});
	});

	test("reports an auth file with no github-copilot entry", async () => {
		writeStoredCopilot(authPath, { something: "else" });
		await assert.rejects(getCopilotToken(), {
			message: /no github-copilot login found/,
		});
	});

	test("exchanges the stored GitHub token and sends the Copilot client identity", async () => {
		writeStoredCopilot(authPath, { refresh: SAMPLE_GITHUB_TOKEN });
		const fetchStub = stubFetch(() => jsonResponse(uncacheableTokenPayload()));
		try {
			assert.equal(await getCopilotToken(), SAMPLE_COPILOT_TOKEN);
			assert.equal(fetchStub.calls.length, 1);
			const [call] = fetchStub.calls;
			assert.equal(call.url, TOKEN_EXCHANGE_URL);
			assert.equal(call.headers.authorization, `Bearer ${SAMPLE_GITHUB_TOKEN}`);
			assert.equal(call.headers.accept, "application/json");
			assert.equal(call.headers["copilot-integration-id"], "vscode-chat");
			assert.ok(call.headers["editor-version"]);
		} finally {
			fetchStub.restore();
		}
	});

	test("ignores a stored access token that has already expired", async () => {
		writeStoredCopilot(authPath, {
			refresh: SAMPLE_GITHUB_TOKEN,
			access: "stale-copilot-token",
			expires: Date.now() - 1000,
		});
		const fetchStub = stubFetch(() => jsonResponse(uncacheableTokenPayload()));
		try {
			assert.equal(await getCopilotToken(), SAMPLE_COPILOT_TOKEN);
			assert.equal(fetchStub.calls.length, 1);
		} finally {
			fetchStub.restore();
		}
	});

	test("redacts the response body when the exchange fails", async () => {
		writeStoredCopilot(authPath, { refresh: SAMPLE_GITHUB_TOKEN });
		const fetchStub = stubFetch(() =>
			textResponse(`{"token":"${SAMPLE_COPILOT_TOKEN}"}`, 401),
		);
		try {
			await assert.rejects(getCopilotToken(), (error: Error) => {
				assert.match(error.message, /token exchange failed 401/);
				assert.match(error.message, /"token":"\[redacted\]"/);
				assert.ok(!error.message.includes("deadbeefcafe"));
				return true;
			});
		} finally {
			fetchStub.restore();
		}
	});

	test("rejects a token exchange payload that does not match the schema", async () => {
		writeStoredCopilot(authPath, { refresh: SAMPLE_GITHUB_TOKEN });
		const fetchStub = stubFetch(() => jsonResponse({ token: 42 }));
		try {
			await assert.rejects(getCopilotToken(), {
				message: /invalid token exchange response/,
			});
		} finally {
			fetchStub.restore();
		}
	});

	test("converts cancellation into an AbortError without caching anything", async () => {
		writeStoredCopilot(authPath, { refresh: SAMPLE_GITHUB_TOKEN });
		const controller = new AbortController();
		controller.abort();
		const fetchStub = stubFetch(() => jsonResponse(uncacheableTokenPayload()));
		try {
			await assert.rejects(getCopilotToken(controller.signal), {
				name: "AbortError",
			});
		} finally {
			fetchStub.restore();
		}
	});

	// The two tests below populate and then read the module-level cache, so they
	// must stay last in this file.
	test("reuses a still-valid stored access token instead of exchanging", async () => {
		writeStoredCopilot(authPath, {
			refresh: SAMPLE_GITHUB_TOKEN,
			access: "stored-copilot-token",
			expires: Date.now() + 60_000,
		});
		const fetchStub = stubFetch(() => {
			throw new Error("token exchange should not have been attempted");
		});
		try {
			assert.equal(await getCopilotToken(), "stored-copilot-token");
			assert.equal(fetchStub.calls.length, 0);
		} finally {
			fetchStub.restore();
		}
	});

	test("serves the cached token without touching the auth file again", async () => {
		clearStoredCopilot(authPath);
		const fetchStub = stubFetch(() => {
			throw new Error("token exchange should not have been attempted");
		});
		try {
			assert.equal(await getCopilotToken(), "stored-copilot-token");
			assert.equal(fetchStub.calls.length, 0);
		} finally {
			fetchStub.restore();
		}
	});
});

describe("getStoredCopilotStatus", () => {
	after(() => clearStoredCopilot(authPath));

	test("summarises the stored credential without exposing it", () => {
		const expires = Date.now() + 60_000;
		writeStoredCopilot(authPath, {
			refresh: SAMPLE_GITHUB_TOKEN,
			access: "stored-copilot-token",
			expires,
		});
		const status = getStoredCopilotStatus();
		assert.deepEqual(status, {
			authPath,
			hasAccessToken: true,
			accessTokenExpiresAtMs: expires,
			hasRefreshToken: true,
		});
		assert.ok(!JSON.stringify(status).includes(SAMPLE_GITHUB_TOKEN));
	});

	test("reports a refresh-only credential as having no access token", () => {
		writeStoredCopilot(authPath, { refresh: SAMPLE_GITHUB_TOKEN });
		assert.deepEqual(getStoredCopilotStatus(), {
			authPath,
			hasAccessToken: false,
			accessTokenExpiresAtMs: null,
			hasRefreshToken: true,
		});
	});
});
