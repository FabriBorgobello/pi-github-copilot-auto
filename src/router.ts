/**
 * Model routing through GitHub's Auto endpoint.
 *
 * POST /auto picks the model for the current prompt and mints the session
 * token the chat request bills against, in a single call. The protocol and
 * cadence mirror Copilot Chat in microsoft/vscode `extensions/copilot`. Diff
 * against these when upgrading (verified November 2026):
 * - src/platform/endpoint/node/autoV2Fetcher.ts at c9479adea7
 *   (request body, 5 s timeout, AutoV2Response)
 * - src/platform/endpoint/node/automodeService.ts at e54f253d94
 *   (once-per-conversation cadence, re-route after compaction, reuse of the
 *   last good route when /auto fails, vision check, _isCacheEntryCompatible)
 * - src/platform/endpoint/common/autoModeTiers.ts (tiers, `balance` default)
 * - https://www.npmjs.com/package/@vscode/copilot-api (0.5.2): RequestType.Auto
 *   resolves to `${capiBaseUrl}/auto`.
 *
 * Behaviour mirrored:
 *
 * - body `{ prompt, has_image? }`, authenticated with the Copilot token,
 *   abandoned after 5 s;
 * - /auto is asked on the first user prompt of a conversation and again after
 *   compaction; the route then sticks for the conversation. The picked model
 *   is kept in Pi's router state, so it follows resume and forks;
 * - a route serves a request only while its token is live and its model
 *   accepts the images the prompt attaches;
 *   otherwise /auto is asked again;
 * - the session token is bound to the picked model and lasts 24 h. It is kept
 *   in memory only, never in router state, so the session file holds no
 *   credential. A conversation without a live token (resumed in a new
 *   process, or expired) asks /auto again;
 * - when /auto fails, the conversation's route is reused if it can still
 *   serve the request; with none there is no fallback, because Auto-only plans can serve nothing else.
 *
 * Only the latest user prompt is sent — never tool output or earlier turns.
 * Logs and diagnostics carry model ids and HTTP statuses, never the prompt
 * text or any token.
 */
import { randomUUID } from "node:crypto";
import type { Api, Message, Model } from "@earendil-works/pi-ai/compat";
import type { ModelRouteReason } from "@earendil-works/pi-coding-agent";
import { AUTO_TIER, COPILOT_HEADERS, log } from "./config.ts";
import { redactResponseBody } from "./helpers.ts";
import { AutoDecisionSchema } from "./schemas.ts";

export const AUTO_TIMEOUT_MS = 5000;
/** A token this close to expiry is not handed to a new request. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

export interface RoutingPrompt {
	/** Trimmed text of the latest user message; empty when there is none. */
	text: string;
	hasImage: boolean;
}

/** The latest user message is the prompt to route; earlier turns stay local. */
export function routingPrompt(messages: readonly Message[]): RoutingPrompt {
	const latest = messages.findLast((message) => message.role === "user");
	if (!latest) return { text: "", hasImage: false };
	if (typeof latest.content === "string")
		return { text: latest.content.trim(), hasImage: false };
	const text = latest.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
	const hasImage = latest.content.some((part) => part.type === "image");
	return { text, hasImage };
}

/** One Auto session: the picked model and the token bound to it. */
export interface AutoRoute {
	model: string;
	sessionToken: string;
	expiresAtMs: number;
	/** `selection_reason` from /auto, for diagnostics. */
	reason?: string;
}

export function describeRoute(route: AutoRoute): string {
	return route.reason ? `${route.model} (${route.reason})` : route.model;
}

export interface AutoRequest {
	base: string;
	copilotToken: string;
	prompt: string;
	hasImage: boolean;
	tier?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}

/**
 * One /auto round trip. Throws an Error safe to show the user on any failure;
 * when the caller's own signal aborted, rethrows that abort unchanged.
 */
export async function fetchAutoRoute(request: AutoRequest): Promise<AutoRoute> {
	const timeout = AbortSignal.timeout(request.timeoutMs ?? AUTO_TIMEOUT_MS);
	const signal = request.signal
		? AbortSignal.any([request.signal, timeout])
		: timeout;
	const body: Record<string, unknown> = {
		prompt: request.prompt,
		tier: request.tier ?? AUTO_TIER,
	};
	if (request.hasImage) body.has_image = true;
	let res: Response;
	try {
		res = await fetch(`${request.base}/auto`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${request.copilotToken}`,
				"Content-Type": "application/json",
				...COPILOT_HEADERS,
			},
			body: JSON.stringify(body),
			signal,
		});
	} catch (error) {
		if (request.signal?.aborted) throw error;
		if (timeout.aborted)
			throw new Error("Copilot Auto: /auto did not answer in time.");
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Copilot Auto: /auto failed: ${redactResponseBody(message, 120)}`,
		);
	}
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(
			`Copilot Auto: /auto ${res.status}: ${redactResponseBody(text, 120)}`,
		);
	}
	const parsed = AutoDecisionSchema.safeParse(
		await res.json().catch(() => undefined),
	);
	if (!parsed.success) throw new Error("Copilot Auto: invalid /auto payload.");
	return {
		model: parsed.data.selected_model.id,
		sessionToken: parsed.data.session_token,
		expiresAtMs: parsed.data.expires_at * 1000,
		reason: parsed.data.selection_reason,
	};
}

