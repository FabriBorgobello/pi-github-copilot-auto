/**
 * The provider surface: token -> base URL -> Auto session -> concrete model ->
 * delegated built-in stream.
 *
 * Docs checklist coverage (docs/custom-provider.md): ordinary text responses,
 * usage accounting, abort behavior, authentication refresh, malformed streams,
 * and cross-family routing. Routing coverage: the router's ranking wins over
 * pool order, unusable candidates are skipped, router failures and timeouts
 * fall back, cancellation propagates, and the decision sticks per conversation. The items this extension does not own — tool calls,
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
	pendingResponse,
	redirectAgentDir,
	SAMPLE_COPILOT_TOKEN,
	SAMPLE_GITHUB_TOKEN,
	SAMPLE_SESSION_TOKEN,
	type StubbedCall,
	stubFetch,
	textResponse,
	uncacheableSessionPayload,
	uncacheableTokenPayload,
	writeStoredCopilot,
} from "./harness.ts";

// Must precede the imports below: config.ts resolves its paths at module init.
const authPath = redirectAgentDir();
writeStoredCopilot(authPath, { refresh: SAMPLE_GITHUB_TOKEN });

const { streamCopilotAuto } = await import("../src/stream.ts");
const { supportedCopilotModels } = await import("../src/model-support.ts");
const { AutoRouter } = await import("../src/router.ts");
type RouteDecision = import("../src/router.ts").RouteDecision;

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

function routerDecision(candidates: string[]) {
	return jsonResponse({
		predicted_label: "needs_reasoning",
		confidence: 0.87,
		latency_ms: 12,
		candidate_models: candidates,
		scores: { needs_reasoning: 0.87, no_reasoning: 0.13 },
	});
}

/**
 * Run one Auto request with a fresh router unless one is supplied, collecting
 * the events and the route decision that served the request.
 */
async function streamOnce(options: {
	context?: typeof CONTEXT;
	stream?: Parameters<typeof streamCopilotAuto>[2];
	router?: InstanceType<typeof AutoRouter>;
}) {
	const routes: RouteDecision[] = [];
	const events = await collect(
		streamCopilotAuto(AUTO_MODEL, options.context ?? CONTEXT, options.stream, {
			router: options.router ?? new AutoRouter(),
			onRoute: (decision) => routes.push(decision),
		}),
	);
	return { events, routes };
}

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

/**
 * Route the four endpoints a single Auto request touches. Unless a test
 * supplies its own router, the intent router endorses the pool's first model.
 */
function copilotRoutes(options: {
	pool: string[];
	chat: (call: StubbedCall) => Response | Promise<Response>;
	router?: (call: StubbedCall) => Response | Promise<Response>;
}) {
	return (call: StubbedCall): Response | Promise<Response> => {
		if (call.url.includes("copilot_internal"))
			return jsonResponse(uncacheableTokenPayload());
		if (call.url.endsWith("/models/session"))
			return jsonResponse(uncacheableSessionPayload(options.pool));
		if (call.url.endsWith("/models/session/intent"))
			return options.router?.(call) ?? routerDecision([options.pool[0]]);
		return options.chat(call);
	};
}

function intentCalls(calls: StubbedCall[]) {
	return calls.filter((call) => call.url.endsWith("/models/session/intent"));
}

