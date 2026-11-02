/**
 * The extension inside a real Pi agent session.
 *
 * Runs Pi's SDK with the extension loaded and only `fetch` stubbed, so the
 * contract asserted here is Pi's own: the virtual model routes to a built-in
 * github-copilot model, the response is recorded under that model, the Auto
 * session token reaches the chat request through `before_provider_headers`,
 * and the route is kept in Pi's router state.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	VIRTUAL_MODEL_STATE_ENTRY,
} from "@earendil-works/pi-coding-agent";
import {
	EXPECTED_API_BASE,
	type FetchStub,
	jsonResponse,
	redirectAgentDir,
	SAMPLE_COPILOT_TOKEN,
	SAMPLE_SESSION_TOKEN,
	type StubbedCall,
	sseResponse,
	stubFetch,
	textResponse,
	uncacheableSessionPayload,
} from "./harness.ts";

// Must precede the imports below: config.ts resolves its log path at module init.
const home = redirectAgentDir();
const { default: extension } = await import("../src/index.ts");

// openai-completions models keep the stubbed stream short. The router's pick
// is second in pool order, so it is distinguishable from the default route.
const DEFAULT_MODEL = "gemini-3.8-flash";
const ROUTED_MODEL = "kimi-k3";
const POOL = [DEFAULT_MODEL, ROUTED_MODEL];

function chatCompletion(text: string): Response {
	const chunk = (body: unknown) => `data: ${JSON.stringify(body)}\n\n`;
	return sseResponse(
		chunk({
			id: "c1",
			model: "m",
			choices: [{ index: 0, delta: { role: "assistant", content: text } }],
		}) +
			chunk({
				id: "c1",
				model: "m",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
			}) +
			"data: [DONE]\n\n",
	);
}

interface Harness {
	session: AgentSession;
	fetchStub: FetchStub;
	chatCalls(): StubbedCall[];
	routerCalls(): StubbedCall[];
}

interface SessionOptions {
	/** Answer a request before the default stubs; undefined falls through. */
	route?: (call: StubbedCall) => Response | undefined;
	/** Give Pi a github-copilot credential. */
	login?: boolean;
}

async function startSession({
	route = () => undefined,
	login = true,
}: SessionOptions = {}): Promise<Harness> {
	const fetchStub = stubFetch((call) => {
		const custom = route(call);
		if (custom) return custom;
		if (call.url.endsWith("/models/session/intent"))
			return jsonResponse({
				predicted_label: "needs_reasoning",
				confidence: 0.9,
				candidate_models: [ROUTED_MODEL],
			});
		if (call.url.endsWith("/models/session"))
			return jsonResponse(uncacheableSessionPayload(POOL));
		if (call.url.endsWith("/chat/completions")) return chatCompletion("hello");
		return textResponse(`unexpected ${call.url}`, 404);
	});
	const agentDir = mkdtempSync(join(home, "agent-"));
	const cwd = mkdtempSync(join(tmpdir(), "copilot-auto-cwd-"));
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
	});
	if (login)
		await modelRuntime.setRuntimeApiKey("github-copilot", SAMPLE_COPILOT_TOKEN);
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		extensionFactories: [extension],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		modelRuntime,
		resourceLoader,
		tools: [],
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: false, keepRecentTokens: 0 },
			retry: { enabled: false },
		}),
	});
	await session.bindExtensions({});
	const auto = session.modelRuntime.getModel("github-copilot-auto", "auto");
	assert.ok(auto, "the Auto virtual model is not registered");
	await session.setModel(auto);
	const calls = (suffix: string) => () =>
		fetchStub.calls.filter((call) => call.url.endsWith(suffix));
	return {
		session,
		fetchStub,
		chatCalls: calls("/chat/completions"),
		routerCalls: calls("/models/session/intent"),
	};
}

function lastAssistant(session: AgentSession): AssistantMessage {
	const message = session.messages.findLast((m) => m.role === "assistant");
	assert.ok(message, "no assistant message");
	return message as AssistantMessage;
}

