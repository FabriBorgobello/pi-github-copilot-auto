import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

export const SUPPORTED_COPILOT_APIS = [
	"anthropic-messages",
	"openai-completions",
	"openai-responses",
] as const satisfies Api[];

const SUPPORTED_COPILOT_API_SET = new Set<Api>(SUPPORTED_COPILOT_APIS);

export function supportedCopilotModels(): Map<string, Model<Api>> {
	const models = new Map<string, Model<Api>>();
	for (const model of getBuiltinModels("github-copilot")) {
		if (SUPPORTED_COPILOT_API_SET.has(model.api)) models.set(model.id, model);
	}
	return models;
}

export function supportedCopilotModelIds(): Set<string> {
	return new Set(supportedCopilotModels().keys());
}

export function supportedCopilotApiList(): string {
	return SUPPORTED_COPILOT_APIS.join(", ");
}
