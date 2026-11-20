/**
 * The /auto client and the routing policy around it.
 *
 * The request/response shape asserted here is the one Copilot Chat sends and
 * reads (autoV2Fetcher.ts in microsoft/vscode extensions/copilot). AutoRouter
 * adds the cadence: route once per conversation, keep the model in Pi's router
 * state and the session token in memory, re-route after compaction.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Message } from "@earendil-works/pi-ai/compat";
import {
	autoPayload,
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
const { AutoRouter, describeRoute, fetchAutoRoute, routingPrompt } =
	await import("../src/router.ts");
const { copilotModels } = await import("../src/auth.ts");
const { COPILOT_API_VERSION } = await import("../src/config.ts");
type ResolveRouteInput = import("../src/router.ts").ResolveRouteInput;
type AutoRouteState = import("../src/router.ts").AutoRouteState;

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
const imagePrompt = user([
	{ type: "text", text: "what is this?" },
	{ type: "image", data: "AAAA", mimeType: "image/png" },
]);

describe("routingPrompt", () => {
	test("takes the latest user message only", () => {
		assert.deepEqual(
			routingPrompt([
				user("first question"),
				assistant("answer"),
				user("  follow-up  "),
			]),
			{ text: "follow-up", hasImage: false },
		);
	});

	test("joins text parts and flags attached images", () => {
		const prompt = routingPrompt([
			user([
				{ type: "text", text: "look" },
				{ type: "image", data: "AAAA", mimeType: "image/png" },
				{ type: "text", text: "here" },
			]),
		]);
		assert.deepEqual(prompt, { text: "look\nhere", hasImage: true });
	});

	test("is empty when there is no user message or only whitespace", () => {
		assert.deepEqual(routingPrompt([]), { text: "", hasImage: false });
		assert.equal(routingPrompt([user("   ")]).text, "");
	});
});

describe("describeRoute", () => {
	test("adds the server's reason when it gave one", () => {
		const route = {
			model: "gpt-x",
			sessionToken: "t",
			expiresAtMs: 0,
			tier: "balance" as const,
		};
		assert.equal(describeRoute(route), "gpt-x");
		assert.equal(
			describeRoute({ ...route, reason: "best fit" }),
			"gpt-x (best fit)",
		);
	});
});

describe("fetchAutoRoute", () => {
	const request = {
		base: EXPECTED_API_BASE,
		copilotToken: SAMPLE_COPILOT_TOKEN,
		prompt: "why is the build red?",
		hasImage: false,
	};

	test("posts the verified body and headers to /auto", async () => {
		const fetchStub = stubFetch(() => jsonResponse(autoPayload("gpt-x")));
		try {
			const route = await fetchAutoRoute(request);
			assert.equal(route.model, "gpt-x");
			assert.equal(route.sessionToken, SAMPLE_SESSION_TOKEN);
			assert.equal(route.reason, "Auto selected gpt-x.");
			assert.ok(route.expiresAtMs > Date.now() + 23 * 60 * 60 * 1000);

			const [call] = fetchStub.calls;
			assert.equal(call.url, `${EXPECTED_API_BASE}/auto`);
			assert.equal(call.init?.method, "POST");
			assert.equal(
				call.headers.authorization,
				`Bearer ${SAMPLE_COPILOT_TOKEN}`,
			);
			assert.equal(call.headers["content-type"], "application/json");
			assert.equal(call.headers["copilot-integration-id"], "vscode-chat");
			assert.equal(call.headers["x-github-api-version"], COPILOT_API_VERSION);
			assert.deepEqual(JSON.parse(String(call.init?.body)), {
				prompt: "why is the build red?",
				tier: "balance",
			});
		} finally {
			fetchStub.restore();
		}
	});

	test("flags image prompts and sends the requested tier", async () => {
		const fetchStub = stubFetch(() => jsonResponse(autoPayload("gpt-x")));
		try {
			await fetchAutoRoute({ ...request, hasImage: true, tier: "efficiency" });
			assert.deepEqual(JSON.parse(String(fetchStub.calls[0].init?.body)), {
				prompt: "why is the build red?",
				tier: "efficiency",
				has_image: true,
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
			await assert.rejects(fetchAutoRoute(request), (error: Error) => {
				assert.match(error.message, /^Copilot Auto: \/auto 404: /);
				assert.ok(!error.message.includes(SAMPLE_SESSION_TOKEN));
				assert.ok(!error.message.includes("deadbeefcafe"));
				return true;
			});
		} finally {
			fetchStub.restore();
		}
	});

	test("rejects a payload that does not match the schema", async () => {
		for (const body of [
			jsonResponse({ session_token: "t", expires_at: 1 }),
			jsonResponse({ ...autoPayload("gpt-x"), selected_model: "gpt-x" }),
			textResponse("<html>", 200),
		]) {
			const fetchStub = stubFetch(() => body);
			try {
				await assert.rejects(fetchAutoRoute(request), {
					message: "Copilot Auto: invalid /auto payload.",
				});
			} finally {
				fetchStub.restore();
			}
		}
	});

	test("gives up when /auto does not answer in time", async () => {
		const fetchStub = stubFetch(() => pendingResponse());
		try {
			await assert.rejects(fetchAutoRoute({ ...request, timeoutMs: 20 }), {
				message: "Copilot Auto: /auto did not answer in time.",
			});
		} finally {
			fetchStub.restore();
		}
	});

	test("reports a network failure without the credential", async () => {
		const fetchStub = stubFetch(() => {
			throw new TypeError(`fetch failed for Bearer ${SAMPLE_COPILOT_TOKEN}`);
		});
		try {
			await assert.rejects(fetchAutoRoute(request), (error: Error) => {
				assert.match(error.message, /^Copilot Auto: \/auto failed: /);
				assert.ok(!error.message.includes("deadbeefcafe"));
				return true;
			});
		} finally {
			fetchStub.restore();
		}
	});

	test("rethrows the caller's cancellation unchanged", async () => {
		const controller = new AbortController();
		const fetchStub = stubFetch(() => {
			controller.abort();
			return pendingResponse();
		});
		try {
			await assert.rejects(
				fetchAutoRoute({ ...request, signal: controller.signal }),
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
	// silently turn these into failure tests.
	const [first, second] = known.keys();

	function input(
		overrides: Partial<ResolveRouteInput> = {},
	): ResolveRouteInput {
		return {
			base: EXPECTED_API_BASE,
			copilotToken: SAMPLE_COPILOT_TOKEN,
			messages: [user("refactor this module")],
			known,
			reason: "user",
			...overrides,
		};
	}
	const pick = (model: string, token = SAMPLE_SESSION_TOKEN) =>
		jsonResponse(autoPayload(model, token));

	test("routes to /auto's pick with its session token", async () => {
		const fetchStub = stubFetch(() => pick(second));
		try {
			const route = await new AutoRouter().resolve(input());
			assert.equal(route.model, second);
			assert.equal(route.sessionToken, SAMPLE_SESSION_TOKEN);
			assert.equal(route.state?.model, second);
			assert.ok(route.state?.conversationId);
		} finally {
			fetchStub.restore();
		}
	});

	test("keeps the token out of the router state Pi persists", async () => {
		const fetchStub = stubFetch(() => pick(second));
		try {
			const route = await new AutoRouter().resolve(input());
			assert.ok(!JSON.stringify(route.state).includes(SAMPLE_SESSION_TOKEN));
		} finally {
			fetchStub.restore();
		}
	});

	test("keeps the route without asking /auto again", async () => {
		const fetchStub = stubFetch(() => pick(second));
		try {
			const router = new AutoRouter();
			const routed = await router.resolve(input());
			for (const reason of ["user", "continuation", "retry"] as const) {
				const again = await router.resolve(
					input({ reason, state: routed.state }),
				);
				assert.equal(again.model, second);
				assert.equal(again.sessionToken, SAMPLE_SESSION_TOKEN);
				// The same object tells Pi the state did not change.
				assert.equal(again.state, routed.state);
			}
			assert.equal(fetchStub.calls.length, 1);
		} finally {
			fetchStub.restore();
		}
	});

	test("asks /auto again for a stored route without a live token, e.g. after resume", async () => {
		const fetchStub = stubFetch(() => pick(first, "fresh-token"));
		try {
			const state = { model: second, conversationId: "conversation-1" };
			const route = await new AutoRouter().resolve(
				input({ reason: "continuation", state }),
			);
			assert.equal(fetchStub.calls.length, 1);
			assert.equal(route.model, first);
			assert.equal(route.sessionToken, "fresh-token");
			assert.deepEqual(route.state, {
				model: first,
				conversationId: "conversation-1",
			});
		} finally {
			fetchStub.restore();
		}
	});

	test("replaces router state written by 0.4.x", async () => {
		const fetchStub = stubFetch(() => pick(second));
		try {
			const legacy = {
				conversationId: "conversation-1",
				decision: { source: "router", model: second },
			} as unknown as AutoRouteState;
			const route = await new AutoRouter().resolve(
				input({ reason: "continuation", state: legacy }),
			);
			assert.equal(route.model, second);
			assert.deepEqual(route.state, {
				model: second,
				conversationId: "conversation-1",
			});
		} finally {
			fetchStub.restore();
		}
	});

	test("routes the next user prompt again after invalidation, in the same conversation", async () => {
		let model = second;
		const fetchStub = stubFetch(() => pick(model));
		try {
			const router = new AutoRouter();
			const routed = await router.resolve(input());
			router.invalidate();
			// Tool-call steps of the current turn keep the route.
			await router.resolve(
				input({ reason: "continuation", state: routed.state }),
			);
			assert.equal(fetchStub.calls.length, 1);

			model = first;
			const rerouted = await router.resolve(input({ state: routed.state }));
			assert.equal(fetchStub.calls.length, 2);
			assert.equal(rerouted.model, first);
			assert.equal(
				rerouted.state?.conversationId,
				routed.state?.conversationId,
			);

			// The request is consumed: the following prompt sticks again.
			await router.resolve(input({ state: rerouted.state }));
			assert.equal(fetchStub.calls.length, 2);
		} finally {
			fetchStub.restore();
		}
	});

	test("keeps the conversation's live route when /auto fails while re-routing", async () => {
		let fail = false;
		const fetchStub = stubFetch(() =>
			fail ? textResponse("unavailable", 503) : pick(second),
		);
		try {
			const router = new AutoRouter();
			const routed = await router.resolve(input());
			router.invalidate();
			fail = true;
			const kept = await router.resolve(input({ state: routed.state }));
			assert.equal(kept.model, second);
			assert.equal(kept.sessionToken, SAMPLE_SESSION_TOKEN);
			assert.equal(kept.state, routed.state);
		} finally {
			fetchStub.restore();
		}
	});

	test("fails the request when /auto fails and there is no live route", async () => {
		const fetchStub = stubFetch(() => textResponse("unavailable", 503));
		try {
			await assert.rejects(new AutoRouter().resolve(input()), {
				message: /^Copilot Auto: \/auto 503: unavailable/,
			});
		} finally {
			fetchStub.restore();
		}
	});

	test("fails with an actionable message when Pi does not know the pick", async () => {
		const fetchStub = stubFetch(() => pick("brand-new-model"));
		try {
			await assert.rejects(new AutoRouter().resolve(input()), {
				message: /picked brand-new-model.*Run `pi update`/,
			});
		} finally {
			fetchStub.restore();
		}
	});

	// Every catalog model takes images today, so add a text-only one.
	const textOnly = "text-only-model";
	const withTextOnly = (() => {
		const base = known.get(first);
		assert.ok(base);
		return new Map(known).set(textOnly, {
			...base,
			id: textOnly,
			input: ["text"],
		});
	})();

	test("fails instead of sending an image to a text-only pick", async () => {
		const fetchStub = stubFetch(() => pick(textOnly));
		try {
			await assert.rejects(
				new AutoRouter().resolve(
					input({ known: withTextOnly, messages: [imagePrompt] }),
				),
				{ message: /does not accept images/ },
			);
			const body = JSON.parse(String(fetchStub.calls[0].init?.body));
			assert.equal(body.has_image, true);
		} finally {
			fetchStub.restore();
		}
	});

	test("routes again when a later prompt attaches an image the kept model cannot take", async () => {
		let model = textOnly;
		const fetchStub = stubFetch(() => pick(model));
		try {
			const router = new AutoRouter();
			const routed = await router.resolve(input({ known: withTextOnly }));
			// Text prompts keep the text-only route.
			await router.resolve(input({ known: withTextOnly, state: routed.state }));
			assert.equal(fetchStub.calls.length, 1);

			model = second;
			const rerouted = await router.resolve(
				input({
					known: withTextOnly,
					messages: [imagePrompt],
					state: routed.state,
				}),
			);
			assert.equal(fetchStub.calls.length, 2);
			assert.equal(rerouted.model, second);
			assert.equal(
				JSON.parse(String(fetchStub.calls[1].init?.body)).has_image,
				true,
			);
		} finally {
			fetchStub.restore();
		}
	});

	test("does not fall back to a kept model that cannot take the image", async () => {
		let fail = false;
		const fetchStub = stubFetch(() =>
			fail ? textResponse("unavailable", 503) : pick(textOnly),
		);
		try {
			const router = new AutoRouter();
			const routed = await router.resolve(input({ known: withTextOnly }));
			fail = true;
			await assert.rejects(
				router.resolve(
					input({
						known: withTextOnly,
						messages: [imagePrompt],
						state: routed.state,
					}),
				),
				{ message: /\/auto 503/ },
			);
		} finally {
			fetchStub.restore();
		}
	});

	test("sends the selected tier and routes again when it changes", async () => {
		const fetchStub = stubFetch(() => pick(second));
		try {
			const router = new AutoRouter();
			const routed = await router.resolve(input({ tier: "efficiency" }));
			await router.resolve(
				input({
					tier: "efficiency",
					reason: "continuation",
					state: routed.state,
				}),
			);
			assert.equal(fetchStub.calls.length, 1);

			const switched = await router.resolve(
				input({ tier: "intelligence", state: routed.state }),
			);
			assert.equal(fetchStub.calls.length, 2);
			assert.deepEqual(
				fetchStub.calls.map((call) => JSON.parse(String(call.init?.body)).tier),
				["efficiency", "intelligence"],
			);
			assert.equal(switched.sessionToken, SAMPLE_SESSION_TOKEN);
			assert.equal(router.lastRoute?.tier, "intelligence");
		} finally {
			fetchStub.restore();
		}
	});

	test("does not fall back to a route made for another tier", async () => {
		let fail = false;
		const fetchStub = stubFetch(() =>
			fail ? textResponse("unavailable", 503) : pick(second),
		);
		try {
			const router = new AutoRouter();
			const routed = await router.resolve(input());
			fail = true;
			await assert.rejects(
				router.resolve(input({ tier: "intelligence", state: routed.state })),
				{ message: /\/auto 503/ },
			);
			// Direct requests do not borrow it either.
			await assert.rejects(
				router.resolve(input({ tier: "intelligence", reason: "direct" })),
				{ message: /\/auto 503/ },
			);
		} finally {
			fetchStub.restore();
		}
	});

	test("does not call /auto without prompt text", async () => {
		const fetchStub = stubFetch(() => pick(second));
		try {
			await assert.rejects(
				new AutoRouter().resolve(input({ messages: [user("  ")] })),
				{ message: /no prompt text to route/ },
			);
			assert.equal(fetchStub.calls.length, 0);
		} finally {
			fetchStub.restore();
		}
	});

	test("propagates cancellation during routing", async () => {
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

	test("serves direct requests from the last route, routing only when there is none", async () => {
		const fetchStub = stubFetch(() => pick(second));
		try {
			const router = new AutoRouter();
			const cold = await router.resolve(input({ reason: "direct" }));
			assert.deepEqual(cold, {
				model: second,
				sessionToken: SAMPLE_SESSION_TOKEN,
			});
			const warm = await router.resolve(input({ reason: "direct" }));
			assert.deepEqual(warm, cold);
			assert.equal(fetchStub.calls.length, 1);
		} finally {
			fetchStub.restore();
		}
	});
});
