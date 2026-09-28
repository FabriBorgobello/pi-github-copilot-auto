/**
 * Pure helpers for pi-github-copilot-auto — no pi-ai imports, so they unit-test standalone.
 */

/** Token format: ...;proxy-ep=proxy.business.githubcopilot.com;... -> https://api.business.githubcopilot.com */
export function deriveApiBase(copilotToken: string): string {
	const match = copilotToken.match(/proxy-ep=([^;]+)/);
	if (!match) return "https://api.individual.githubcopilot.com";
	return `https://${match[1].replace(/^proxy\./, "api.")}`;
}

/** Pick the first Auto-pool model that Pi knows and that streams via openai-completions (GPT/Codex family). */
export function pickAutoModel(
	availableModels: string[],
	completionModelIds: Set<string>,
): string | undefined {
	return availableModels.find((id) => completionModelIds.has(id));
}
