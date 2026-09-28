/**
 * The provider surface: token -> base URL -> Auto session -> concrete model ->
 * delegated built-in stream.
 *
 * Docs checklist coverage (docs/custom-provider.md): ordinary text responses,
 * usage accounting, abort behavior, authentication refresh, malformed streams,
 * and cross-family routing. The items this extension does not own — tool calls,
 * image input, Unicode boundaries, context overflow, session handoff — are
 * exercised by pi-ai's own suites for the built-in APIs this delegates to; the
 * contract asserted here is that the delegation carries the right model,
 * endpoint, credential, and session header.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	type Api,
	type AssistantMessageEvent,
	type Model,
	normalizeContext,
} from "@earendil-works/pi-ai/compat";
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
writeStoredCopilot(authPath, { refresh: SAMPLE_GITHUB_TOKEN });

const { streamCopilotAuto } = await import("../src/stream.ts");
const { supportedCopilotModels } = await import("../src/model-support.ts");

/**
 * Discover a routable model from Pi's own catalog rather than hardcoding an id
 * that GitHub or Pi may retire.
 */
function firstModelWithApi(api: Api): Model<Api> {
	for (const model of supportedCopilotModels().values())
		if (model.api === api) return model;
	throw new Error(`no github-copilot model in Pi's catalog uses ${api}`);
}

const AUTO_MODEL = {
	id: "auto",
	name: "Copilot Auto",
	api: "openai-responses",
	provider: "github-copilot-auto",
	baseUrl: EXPECTED_API_BASE,
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
} as unknown as Model<Api>;

const CONTEXT = normalizeContext({
	messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
});

const ANTHROPIC_SSE = [
	'{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":7,"output_tokens":0}}}',
	'{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
	'{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}',
	'{"type":"content_block_stop","index":0}',
	'{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":3}}',
	'{"type":"message_stop"}',
]
	.map((data) => `event: ${JSON.parse(data).type}\ndata: ${data}\n\n`)
	.join("");

