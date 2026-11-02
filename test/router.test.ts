/**
 * The intent-router client and the pure routing rules around it.
 *
 * The request/response shape asserted here is the one microsoft/vscode-copilot-chat
 * sends and reads (routerDecisionFetcher.ts); the selection rules are the
 * handoff's: never a model outside the pool, never one outside Pi's
 * github-copilot catalog. AutoRouter.resolve adds the cadence: route once per
 * conversation, keep the route in Pi's router state, re-route after compaction.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Message } from "@earendil-works/pi-ai/compat";
import {
	EXPECTED_API_BASE,
	fakeRegistry,
	jsonResponse,
	pendingResponse,
	redirectAgentDir,
	SAMPLE_COPILOT_TOKEN,
	SAMPLE_SESSION_TOKEN,
	stubFetch,
	textResponse,
} from "./harness.ts";

// Must precede the imports below: config.ts resolves its paths at module init.
redirectAgentDir();
const {
	AutoRouter,
	describeRouteDecision,
	fetchRouterDecision,
	pickRoutedModel,
	routingPrompt,
} = await import("../src/router.ts");
const { copilotModels } = await import("../src/auth.ts");
type ResolveRouteInput = import("../src/router.ts").ResolveRouteInput;

const user = (content: unknown) =>
	({ role: "user", content, timestamp: 1 }) as Message;
const assistant = (text: string) =>
	({
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "github-copilot",
		model: "m",
		usage: {},
		stopReason: "stop",
		timestamp: 1,
	}) as unknown as Message;

describe("routingPrompt", () => {
	test("takes the latest user message only and counts user turns", () => {
		const prompt = routingPrompt([
			user("first question"),
			assistant("answer"),
			user("  follow-up  "),
		]);
		assert.deepEqual(prompt, {
			text: "follow-up",
			hasImage: false,
			turnNumber: 2,
		});
	});

	test("joins text parts and flags attached images", () => {
		const prompt = routingPrompt([
			user([
				{ type: "text", text: "look" },
				{ type: "image", data: "AAAA", mimeType: "image/png" },
				{ type: "text", text: "here" },
			]),
		]);
		assert.deepEqual(prompt, {
			text: "look\nhere",
			hasImage: true,
			turnNumber: 1,
		});
	});

	test("is empty when there is no user message or only whitespace", () => {
		assert.deepEqual(routingPrompt([]), {
			text: "",
			hasImage: false,
			turnNumber: 0,
		});
		assert.equal(routingPrompt([user("   ")]).text, "");
	});
});

describe("pickRoutedModel", () => {
	const supported = new Set(["a", "b"]);

	test("returns the first candidate that is pooled and streamable", () => {
		assert.equal(
			pickRoutedModel(
				["x", "unknown", "b", "a"],
				["a", "b", "unknown"],
				supported,
			),
			"b",
		);
	});

	test("never picks a model outside the session pool", () => {
		assert.equal(pickRoutedModel(["a"], ["b"], supported), undefined);
	});

	test("never picks a pooled model missing from Pi's catalog", () => {
		assert.equal(
			pickRoutedModel(["unknown"], ["unknown"], supported),
			undefined,
		);
		assert.equal(pickRoutedModel([], ["a"], supported), undefined);
	});
});

describe("describeRouteDecision", () => {
	test("names the source so diagnostics never pass a default off as a router pick", () => {
		assert.equal(
			describeRouteDecision({
				source: "router",
				model: "gpt-x",
				label: "needs_reasoning",
				confidence: 0.912,
			}),
			"gpt-x via router (needs_reasoning, confidence 0.91)",
		);
		assert.equal(
			describeRouteDecision({
				source: "default",
				model: "gpt-x",
				reason: "router_error",
				detail: "404: not found",
			}),
			"gpt-x default (router_error 404: not found)",
		);
	});
});

describe("fetchRouterDecision", () => {
	const request = {
		base: EXPECTED_API_BASE,
		copilotToken: SAMPLE_COPILOT_TOKEN,
		sessionToken: SAMPLE_SESSION_TOKEN,
		availableModels: ["a", "b"],
		prompt: "why is the build red?",
		signals: { turn_number: 1, prompt_char_count: 21 },
	};

	test("posts the verified body and headers to /models/session/intent", async () => {
		const fetchStub = stubFetch(() =>
			jsonResponse({
				predicted_label: "no_reasoning",
				confidence: 0.6,
				latency_ms: 9,
				candidate_models: ["b"],
				scores: { needs_reasoning: 0.4, no_reasoning: 0.6 },
			}),
		);
		try {
			const result = await fetchRouterDecision(request);
			assert.deepEqual(result, {
				ok: true,
				decision: {
					predicted_label: "no_reasoning",
					confidence: 0.6,
					candidate_models: ["b"],
				},
			});
			const [call] = fetchStub.calls;
			assert.equal(call.url, `${EXPECTED_API_BASE}/models/session/intent`);
			assert.equal(call.init?.method, "POST");
			assert.equal(
				call.headers.authorization,
				`Bearer ${SAMPLE_COPILOT_TOKEN}`,
			);
			assert.equal(call.headers["copilot-session-token"], SAMPLE_SESSION_TOKEN);
			assert.equal(call.headers["content-type"], "application/json");
			assert.equal(call.headers["copilot-integration-id"], "vscode-chat");
			assert.deepEqual(JSON.parse(String(call.init?.body)), {
				prompt: "why is the build red?",
				available_models: ["a", "b"],
				turn_number: 1,
				prompt_char_count: 21,
			});
		} finally {
			fetchStub.restore();
		}
	});

	test("reports an HTTP failure with a redacted body", async () => {
		const fetchStub = stubFetch(() =>
			textResponse(
				`{"error":"gone","session_token":"${SAMPLE_SESSION_TOKEN}","token":"${SAMPLE_COPILOT_TOKEN}"}`,
				404,
			),
		);
		try {
			const result = await fetchRouterDecision(request);
			assert.equal(result.ok, false);
			if (!result.ok) {
				assert.equal(result.reason, "router_error");
				assert.match(result.detail ?? "", /^404: /);
				assert.ok(!result.detail?.includes(SAMPLE_SESSION_TOKEN));
				assert.ok(!result.detail?.includes(SAMPLE_COPILOT_TOKEN));
				assert.ok(!result.detail?.includes("deadbeefcafe"));
			}
		} finally {
			fetchStub.restore();
		}
	});

	test("reports a payload that does not match the schema", async () => {
		for (const body of [
			jsonResponse({ predicted_label: "needs_reasoning" }),
			jsonResponse({ candidate_models: "a" }),
			textResponse("<html>", 200),
		]) {
			const fetchStub = stubFetch(() => body);
			try {
				assert.deepEqual(await fetchRouterDecision(request), {
					ok: false,
					reason: "router_invalid_payload",
				});
			} finally {
				fetchStub.restore();
			}
		}
	});

	test("reports a timeout instead of waiting on the router", async () => {
		const fetchStub = stubFetch(() => pendingResponse());
		try {
			assert.deepEqual(
				await fetchRouterDecision({ ...request, timeoutMs: 20 }),
				{ ok: false, reason: "router_timeout" },
			);
		} finally {
			fetchStub.restore();
		}
	});

	test("reports a network failure without the credential", async () => {
		const fetchStub = stubFetch(() => {
			throw new TypeError(`fetch failed for Bearer ${SAMPLE_COPILOT_TOKEN}`);
		});
		try {
			const result = await fetchRouterDecision(request);
			assert.equal(result.ok, false);
			if (!result.ok) {
				assert.equal(result.reason, "router_error");
				assert.ok(!result.detail?.includes("deadbeefcafe"));
			}
		} finally {
			fetchStub.restore();
		}
	});

	test("rethrows when the caller cancels, so no fallback request follows", async () => {
		const controller = new AbortController();
		const fetchStub = stubFetch(() => {
			controller.abort();
			return pendingResponse();
		});
		try {
			await assert.rejects(
				fetchRouterDecision({ ...request, signal: controller.signal }),
				{ name: "AbortError" },
			);
		} finally {
			fetchStub.restore();
		}
	});
});

const known = copilotModels(await fakeRegistry());

describe("AutoRouter.resolve", () => {
	// Discovered from Pi's catalog rather than hardcoded, so a retired id cannot
	// silently turn these into default-route tests.
	const ids = [...known.keys()];
	const [first, second, third] = ids;

	function input(
		overrides: Partial<ResolveRouteInput> = {},
	): ResolveRouteInput {
		return {
			base: EXPECTED_API_BASE,
			copilotToken: SAMPLE_COPILOT_TOKEN,
			session: {
				sessionToken: SAMPLE_SESSION_TOKEN,
				availableModels: [first, second, third],
				discountedCosts: {},
				expiresAtMs: Date.now() + 60_000,
			},
			messages: [user("refactor this module")],
			known,
			reason: "user",
			...overrides,
		};
	}
	const pool = (availableModels: string[]) => ({
		...input().session,
		availableModels,
	});
	const decision = (candidates: string[]) =>
		jsonResponse({
			predicted_label: "needs_reasoning",
			confidence: 0.87,
			candidate_models: candidates,
		});

	test("follows the router's ranking instead of pool order", async () => {
		const fetchStub = stubFetch(() => decision([third, first]));
		try {
			const route = await new AutoRouter().resolve(input());
			assert.equal(route?.model, third);
			assert.equal(route?.decision?.source, "router");
			assert.equal(route?.state?.decision.model, third);
			assert.ok(route?.state?.conversationId);
		} finally {
			fetchStub.restore();
		}
	});

	test("skips candidates outside the pool or missing from Pi's catalog", async () => {
		const fetchStub = stubFetch(() =>
			decision(["not-in-catalog", ids[5], second]),
		);
		try {
			const route = await new AutoRouter().resolve(input());
			assert.equal(route?.model, second);
		} finally {
			fetchStub.restore();
		}
	});

	for (const [name, respond, reason] of [
		["fails", () => textResponse("not enabled", 404), "router_error"],
		[
			"answers with an unusable payload",
			() => jsonResponse({ nope: 1 }),
			"router_invalid_payload",
		],
		[
			"offers no usable candidate",
			() => decision(["not-in-catalog"]),
			"no_usable_candidate",
		],
	] as const)
		test(`falls back to the first pool model when the router ${name}`, async () => {
			const fetchStub = stubFetch(respond);
			try {
				const route = await new AutoRouter().resolve(input());
				assert.equal(route?.model, first);
				assert.equal(route?.decision?.source, "default");
				assert.equal(
					route?.decision?.source === "default" && route.decision.reason,
					reason,
				);
			} finally {
				fetchStub.restore();
			}
		});

	test("falls back when the router does not answer in time", async () => {
		const fetchStub = stubFetch(() => pendingResponse());
		try {
			const route = await new AutoRouter({ timeoutMs: 10 }).resolve(input());
			assert.equal(route?.model, first);
			assert.ok(
				route?.decision?.source === "default" &&
					route.decision.reason === "router_timeout",
			);
		} finally {
			fetchStub.restore();
		}
	});

	test("propagates cancellation during routing instead of falling back", async () => {
		const fetchStub = stubFetch(() => pendingResponse());
		const controller = new AbortController();
		try {
			const pending = new AutoRouter().resolve(
				input({ signal: controller.signal }),
			);
			controller.abort();
			await assert.rejects(pending, { name: "AbortError" });
		} finally {
			fetchStub.restore();
		}
	});

	test("keeps a stored route without asking the router again", async () => {
		const fetchStub = stubFetch(() => decision([third]));
		try {
			const router = new AutoRouter();
			const routed = await router.resolve(input());
			for (const reason of ["user", "continuation", "retry"] as const) {
				const again = await router.resolve(
					input({ reason, state: routed?.state }),
				);
				assert.equal(again?.model, third);
				// The same object tells Pi the state did not change.
				assert.equal(again?.state, routed?.state);
			}
			assert.equal(fetchStub.calls.length, 1);
		} finally {
			fetchStub.restore();
		}
	});

	test("routes the next user prompt again after invalidation, in the same conversation", async () => {
		const fetchStub = stubFetch(() => decision([third]));
		try {
			const router = new AutoRouter();
			const routed = await router.resolve(input());
			router.invalidate();
			// Tool-call steps of the current turn keep the route.
			await router.resolve(
				input({ reason: "continuation", state: routed?.state }),
			);
			assert.equal(fetchStub.calls.length, 1);

			const rerouted = await router.resolve(
				input({ reason: "user", state: routed?.state }),
			);
			assert.equal(fetchStub.calls.length, 2);
			assert.notEqual(rerouted?.state, routed?.state);
			assert.equal(
				rerouted?.state?.conversationId,
				routed?.state?.conversationId,
			);
			const body = JSON.parse(String(fetchStub.calls[1].init?.body));
			assert.equal(body.previous_model, third);
			assert.equal(body.session_id, routed?.state?.conversationId);

			// The request is consumed: the following prompt sticks again.
			await router.resolve(input({ state: rerouted?.state }));
			assert.equal(fetchStub.calls.length, 2);
		} finally {
			fetchStub.restore();
		}
	});

	test("routes again when the stored model left the pool", async () => {
		const fetchStub = stubFetch(() => decision([second]));
		try {
			const state = {
				conversationId: "conversation-1",
				decision: { source: "default", model: first, reason: "router_error" },
			} as const;
			const moved = await new AutoRouter().resolve(
				input({
					reason: "continuation",
					state,
					session: pool([third, second]),
				}),
			);
			assert.equal(moved?.model, second);
			assert.equal(moved?.state?.conversationId, state.conversationId);
			assert.equal(fetchStub.calls.length, 1);
		} finally {
			fetchStub.restore();
		}
	});

	test("serves direct requests from the last responder without routing or state", async () => {
		const fetchStub = stubFetch(() => decision([third]));
		try {
			const router = new AutoRouter();
			const direct = await router.resolve(
				input({ reason: "direct", previousModel: second }),
			);
			assert.deepEqual(direct, { model: second });

			const fallback = await router.resolve(
				input({ reason: "direct", previousModel: "not-in-pool" }),
			);
			assert.deepEqual(fallback, { model: first });
			assert.equal(fetchStub.calls.length, 0);
		} finally {
			fetchStub.restore();
		}
	});

	test("uses a vision-capable default for image prompts without consulting the router", async () => {
		// Every catalog model takes images today, so add a text-only one.
		const vision = first;
		const textOnly = "text-only-model";
		const base = known.get(first);
		assert.ok(base);
		const withTextOnly = new Map(known).set(textOnly, {
			...base,
			id: textOnly,
			input: ["text"],
		});
		const fetchStub = stubFetch(() => decision([textOnly]));
		try {
			const route = await new AutoRouter().resolve(
				input({
					known: withTextOnly,
					session: pool([textOnly, vision]),
					messages: [
						user([
							{ type: "text", text: "what is this?" },
							{ type: "image", data: "AAAA", mimeType: "image/png" },
						]),
					],
				}),
			);
			assert.equal(route?.model, vision);
			assert.ok(
				route?.decision?.source === "default" &&
					route.decision.reason === "image_prompt",
			);
			assert.equal(fetchStub.calls.length, 0);
		} finally {
			fetchStub.restore();
		}
	});

	test("returns undefined when nothing in the pool is in Pi's catalog", async () => {
		const route = await new AutoRouter().resolve(
			input({ session: pool(["not-in-catalog"]) }),
		);
		assert.equal(route, undefined);
	});
});
