/**
 * Model routing for the Auto pool.
 *
 * Asks GitHub's intent router (POST /models/session/intent) which pool model
 * fits the current prompt and falls back to the first supported pool model.
 * The protocol and cadence mirror microsoft/vscode-copilot-chat. Diff against
 * these when upgrading (verified at commit 5863f5a, October 2026):
 * - https://github.com/microsoft/vscode-copilot-chat/blob/main/src/platform/endpoint/node/routerDecisionFetcher.ts
 *   (request body, headers, 1 s timeout, RouterDecisionResponse)
 * - https://github.com/microsoft/vscode-copilot-chat/blob/main/src/platform/endpoint/node/automodeService.ts
 *   (once-per-conversation cadence, fallback reasons, vision fallback)
 * - https://www.npmjs.com/package/@vscode/copilot-api (0.5.2): RequestType.ModelRouter
 *   resolves to `${capiModelsURL}/session/intent`.
 *
 * Behaviour mirrored:
 *
 * - body `{ prompt, available_models, ...signals }`, authenticated with the
 *   Copilot token plus the Auto session token, abandoned after 1 s;
 * - the router is consulted on the first user prompt of a conversation and
 *   again after compaction; the decision then sticks for the conversation;
 * - image prompts, empty prompts, router failures, and candidates that are not
 *   both in the pool and streamable here all fall back to the default route.
 *
 * Only the latest user prompt is sent — never tool output or earlier turns.
 * Logs and diagnostics carry model ids, labels and HTTP statuses, never the
 * prompt text or any token.
 */
import { randomUUID } from "node:crypto";
import type { Api, Message, Model } from "@earendil-works/pi-ai/compat";
import { COPILOT_HEADERS, log } from "./config.ts";
import { pickAutoModel, redactResponseBody } from "./helpers.ts";
import { type RouterDecision, RouterDecisionSchema } from "./schemas.ts";
import type { AutoSession } from "./session.ts";

export const ROUTER_TIMEOUT_MS = 1000;

/** Why the default route was used instead of a router pick. */
export type FallbackReason =
	| "image_prompt"
	| "empty_prompt"
	| "no_usable_candidate"
	| "router_timeout"
	| "router_error"
	| "router_invalid_payload";

export type RouteDecision =
	| {
			source: "router";
			model: string;
			label: string;
			confidence: number | undefined;
	  }
	| {
			source: "default";
			model: string;
			reason: FallbackReason;
			detail?: string;
	  };

export function describeRouteDecision(decision: RouteDecision): string {
	if (decision.source === "router") {
		const confidence =
			decision.confidence === undefined
				? ""
				: `, confidence ${decision.confidence.toFixed(2)}`;
		return `${decision.model} via router (${decision.label}${confidence})`;
	}
	const detail = decision.detail ? ` ${decision.detail}` : "";
	return `${decision.model} default (${decision.reason}${detail})`;
}

export interface RoutingPrompt {
	/** Trimmed text of the latest user message; empty when there is none. */
	text: string;
	hasImage: boolean;
	/** 1-based count of user messages so far, VS Code's turn_number. */
	turnNumber: number;
}

/** The latest user message is the prompt to route; earlier turns stay local. */
export function routingPrompt(messages: Message[]): RoutingPrompt {
	let turnNumber = 0;
	let latest: Extract<Message, { role: "user" }> | undefined;
	for (const message of messages) {
		if (message.role !== "user") continue;
		turnNumber++;
		latest = message;
	}
	if (!latest) return { text: "", hasImage: false, turnNumber };
	if (typeof latest.content === "string")
		return { text: latest.content.trim(), hasImage: false, turnNumber };
	const text = latest.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
	const hasImage = latest.content.some((part) => part.type === "image");
	return { text, hasImage, turnNumber };
}

/**
 * First router candidate that GitHub actually offered in this session's pool
 * and that Pi can stream here. A candidate outside the pool is never used:
 * the session token is only valid for the pool it was issued for.
 */
export function pickRoutedModel(
	candidates: string[],
	availableModels: string[],
	supportedModelIds: Set<string>,
): string | undefined {
	const pool = new Set(availableModels);
	return candidates.find((id) => pool.has(id) && supportedModelIds.has(id));
}

/** RoutingContextSignals in routerDecisionFetcher.ts. */
export interface RoutingSignals {
	turn_number?: number;
	session_id?: string;
	previous_model?: string;
	prompt_char_count?: number;
}

