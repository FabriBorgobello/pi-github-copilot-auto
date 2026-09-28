import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { getCopilotToken, getStoredCopilotStatus } from "./auth.ts";
import { deriveApiBase, pickAutoModel } from "./helpers.ts";
import { supportedCopilotModelIds } from "./model-support.ts";
import { getAutoSession } from "./session.ts";

export async function runDoctor(): Promise<string> {
	const stored = getStoredCopilotStatus();
	const token = await getCopilotToken();
	const base = deriveApiBase(token);
	const session = await getAutoSession(base, token);
	const supported = supportedCopilotModelIds();
	const allKnown = getBuiltinModels("github-copilot");
	const matches = session.availableModels.filter((id) => supported.has(id));
	const selected = pickAutoModel(session.availableModels, supported) ?? "none";
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
		"",
		"Routing",
		`  API base: ${base}`,
		`  Known GitHub Copilot models in Pi: ${allKnown.length}`,
		`  Supported for Auto streaming here: ${supported.size}`,
		`  Auto pool returned by GitHub: ${session.availableModels.length}`,
		`  Auto pool models: ${list(session.availableModels)}`,
		`  Pi-supported matches in pool: ${matches.length}`,
		`  Matching models: ${list(matches)}`,
		`  Selected route: ${selected}`,
	].join("\n");
}
