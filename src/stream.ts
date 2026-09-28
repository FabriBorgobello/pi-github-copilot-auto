/**
 * Request assembly + streaming for the Auto model. Resolves the token + session,
 * picks a concrete model from the pool, and delegates to Pi's matching built-in
 * streamer with the Copilot-Session-Token header attached.
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
import { getCopilotToken } from "./auth.ts";
import { COPILOT_HEADERS, log } from "./config.ts";
import { deriveApiBase, pickAutoModel } from "./helpers.ts";
import {
	supportedCopilotApiList,
	supportedCopilotModels,
} from "./model-support.ts";
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

export function streamCopilotAuto(
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
	onRoutedModel?: (model: string) => void,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		try {
			const signal = options?.signal;
			const copilotToken = await getCopilotToken(signal);
			const base = deriveApiBase(copilotToken);
			const session = await getAutoSession(base, copilotToken, signal);

			const known = supportedCopilotModels();
			const selectedId = pickAutoModel(
				session.availableModels,
				new Set(known.keys()),
			);
			if (!selectedId) {
				throw new Error(
					`Copilot Auto: no supported model in the Auto pool matched Pi's catalog. Pool: [${session.availableModels.join(", ")}]`,
				);
			}
			const concrete = known.get(selectedId);
			if (!concrete) {
				throw new Error(
					`Copilot Auto: selected model ${selectedId} is missing from Pi's catalog.`,
				);
			}
			log(`routed -> ${selectedId}`);
			onRoutedModel?.(selectedId);

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
			stream.push({
				type: "error",
				reason: "error",
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
					stopReason: "error",
					errorMessage: error instanceof Error ? error.message : String(error),
					timestamp: Date.now(),
				},
			});
			stream.end();
		}
	})();

	return stream;
}