/** Router state Pi stores on the session branch (`ModelRoute.state`). */
export interface AutoRouteState {
	/** The conversation's model; it sticks until compaction. */
	model: string;
	/** Random id keying this conversation's in-memory session token. */
	conversationId: string;
}

export interface ResolveRouteInput {
	base: string;
	copilotToken: string;
	messages: readonly Message[];
	/** Pi's github-copilot models the Auto model can route to, by id. */
	known: Map<string, Model<Api>>;
	reason: ModelRouteReason;
	/** Router state Pi restored for this branch; absent for `direct` requests. */
	state?: AutoRouteState;
	signal?: AbortSignal;
}

export interface ResolvedRoute {
	model: string;
	sessionToken: string;
	/** State for Pi to store; `input.state` itself when nothing changed. */
	state?: AutoRouteState;
}

export interface AutoRouterOptions {
	timeoutMs?: number;
}

/**
 * Routing policy for the Auto virtual model. The conversation's model lives
 * in Pi's router state; this instance holds the session tokens, per process,
 * and the request to route again after compaction.
 */
export class AutoRouter {
	readonly #sessions = new Map<string, AutoRoute>();
	#rerouteRequested = false;
	#last: AutoRoute | undefined;
	readonly #timeoutMs: number | undefined;

	constructor(options: AutoRouterOptions = {}) {
		this.#timeoutMs = options.timeoutMs;
	}

	/** Most recent route made in this process, for diagnostics. */
	get lastRoute(): AutoRoute | undefined {
		return this.#last;
	}

	/** Route the next user prompt again, e.g. after compaction. */
	invalidate(): void {
		this.#rerouteRequested = true;
	}

	/** New Pi session: drop a pending re-route request. */
	reset(): void {
		this.#rerouteRequested = false;
	}

	/** Decide which model serves this request, and with which session token. */
	async resolve(input: ResolveRouteInput): Promise<ResolvedRoute> {
		const prompt = routingPrompt(input.messages);
		// VS Code's _isCacheEntryCompatible: a route whose model would get the
		// prompt's images as placeholders is asked for again rather than reused.
		const usable = (route: AutoRoute | undefined): route is AutoRoute =>
			route !== undefined &&
			route.expiresAtMs - Date.now() > EXPIRY_MARGIN_MS &&
			(!prompt.hasImage || acceptsImages(input.known, route.model));

		// Requests outside the agent loop, such as compaction summaries, carry no
		// state: stay on the route that answered last.
		if (input.reason === "direct") {
			if (usable(this.#last))
				return {
					model: this.#last.model,
					sessionToken: this.#last.sessionToken,
				};
			const route = await this.#route(input, prompt, undefined);
			return { model: route.model, sessionToken: route.sessionToken };
		}

		const { state } = input;
		const current = state
			? this.#sessions.get(state.conversationId)
			: undefined;
		const rerouting = input.reason === "user" && this.#rerouteRequested;
		if (state && usable(current) && current.model === state.model && !rerouting)
			return {
				model: current.model,
				sessionToken: current.sessionToken,
				state,
			};

		const conversationId = state?.conversationId ?? randomUUID();
		const route = await this.#route(
			input,
			prompt,
			usable(current) ? current : undefined,
		);
		this.#sessions.set(conversationId, route);
		this.#rerouteRequested = false;
		return {
			model: route.model,
			sessionToken: route.sessionToken,
			state:
				state?.model === route.model
					? state
					: { model: route.model, conversationId },
		};
	}

	/**
	 * Ask /auto for this prompt. `fallback` is the conversation's route if it
	 * can serve this request, reused when /auto fails, as VS Code does.
	 */
	async #route(
		input: ResolveRouteInput,
		prompt: RoutingPrompt,
		fallback: AutoRoute | undefined,
	): Promise<AutoRoute> {
		let route: AutoRoute;
		try {
			if (!prompt.text)
				throw new Error("Copilot Auto: there is no prompt text to route.");
			route = await fetchAutoRoute({
				base: input.base,
				copilotToken: input.copilotToken,
				prompt: prompt.text,
				hasImage: prompt.hasImage,
				signal: input.signal,
				timeoutMs: this.#timeoutMs,
			});
		} catch (error) {
			if (input.signal?.aborted) throw error;
			const message = error instanceof Error ? error.message : String(error);
			if (!fallback) {
				log(`route failed: ${message}`);
				throw error;
			}
			log(`route kept ${fallback.model}: ${message}`);
			return fallback;
		}

		const model = input.known.get(route.model);
		if (!model)
			throw new Error(
				`Copilot Auto picked ${route.model}, which Pi's github-copilot provider does not list for your login. Run \`pi update\` to refresh Pi's model catalog.`,
			);
		// The server filters on has_image, but sending an image to a text-only
		// model is the client's to prevent.
		if (prompt.hasImage && !model.input.includes("image"))
			throw new Error(
				`Copilot Auto picked ${route.model}, which does not accept images.`,
			);
		this.#last = route;
		log(`route: ${describeRoute(route)}`);
		return route;
	}
}

function acceptsImages(known: Map<string, Model<Api>>, model: string): boolean {
	return known.get(model)?.input.includes("image") ?? false;
}