function sseResponse(body: string): Response {
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

/** Route the three endpoints a single Auto request touches. */
function copilotRoutes(options: {
	pool: string[];
	chat: (call: StubbedCall) => Response;
}) {
	return (call: StubbedCall): Response => {
		if (call.url.includes("copilot_internal"))
			return jsonResponse(uncacheableTokenPayload());
		if (call.url.endsWith("/models/session"))
			return jsonResponse(uncacheableSessionPayload(options.pool));
		return options.chat(call);
	};
}

async function collect(
	stream: AsyncIterable<AssistantMessageEvent>,
): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

function errorEvent(events: AssistantMessageEvent[]) {
	const event = events.at(-1);
	assert.equal(event?.type, "error", "stream did not terminate with an error");
	return event as Extract<AssistantMessageEvent, { type: "error" }>;
}

describe("streamCopilotAuto", () => {
	test("routes to a pooled Anthropic model and streams its text", async () => {
		const target = firstModelWithApi("anthropic-messages");
		const routed: string[] = [];
		const fetchStub = stubFetch(
			copilotRoutes({
				pool: [target.id],
				chat: () => sseResponse(ANTHROPIC_SSE),
			}),
		);
		try {
			const events = await collect(
				streamCopilotAuto(AUTO_MODEL, CONTEXT, undefined, (model) =>
					routed.push(model),
				),
			);

			assert.deepEqual(routed, [target.id], "route callback did not fire once");
			const done = events.at(-1);
			assert.equal(done?.type, "done", JSON.stringify(done, null, 2));
			assert.equal(done?.message.stopReason, "stop");
			assert.deepEqual(done?.message.content, [
				{ type: "text", text: "hello" },
			]);
			assert.equal(done?.message.usage.input, 7);
			assert.equal(done?.message.usage.output, 3);

			// Token exchange, session open, then the delegated chat request.
			assert.equal(fetchStub.calls.length, 3);
			const chat = fetchStub.calls[2];
			assert.ok(
				chat.url.startsWith(EXPECTED_API_BASE),
				`chat request went to ${chat.url}, not the base derived from the token`,
			);
			assert.equal(
				chat.headers["copilot-session-token"],
				SAMPLE_SESSION_TOKEN,
				"the Auto session token was not forwarded on the chat request",
			);
			assert.equal(chat.headers["copilot-integration-id"], "vscode-chat");
			assert.ok(
				JSON.stringify(chat.headers).includes(SAMPLE_COPILOT_TOKEN),
				"the Copilot token was not used to authenticate the chat request",
			);
		} finally {
			fetchStub.restore();
		}
	});

	test("forwards the instrumentation hooks the caller supplied", async () => {
		const target = firstModelWithApi("anthropic-messages");
		let payloads = 0;
		let responses = 0;
		const fetchStub = stubFetch(
			copilotRoutes({
				pool: [target.id],
				chat: () => sseResponse(ANTHROPIC_SSE),
			}),
		);
		try {
			await collect(
				streamCopilotAuto(AUTO_MODEL, CONTEXT, {
					onPayload: () => {
						payloads++;
					},
					onResponse: () => {
						responses++;
					},
				}),
			);
			assert.equal(payloads, 1, "onPayload was not invoked");
			assert.equal(responses, 1, "onResponse was not invoked");
		} finally {
			fetchStub.restore();
		}
	});

	test("reports the pool when nothing in it matches Pi's catalog", async () => {
		const fetchStub = stubFetch(
			copilotRoutes({
				pool: ["some-model-pi-has-never-heard-of"],
				chat: () => {
					throw new Error("no chat request should have been attempted");
				},
			}),
		);
		try {
			const event = errorEvent(
				await collect(streamCopilotAuto(AUTO_MODEL, CONTEXT)),
			);
			assert.equal(event.reason, "error");
			assert.match(
				event.error.errorMessage ?? "",
				/no supported model in the Auto pool/,
			);
			assert.match(
				event.error.errorMessage ?? "",
				/some-model-pi-has-never-heard-of/,
			);
			assert.equal(fetchStub.calls.length, 2);
		} finally {
			fetchStub.restore();
		}
	});

	test("reports cancellation as aborted, not as an error", async () => {
		const target = firstModelWithApi("anthropic-messages");
		const controller = new AbortController();
		controller.abort();
		const fetchStub = stubFetch(
			copilotRoutes({
				pool: [target.id],
				chat: () => sseResponse(ANTHROPIC_SSE),
			}),
		);
		try {
			const event = errorEvent(
				await collect(
					streamCopilotAuto(AUTO_MODEL, CONTEXT, {
						signal: controller.signal,
					}),
				),
			);
			assert.equal(event.reason, "aborted");
			assert.equal(event.error.stopReason, "aborted");
		} finally {
			fetchStub.restore();
		}
	});

	test("surfaces a failing auth refresh as a zero-usage error on the Auto model", async () => {
		const fetchStub = stubFetch(
			() => new Response("upstream unavailable", { status: 503 }),
		);
		try {
			const event = errorEvent(
				await collect(streamCopilotAuto(AUTO_MODEL, CONTEXT)),
			);
			assert.equal(event.reason, "error");
			assert.equal(event.error.stopReason, "error");
			// The error is attributed to the Auto model, not to whatever the pool
			// would have routed to: routing never happened.
			assert.equal(event.error.model, "auto");
			assert.equal(event.error.provider, "github-copilot-auto");
			assert.equal(event.error.api, "openai-responses");
			assert.equal(event.error.usage.totalTokens, 0);
			assert.equal(event.error.usage.cost.total, 0);
			assert.match(event.error.errorMessage ?? "", /token exchange failed 503/);
		} finally {
			fetchStub.restore();
		}
	});

	test("terminates with an error when the delegated stream is malformed", async () => {
		const target = firstModelWithApi("anthropic-messages");
		const fetchStub = stubFetch(
			copilotRoutes({
				pool: [target.id],
				chat: () => sseResponse("data: {not json\n\n"),
			}),
		);
		try {
			const event = errorEvent(
				await collect(streamCopilotAuto(AUTO_MODEL, CONTEXT)),
			);
			assert.equal(event.reason, "error");
		} finally {
			fetchStub.restore();
		}
	});
});