export interface RouterRequest {
	base: string;
	copilotToken: string;
	sessionToken: string;
	availableModels: string[];
	prompt: string;
	signals: RoutingSignals;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export type RouterFetchResult =
	| { ok: true; decision: RouterDecision }
	| { ok: false; reason: FallbackReason; detail?: string };

/**
 * One router round trip. Resolves to a fallback reason on any router-side
 * problem so the caller can continue with the default route; rethrows only
 * when the caller's own signal aborted, so cancellation never turns into a
 * fallback request.
 */
export async function fetchRouterDecision(
	request: RouterRequest,
): Promise<RouterFetchResult> {
	const timeout = AbortSignal.timeout(request.timeoutMs ?? ROUTER_TIMEOUT_MS);
	const signal = request.signal
		? AbortSignal.any([request.signal, timeout])
		: timeout;
	let res: Response;
	try {
		res = await fetch(`${request.base}/models/session/intent`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${request.copilotToken}`,
				"Content-Type": "application/json",
				"Copilot-Session-Token": request.sessionToken,
				...COPILOT_HEADERS,
			},
			body: JSON.stringify({
				prompt: request.prompt,
				available_models: request.availableModels,
				...request.signals,
			}),
			signal,
		});
	} catch (error) {
		if (request.signal?.aborted) throw error;
		if (timeout.aborted) return { ok: false, reason: "router_timeout" };
		return {
			ok: false,
			reason: "router_error",
			detail: redactResponseBody(
				error instanceof Error ? error.message : String(error),
				120,
			),
		};
	}
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		return {
			ok: false,
			reason: "router_error",
			detail: `${res.status}: ${redactResponseBody(body, 120)}`,
		};
	}
	const parsed = RouterDecisionSchema.safeParse(
		await res.json().catch(() => undefined),
	);
	if (!parsed.success) return { ok: false, reason: "router_invalid_payload" };
	return { ok: true, decision: parsed.data };
}

export interface ResolveRouteInput {
	base: string;
	copilotToken: string;
	session: AutoSession;
	messages: Message[];
	/** Pi's github-copilot models this extension can stream, by id. */
	known: Map<string, Model<Api>>;
	signal?: AbortSignal;
}

export interface AutoRouterOptions {
	timeoutMs?: number;
}

/**
 * Per-conversation routing state. One instance lives for the extension; the
 * host resets it when the Pi session changes and invalidates it after
 * compaction, matching VS Code's once-per-conversation cadence.
 */
export class AutoRouter {
	#sticky: RouteDecision | undefined;
	#previousModel: string | undefined;
	#conversationId = randomUUID();
	#last: RouteDecision | undefined;
	readonly #timeoutMs: number | undefined;

	constructor(options: AutoRouterOptions = {}) {
		this.#timeoutMs = options.timeoutMs;
	}

	/** Most recent decision made in this process, for diagnostics. */
	get lastDecision(): RouteDecision | undefined {
		return this.#last;
	}

	/** Forget the sticky route; the next prompt is routed again. */
	invalidate(): void {
		this.#sticky = undefined;
	}

	/** New conversation: no sticky route, no previous model, fresh id. */
	reset(): void {
		this.#sticky = undefined;
		this.#previousModel = undefined;
		this.#conversationId = randomUUID();
	}

	/**
	 * Decide which pool model serves this request. Returns undefined when the
	 * pool holds nothing this extension can stream; the caller reports that.
	 */
	async resolve(input: ResolveRouteInput): Promise<RouteDecision | undefined> {
		const { session, known } = input;
		const supported = new Set(known.keys());
		const pool = session.availableModels;
		if (!pickAutoModel(pool, supported)) return undefined;

		const sticky = this.#sticky;
		if (sticky && pool.includes(sticky.model) && supported.has(sticky.model))
			return sticky;

		const prompt = routingPrompt(input.messages);
		const decision = await this.#decide(input, prompt, supported);
		this.#sticky = decision;
		this.#previousModel = decision.model;
		this.#last = decision;
		log(`route: ${describeRouteDecision(decision)}`);
		return decision;
	}

	async #decide(
		input: ResolveRouteInput,
		prompt: RoutingPrompt,
		supported: Set<string>,
	): Promise<RouteDecision> {
		const pool = input.session.availableModels;
		const fallback = (
			reason: FallbackReason,
			detail?: string,
		): RouteDecision => ({
			source: "default",
			model: this.#defaultModel(input, prompt, supported),
			reason,
			detail,
		});

		if (prompt.hasImage) return fallback("image_prompt");
		if (!prompt.text) return fallback("empty_prompt");

		const result = await fetchRouterDecision({
			base: input.base,
			copilotToken: input.copilotToken,
			sessionToken: input.session.sessionToken,
			availableModels: pool,
			prompt: prompt.text,
			signals: {
				turn_number: prompt.turnNumber,
				session_id: this.#conversationId,
				previous_model: this.#previousModel,
				prompt_char_count: prompt.text.length,
			},
			signal: input.signal,
			timeoutMs: this.#timeoutMs,
		});
		if (!result.ok) return fallback(result.reason, result.detail);

		const model = pickRoutedModel(
			result.decision.candidate_models,
			pool,
			supported,
		);
		if (!model) return fallback("no_usable_candidate");
		return {
			source: "router",
			model,
			label: result.decision.predicted_label,
			confidence: result.decision.confidence,
		};
	}

	/**
	 * First supported pool model; with an image attached, prefer the first
	 * vision-capable one (VS Code's _applyVisionFallback).
	 */
	#defaultModel(
		input: ResolveRouteInput,
		prompt: RoutingPrompt,
		supported: Set<string>,
	): string {
		const pool = input.session.availableModels;
		if (prompt.hasImage) {
			const vision = new Set(
				[...input.known.values()]
					.filter((model) => model.input.includes("image"))
					.map((model) => model.id),
			);
			const visionPick = pickAutoModel(pool, vision);
			if (visionPick) return visionPick;
		}
		// resolve() already verified the pool has a supported model.
		return pickAutoModel(pool, supported) as string;
	}
}
