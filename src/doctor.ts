import { type CopilotRegistry, copilotModels, getCopilotAuth } from "./auth.ts";
import { pickAutoModel } from "./helpers.ts";
import { type AutoRouter, describeRouteDecision } from "./router.ts";
import { getAutoSession } from "./session.ts";

/**
 * The report deliberately makes no router request: routing is a per-prompt
 * decision, so it reports the default route and the last outcome seen in
 * this process instead of inventing a prompt to route.
 */
export async function runDoctor(
	registry: CopilotRegistry,
	router?: AutoRouter,
): Promise<string> {
	const { token, apiBase: base } = await getCopilotAuth(registry);
	const session = await getAutoSession(base, token);
	const known = copilotModels(registry);
	const supported = new Set(known.keys());
	const matches = session.availableModels.filter((id) => supported.has(id));
	const defaultRoute =
		pickAutoModel(session.availableModels, supported) ?? "none";
	const lastRoute = router?.lastDecision
		? describeRouteDecision(router.lastDecision)
		: "none yet (decided on the first prompt of a conversation)";
	const list = (items: string[]) => (items.length ? items.join(", ") : "none");

	return [
		"Copilot Auto doctor",
		"",
		"Auth",
		"  Login: Pi's github-copilot provider",
		`  API base: ${base}`,
		"",
		"Routing",
		`  GitHub Copilot models available in Pi: ${known.size}`,
		`  Auto pool returned by GitHub: ${session.availableModels.length}`,
		`  Auto pool models: ${list(session.availableModels)}`,
		`  Pi-available matches in pool: ${matches.length}`,
		`  Matching models: ${list(matches)}`,
		`  Default route (first available pool model): ${defaultRoute}`,
		`  Router endpoint: ${base}/models/session/intent`,
		`  Last router outcome: ${lastRoute}`,
	].join("\n");
}