describe("Auto virtual model in a Pi session", () => {
	let harness: Harness | undefined;
	beforeEach(() => {
		harness = undefined;
	});
	afterEach(() => {
		harness?.session.dispose();
		harness?.fetchStub.restore();
	});

	test("routes to the router's pick and records the physical model", async () => {
		harness = await startSession();
		await harness.session.prompt("explain this");

		const message = lastAssistant(harness.session);
		assert.equal(message.stopReason, "stop", message.errorMessage ?? "");
		assert.equal(message.provider, "github-copilot");
		assert.equal(message.model, ROUTED_MODEL);
		assert.deepEqual(message.content, [{ type: "text", text: "hello" }]);

		const [chat] = harness.chatCalls();
		assert.ok(chat, "no chat request was sent");
		assert.ok(chat.url.startsWith(EXPECTED_API_BASE));
		assert.equal(chat.headers["copilot-session-token"], SAMPLE_SESSION_TOKEN);
		assert.equal(chat.headers.authorization, `Bearer ${SAMPLE_COPILOT_TOKEN}`);
		assert.equal(harness.routerCalls().length, 1);
	});

	test("keeps the route for the conversation and stores it as router state", async () => {
		harness = await startSession();
		await harness.session.prompt("explain this");
		await harness.session.prompt("and now this");

		assert.equal(harness.routerCalls().length, 1);
		const chats = harness.chatCalls();
		assert.equal(chats.length, 2);
		for (const chat of chats)
			assert.equal(chat.headers["copilot-session-token"], SAMPLE_SESSION_TOKEN);
		assert.equal(lastAssistant(harness.session).model, ROUTED_MODEL);

		const states = harness.session.sessionManager
			.getEntries()
			.filter(
				(entry) =>
					entry.type === "custom" &&
					entry.customType === VIRTUAL_MODEL_STATE_ENTRY,
			);
		// The second prompt reused the stored route instead of writing a new one.
		assert.equal(states.length, 1);
		const [entry] = states;
		assert.ok(entry.type === "custom");
		const data = entry.data as {
			state: { decision: { model: string; source: string } };
		};
		assert.equal(data.state.decision.model, ROUTED_MODEL);
		assert.equal(data.state.decision.source, "router");
	});

	test("falls back to the first pool model when the router fails", async () => {
		harness = await startSession({
			route: (call) =>
				call.url.endsWith("/models/session/intent")
					? textResponse("not enabled", 404)
					: undefined,
		});
		await harness.session.prompt("explain this");

		const message = lastAssistant(harness.session);
		assert.equal(message.stopReason, "stop", message.errorMessage ?? "");
		assert.equal(message.model, DEFAULT_MODEL);
		assert.equal(
			harness.chatCalls()[0]?.headers["copilot-session-token"],
			SAMPLE_SESSION_TOKEN,
		);
	});

	test("routes again on the prompt after a compaction", async () => {
		harness = await startSession();
		await harness.session.prompt("explain this");
		await harness.session.compact();
		await harness.session.prompt("continue");

		assert.equal(harness.routerCalls().length, 2);
		// The summary request stayed on the conversation's model, with the token.
		const chats = harness.chatCalls();
		assert.equal(chats.length, 3);
		for (const chat of chats)
			assert.equal(chat.headers["copilot-session-token"], SAMPLE_SESSION_TOKEN);
	});

	test("never sends the session token once another model is selected", async () => {
		harness = await startSession();
		await harness.session.prompt("explain this");
		const direct = harness.session.modelRuntime.getModel(
			"github-copilot",
			DEFAULT_MODEL,
		);
		assert.ok(direct);
		await harness.session.setModel(direct);
		await harness.session.prompt("and now this");

		const chats = harness.chatCalls();
		assert.equal(chats.length, 2);
		assert.equal(
			chats[0].headers["copilot-session-token"],
			SAMPLE_SESSION_TOKEN,
		);
		assert.equal(chats[1].headers["copilot-session-token"], undefined);
	});

	test("ends the turn with an actionable error when there is no Copilot login", async () => {
		harness = await startSession({ login: false });
		await harness.session.prompt("explain this").catch(() => {});

		const message = lastAssistant(harness.session);
		assert.equal(message.stopReason, "error");
		assert.match(
			message.errorMessage ?? "",
			/Run \/login and pick GitHub Copilot/,
		);
		assert.equal(harness.chatCalls().length, 0);
	});
});