function chatCalls(calls: StubbedCall[]) {
	return calls.filter(
		(call) =>
			!call.url.includes("copilot_internal") &&
			!call.url.includes("/models/session"),
	);
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
		const fetchStub = stubFetch(
			copilotRoutes({
				pool: [target.id],
				chat: () => sseResponse(ANTHROPIC_SSE),
			}),
		);
		try {
			const { events, routes } = await streamOnce({});

			assert.deepEqual(
				routes.map((route) => route.model),
				[target.id],
				"route callback did not fire once",
			);
			assert.equal(routes[0].source, "router");
			const done = events.at(-1);
			assert.equal(done?.type, "done", JSON.stringify(done, null, 2));
			assert.equal(done?.message.stopReason, "stop");
			assert.deepEqual(done?.message.content, [
				{ type: "text", text: "hello" },
			]);
			assert.equal(done?.message.usage.input, 7);
			assert.equal(done?.message.usage.output, 3);

			// Token exchange, session open, router, then the delegated chat request.
			assert.equal(fetchStub.calls.length, 4);
			const [intent] = intentCalls(fetchStub.calls);
			assert.equal(intent.url, `${EXPECTED_API_BASE}/models/session/intent`);
			assert.equal(
				intent.headers["copilot-session-token"],
				SAMPLE_SESSION_TOKEN,
			);
			assert.equal(
				intent.headers.authorization,
				`Bearer ${SAMPLE_COPILOT_TOKEN}`,
			);
			assert.equal(intent.headers["copilot-integration-id"], "vscode-chat");
			// Only the current prompt and the verified signals travel to the router.
			const body = JSON.parse(String(intent.init?.body));
			assert.equal(body.prompt, "hi");
			assert.deepEqual(body.available_models, [target.id]);
			assert.equal(body.turn_number, 1);
			assert.equal(body.prompt_char_count, 2);
			assert.equal(typeof body.session_id, "string");
			assert.deepEqual(
				Object.keys(body).sort(),
				[
					"available_models",
					"prompt",
					"prompt_char_count",
					"session_id",
					"turn_number",
				],
				"unexpected fields in the router request",
			);
			const chat = fetchStub.calls[3];
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
			await streamOnce({
				stream: {
					onPayload: () => {
						payloads++;
					},
					onResponse: () => {
						responses++;
					},
				},
			});
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
			const event = errorEvent((await streamOnce({})).events);
			assert.equal(event.reason, "error");
			assert.match(
				event.error.errorMessage ?? "",
				/no supported model in the Auto pool/,
			);
			assert.match(
				event.error.errorMessage ?? "",
				/some-model-pi-has-never-heard-of/,
			);
			// No router request either: nothing it could return would be streamable.
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
				(await streamOnce({ stream: { signal: controller.signal } })).events,
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
			const event = errorEvent((await streamOnce({})).events);
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
			const event = errorEvent((await streamOnce({})).events);
			assert.equal(event.reason, "error");
		} finally {
			fetchStub.restore();
		}
	});
	test("follows the router's ranking instead of pool order", async () => {
		const first = firstModelWithApi("openai-responses");
		const routed = firstModelWithApi("anthropic-messages");
		const fetchStub = stubFetch(
			copilotRoutes({
				pool: [first.id, routed.id],
				router: () => routerDecision([routed.id, first.id]),
				chat: () => sseResponse(ANTHROPIC_SSE),
			}),
		);
		try {
			const { events, routes } = await streamOnce({});
			assert.deepEqual(routes, [
				{
					source: "router",
					model: routed.id,
					label: "needs_reasoning",
					confidence: 0.87,
				},
			]);
			// The Anthropic fixture only parses on the Anthropic transport.
			const done = events.at(-1);
			assert.equal(done?.type, "done", JSON.stringify(done, null, 2));
			assert.deepEqual(done?.message.content, [
				{ type: "text", text: "hello" },
			]);
			assert.equal(done?.message.model, routed.id);
			const [chat] = chatCalls(fetchStub.calls);
			assert.ok(chat.url.startsWith(EXPECTED_API_BASE));
			assert.equal(chat.headers["copilot-session-token"], SAMPLE_SESSION_TOKEN);
			assert.ok(JSON.stringify(chat.headers).includes(SAMPLE_COPILOT_TOKEN));
		} finally {
			fetchStub.restore();
		}
	});

	test("skips candidates outside the pool or unknown to Pi", async () => {
		const first = firstModelWithApi("openai-responses");
		const routed = firstModelWithApi("anthropic-messages");
		const fetchStub = stubFetch(
			copilotRoutes({
				pool: [first.id, "pooled-but-unknown-to-pi", routed.id],
				router: () =>
					routerDecision([
						"not-in-this-session-pool",
						"pooled-but-unknown-to-pi",
						routed.id,
					]),
				chat: () => sseResponse(ANTHROPIC_SSE),
			}),
		);
		try {
			const { events, routes } = await streamOnce({});
			assert.equal(routes[0].source, "router");
			assert.equal(routes[0].model, routed.id);
			assert.equal(events.at(-1)?.type, "done");
		} finally {
			fetchStub.restore();
		}
	});

	test("falls back to the first supported pool model when the router fails", async () => {
		const first = firstModelWithApi("anthropic-messages");
		const other = firstModelWithApi("openai-responses");
		const leakyBody = `{"message":"nope","session_token":"${SAMPLE_SESSION_TOKEN}","tid":"${SAMPLE_COPILOT_TOKEN}"}`;
		const fetchStub = stubFetch(
			copilotRoutes({
				pool: [first.id, other.id],
				router: () => textResponse(leakyBody, 404),
				chat: () => sseResponse(ANTHROPIC_SSE),
			}),
		);
		try {
			const { events, routes } = await streamOnce({});
			assert.equal(events.at(-1)?.type, "done");
			const [route] = routes;
			assert.equal(route.source, "default");
			assert.equal(route.model, first.id);
			if (route.source === "default") {
				assert.equal(route.reason, "router_error");
				assert.match(route.detail ?? "", /^404: /);
				for (const secret of [SAMPLE_SESSION_TOKEN, SAMPLE_COPILOT_TOKEN])
					assert.ok(
						!route.detail?.includes(secret),
						`fallback detail leaked ${secret}`,
					);
			}
		} finally {
			fetchStub.restore();
		}
	});

	test("falls back when the router answers with an unusable payload", async () => {
		const first = firstModelWithApi("anthropic-messages");
		for (const payload of [
			jsonResponse({ unexpected: true }),
			routerDecision([]),
			routerDecision(["not-in-this-session-pool"]),
		]) {
			const fetchStub = stubFetch(
				copilotRoutes({
					pool: [first.id],
					router: () => payload,
					chat: () => sseResponse(ANTHROPIC_SSE),
				}),
			);
			try {
				const { events, routes } = await streamOnce({});
				assert.equal(events.at(-1)?.type, "done");
				assert.equal(routes[0].source, "default");
				assert.equal(routes[0].model, first.id);
			} finally {
				fetchStub.restore();
			}
		}
	});

	test("falls back when the router does not answer in time", async () => {
		const first = firstModelWithApi("anthropic-messages");
		const fetchStub = stubFetch(
			copilotRoutes({
				pool: [first.id],
				router: () => pendingResponse(),
				chat: () => sseResponse(ANTHROPIC_SSE),
			}),
		);
		try {
			const { events, routes } = await streamOnce({
				router: new AutoRouter({ timeoutMs: 20 }),
			});
			assert.equal(events.at(-1)?.type, "done");
			assert.deepEqual(routes, [
				{
					source: "default",
					model: first.id,
					reason: "router_timeout",
					detail: undefined,
				},
			]);
		} finally {
			fetchStub.restore();
		}
	});

	test("propagates cancellation during routing instead of falling back", async () => {
		const first = firstModelWithApi("anthropic-messages");
		const controller = new AbortController();
		const fetchStub = stubFetch(
			copilotRoutes({
				pool: [first.id],
				router: () => {
					controller.abort();
					return pendingResponse();
				},
				chat: () => {
					throw new Error("no chat request should follow a cancelled route");
				},
			}),
		);
		try {
			const { events, routes } = await streamOnce({
				stream: { signal: controller.signal },
			});
			const event = errorEvent(events);
			assert.equal(event.reason, "aborted");
			assert.deepEqual(routes, []);
			assert.equal(chatCalls(fetchStub.calls).length, 0);
		} finally {
			fetchStub.restore();
		}
	});

	test("keeps the route for the conversation and re-routes after invalidation", async () => {
		const first = firstModelWithApi("openai-responses");
		const routed = firstModelWithApi("anthropic-messages");
		const fetchStub = stubFetch(
			copilotRoutes({
				pool: [first.id, routed.id],
				router: () => routerDecision([routed.id]),
				chat: () => sseResponse(ANTHROPIC_SSE),
			}),
		);
		const router = new AutoRouter();
		try {
			await streamOnce({ router });
			// Second step of the same conversation: the sticky route, no router call.
			const second = await streamOnce({
				router,
				context: normalizeContext({
					messages: [
						...CONTEXT.messages,
						{ role: "user", content: "and then?", timestamp: Date.now() },
					],
				}),
			});
			assert.equal(second.routes[0].model, routed.id);
			assert.equal(intentCalls(fetchStub.calls).length, 1);

			router.invalidate();
			await streamOnce({
				router,
				context: normalizeContext({
					messages: [
						...CONTEXT.messages,
						{ role: "user", content: "and then?", timestamp: Date.now() },
					],
				}),
			});
			const intents = intentCalls(fetchStub.calls);
			assert.equal(intents.length, 2);
			const body = JSON.parse(String(intents[1].init?.body));
			assert.equal(body.prompt, "and then?");
			assert.equal(body.turn_number, 2);
			assert.equal(body.previous_model, routed.id);
			assert.equal(
				JSON.parse(String(intents[0].init?.body)).session_id,
				body.session_id,
				"the conversation id changed within one conversation",
			);
		} finally {
			fetchStub.restore();
		}
	});

	test("uses the default route for image prompts without consulting the router", async () => {
		const first = firstModelWithApi("anthropic-messages");
		const fetchStub = stubFetch(
			copilotRoutes({
				pool: [first.id],
				router: () => {
					throw new Error("the router must not see image prompts");
				},
				chat: () => sseResponse(ANTHROPIC_SSE),
			}),
		);
		try {
			const { routes } = await streamOnce({
				context: normalizeContext({
					messages: [
						{
							role: "user",
							content: [
								{ type: "text", text: "what is this?" },
								{ type: "image", data: "AAAA", mimeType: "image/png" },
							],
							timestamp: Date.now(),
						},
					],
				}),
			});
			assert.equal(routes[0].source, "default");
			assert.equal(routes[0].model, first.id);
			assert.equal(intentCalls(fetchStub.calls).length, 0);
		} finally {
			fetchStub.restore();
		}
	});
});
