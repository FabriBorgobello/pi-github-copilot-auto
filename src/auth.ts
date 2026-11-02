/**
 * Copilot credentials, borrowed from Pi's built-in github-copilot provider.
 *
 * Pi owns the login, the token refresh and the GitHub Enterprise host: asking
 * the model registry for a github-copilot model's request auth returns the
 * current Copilot token and the API base derived from it.
 */
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { COPILOT_PROVIDER_ID } from "./config.ts";

/** The registry surface this extension uses; narrow so tests can fake it. */
export type CopilotRegistry = Pick<
	ModelRegistry,
	"getAvailable" | "getApiKeyAndHeaders"
>;

/** A Copilot token plus the API host it is valid for. */
export interface CopilotAuth {
	token: string;
	apiBase: string;
}

const LOGIN_HINT = "Run /login and pick GitHub Copilot.";

/** Pi's github-copilot models that the current login can use, by id. */
export function copilotModels(
	registry: CopilotRegistry,
): Map<string, Model<Api>> {
	const models = new Map<string, Model<Api>>();
	for (const model of registry.getAvailable())
		if (model.provider === COPILOT_PROVIDER_ID) models.set(model.id, model);
	return models;
}

export async function getCopilotAuth(
	registry: CopilotRegistry,
): Promise<CopilotAuth> {
	// Request auth is per provider; any of its models resolves the same token.
	const [model] = copilotModels(registry).values();
	if (!model)
		throw new Error(
			`Copilot Auto: no GitHub Copilot login found. ${LOGIN_HINT}`,
		);
	const auth = await registry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(`Copilot Auto: ${auth.error} ${LOGIN_HINT}`);
	if (!auth.apiKey)
		throw new Error(`Copilot Auto: GitHub Copilot has no token. ${LOGIN_HINT}`);
	return { token: auth.apiKey, apiBase: auth.baseUrl ?? model.baseUrl };
}
