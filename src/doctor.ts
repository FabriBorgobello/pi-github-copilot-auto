import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { getCopilotAuth, getStoredCopilotStatus } from "./auth.ts";
import { pickAutoModel } from "./helpers.ts";
import { supportedCopilotModelIds } from "./model-support.ts";
import { type AutoRouter, describeRouteDecision } from "./router.ts";
import { getAutoSession } from "./session.ts";

/**
 * The report deliberately makes no router request: routing is a per-prompt
 * decision, so it reports the default route and the last outcome seen in
 * this process instead of inventing a prompt to route.
 */
export async function runDoctor(router?: AutoRouter): Promise<string> {
	const stored = getStoredCopilotStatus();
	const { token, apiBase: base } = await getCopilotAuth();
	const session = await getAutoSession(base, token);
	const supported = supportedCopilotModelIds();
	const allKnown = getBuiltinModels("github-copilot");
	const matches = session.availableModels.filter((id) => supported.has(id));
	const defaultRoute =
		pickAutoModel(session.availableModels, supported) ?? "none";
	const lastRoute = router?.lastDecision
		? describeRouteDecision(router.lastDecision)
		: "none yet (decided on the first prompt of a conversation)";
	const expires =
		stored.accessTokenExpiresAtMs == null
			? "unknown"
			: new Date(stored.accessTokenExpiresAtMs).toISOString();
	const yesNo = (value: boolean) => (value ? "yes" : "no");
	const list = (items: string[]) => (items.length ? items.join(", ") : "none");

	return [
		"Copilot Auto doctor",
		"",
		"Auth",
		`  File: ${stored.authPath}`,
		`  Stored access token: ${yesNo(stored.hasAccessToken)}${stored.hasAccessToken ? ` (${expires})` : ""}`,
		`  Stored refresh token: ${yesNo(stored.hasRefreshToken)}`,
		`  GitHub host: ${stored.enterpriseDomain ?? "github.com"}`,
		"",
		"Routing",
		`  API base: ${base}`,
		`  Known GitHub Copilot models in Pi: ${allKnown.length}`,
		`  Supported for Auto streaming here: ${supported.size}`,
		`  Auto pool returned by GitHub: ${session.availableModels.length}`,
		`  Auto pool models: ${list(session.availableModels)}`,
		`  Pi-supported matches in pool: ${matches.length}`,
		`  Matching models: ${list(matches)}`,
		`  Default route (first supported pool model): ${defaultRoute}`,
		`  Router endpoint: ${base}/models/session/intent`,
		`  Last router outcome: ${lastRoute}`,
	].join("\n");
}
