/**
 * Pure helpers for pi-github-copilot-auto — no pi-ai imports, so they unit-test standalone.
 */

/**
 * Pi stores the GitHub Enterprise host as `enterpriseUrl`, either a bare domain
 * or a URL. Reduce it to a hostname the way Pi's own Copilot login does.
 */
export function normalizeEnterpriseDomain(
	input: string | undefined,
): string | undefined {
	const trimmed = input?.trim();
	if (!trimmed) return undefined;
	try {
		return new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`)
			.hostname;
	} catch {
		return undefined;
	}
}

/** github.com -> https://api.github.com/copilot_internal/v2/token; GHE uses its own api.<domain>. */
export function tokenExchangeUrl(enterpriseDomain?: string): string {
	return `https://api.${enterpriseDomain ?? "github.com"}/copilot_internal/v2/token`;
}

/**
 * Token format: ...;proxy-ep=proxy.business.githubcopilot.com;... -> https://api.business.githubcopilot.com
 * Without a proxy-ep, GHE falls back to copilot-api.<domain>, as Pi's built-in provider does.
 */
export function deriveApiBase(
	copilotToken: string,
	enterpriseDomain?: string,
): string {
	const match = copilotToken.match(/proxy-ep=([^;]+)/);
	if (match) return `https://${match[1].replace(/^proxy\./, "api.")}`;
	if (enterpriseDomain) return `https://copilot-api.${enterpriseDomain}`;
	return "https://api.individual.githubcopilot.com";
}

/** Pick the first Auto-pool model that Pi knows and that streams via openai-completions (GPT/Codex family). */
export function pickAutoModel(
	availableModels: string[],
	completionModelIds: Set<string>,
): string | undefined {
	return availableModels.find((id) => completionModelIds.has(id));
}

/**
 * Provider error bodies are echoed into user-visible error messages, and the
 * token-exchange endpoint is exactly where a credential could appear in one.
 * Redact known token shapes and cap the length before surfacing a body.
 *
 * Per docs/custom-provider.md: "Never write access tokens, refresh tokens,
 * authorization headers, or complete provider responses to ordinary logs."
 */
const SECRET_JSON_FIELD =
	/"(access_token|refresh_token|session_token|token|authorization)"(\s*:\s*)"[^"]*"/gi;
const GITHUB_TOKEN = /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g;
const COPILOT_TOKEN = /\btid=[^\s"',]+/g;

export function redactResponseBody(body: string, maxLength = 200): string {
	const redacted = body
		.replace(
			SECRET_JSON_FIELD,
			(_match, field, separator) => `"${field}"${separator}"[redacted]"`,
		)
		.replace(GITHUB_TOKEN, "[redacted]")
		.replace(COPILOT_TOKEN, "tid=[redacted]");
	if (redacted.length <= maxLength) return redacted;
	return `${redacted.slice(0, maxLength)}... [truncated ${redacted.length - maxLength} chars]`;
}
