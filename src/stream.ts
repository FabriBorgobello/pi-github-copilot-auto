/**
 * Request assembly + streaming for the Auto model. Resolves the token + session,
 * lets the router pick a concrete model from the pool, and delegates to Pi's
 * matching built-in streamer with the Copilot-Session-Token header attached.
 */
import {
	type Api,
	type AssistantMessageEventStream,
	anthropicMessagesApi,
	createAssistantMessageEventStream,
	type Model,
	openAICompletionsApi,
	openAIResponsesApi,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import { getCopilotAuth } from "./auth.ts";
import { COPILOT_HEADERS } from "./config.ts";
import {
	supportedCopilotApiList,
	supportedCopilotModels,
} from "./model-support.ts";
import type { AutoRouter, RouteDecision } from "./router.ts";
import { getAutoSession } from "./session.ts";

function streamConcreteModel(
	model: Model<Api>,
	context: TranscriptContext,
	options: SimpleStreamOptions,
): AssistantMessageEventStream {
	switch (model.api) {
		case "anthropic-messages":
			return anthropicMessagesApi().streamSimple(
				model as Model<"anthropic-messages">,
				context,
				options,
			);
		case "openai-completions":
			return openAICompletionsApi().streamSimple(
				model as Model<"openai-completions">,
				context,
				options,
			);
		case "openai-responses":
			return openAIResponsesApi().streamSimple(
				model as Model<"openai-responses">,
				context,
				options,
			);
		default:
			throw new Error(
				`Copilot Auto: model ${model.id} routed to unsupported API ${model.api}. Supported APIs here: ${supportedCopilotApiList()}. Update Pi or this extension if GitHub adds a new API family.`,
			);
	}
}

export interface StreamCopilotAutoDeps {
	/** Per-conversation routing state owned by the extension host. */
	router: AutoRouter;
	/** Called once per request with the route that served it. */
	onRoute?: (decision: RouteDecision) => void;
}

export function streamCopilotAuto(
	model: Model<Api>,
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	deps: StreamCopilotAutoDeps,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		try {
			const signal = options?.signal;
			const { token: copilotToken, apiBase: base } =
				await getCopilotAuth(signal);
			const session = await getAutoSession(base, copilotToken, signal);

			const known = supportedCopilotModels();
			const decision = await deps.router.resolve({
				base,
				copilotToken,
				session,
				messages: context.messages,
				known,
				signal,
			});
			if (!decision) {
				throw new Error(
					`Copilot Auto: no supported model in the Auto pool matched Pi's catalog. Pool: [${session.availableModels.join(", ")}]`,
				);
			}
			// The router only ever returns ids from the pool ∩ Pi's catalog.
			const concrete = known.get(decision.model);
			if (!concrete) {
				throw new Error(
					`Copilot Auto: selected model ${decision.model} is missing from Pi's catalog.`,
				);
			}
			deps.onRoute?.(decision);

			const concreteWithBase = { ...concrete, baseUrl: base };
			const streamOptions: SimpleStreamOptions = {
				...options,
				apiKey: copilotToken,
				headers: {
					...COPILOT_HEADERS,
					"Copilot-Session-Token": session.sessionToken,
				},
			};

			const inner = streamConcreteModel(
				concreteWithBase,
				context,
				streamOptions,
			);
			for await (const event of inner) stream.push(event);
			stream.end();
		} catch (error) {
			// Mirror the built-in providers: a cancelled request is an aborted
			// result, not an error. Cancellation during the token exchange or the
			// Auto session open lands here, before a delegated stream exists.
			const stopReason = options?.signal?.aborted ? "aborted" : "error";
			stream.push({
				type: "error",
				reason: stopReason,
				error: {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0,
						},
					},
					stopReason,
					errorMessage: error instanceof Error ? error.message : String(error),
					timestamp: Date.now(),
				},
			});
			stream.end();
		}
	})();

	return stream;
}
