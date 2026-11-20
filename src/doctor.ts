import { type CopilotRegistry, copilotModels, getCopilotAuth } from "./auth.ts";
import { AUTO_TIER } from "./config.ts";
import { type AutoRouter, describeRoute, fetchAutoRoute } from "./router.ts";

/** Fixed, content-free prompt the doctor routes; never the user's text. */
export const DOCTOR_PROMPT = "Copilot Auto doctor check";

/**
 * /auto is the only Auto endpoint, so the report checks it with one routing
 * call on a fixed prompt. That opens a session but runs no model.
 */
export async function runDoctor(
	registry: CopilotRegistry,
	router?: AutoRouter,
): Promise<string> {
	const { token, apiBase: base } = await getCopilotAuth(registry);
	const known = copilotModels(registry);
	let probe: string;
	try {
		const route = await fetchAutoRoute({
			base,
			copilotToken: token,
			prompt: DOCTOR_PROMPT,
			hasImage: false,
		});
		const available = known.has(route.model)
			? "available in Pi"
			: "NOT available in Pi; run `pi update`";
		probe = `${describeRoute(route)}, ${available}`;
	} catch (error) {
		probe = `failed: ${error instanceof Error ? error.message : String(error)}`;
	}
	const lastRoute = router?.lastRoute
		? `${describeRoute(router.lastRoute)}, tier ${router.lastRoute.tier}`
		: "none yet (decided on the first prompt of a conversation)";

	return [
		"Copilot Auto doctor",
		"",
		"Auth",
		"  Login: Pi's github-copilot provider",
		`  API base: ${base}`,
		"",
		"Routing",
		`  GitHub Copilot models available in Pi: ${known.size}`,
		`  Auto endpoint: ${base}/auto (tier ${AUTO_TIER})`,
		`  Auto pick for a test prompt: ${probe}`,
		`  Last route: ${lastRoute}`,
	].join("\n");
}
