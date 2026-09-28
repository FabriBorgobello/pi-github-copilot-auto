/**
 * Copilot token lifecycle: reads Pi's stored github-copilot credential and
 * exchanges/caches the short-lived Copilot token.
 */
import { readFileSync } from "node:fs";
import { AUTH_PATH, COPILOT_HEADERS, TOKEN_EXCHANGE_URL } from "./config.ts";
import { StoredCopilotSchema, TokenExchangeSchema } from "./schemas.ts";

function readStoredCopilot() {
	let raw: string;
	try {
		raw = readFileSync(AUTH_PATH, "utf8");
	} catch {
		throw new Error(
			`Copilot Auto: cannot read ${AUTH_PATH}. Run /login and pick GitHub Copilot first.`,
		);
	}
	const entry = (JSON.parse(raw) as Record<string, unknown>)["github-copilot"];
	const parsed = StoredCopilotSchema.safeParse(entry);
	if (!parsed.success) {
		throw new Error(
			"Copilot Auto: no github-copilot login found. Run /login and pick GitHub Copilot.",
		);
	}
	return parsed.data;
}

export interface StoredCopilotStatus {
	authPath: string;
	hasAccessToken: boolean;
	accessTokenExpiresAtMs: number | null;
	hasRefreshToken: boolean;
}

export function getStoredCopilotStatus(): StoredCopilotStatus {
	const stored = readStoredCopilot();
	return {
		authPath: AUTH_PATH,
		hasAccessToken: Boolean(stored.access),
		accessTokenExpiresAtMs: stored.expires ?? null,
		hasRefreshToken: Boolean(stored.refresh),
	};
}

let cachedCopilotToken: { token: string; expires: number } | null = null;

export async function getCopilotToken(signal?: AbortSignal): Promise<string> {
	const now = Date.now();
	if (cachedCopilotToken && cachedCopilotToken.expires > now)
		return cachedCopilotToken.token;

	const stored = readStoredCopilot();
	// Reuse the still-valid stored Copilot token when present.
	if (stored.access && stored.expires && stored.expires > now) {
		cachedCopilotToken = { token: stored.access, expires: stored.expires };
		return stored.access;
	}
	// Otherwise exchange the GitHub token for a fresh Copilot token.
	const res = await fetch(TOKEN_EXCHANGE_URL, {
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${stored.refresh}`,
			...COPILOT_HEADERS,
		},
		signal,
	});
	if (!res.ok) {
		throw new Error(
			`Copilot Auto: token exchange failed ${res.status}: ${await res.text().catch(() => "")}`,
		);
	}
	const parsed = TokenExchangeSchema.safeParse(await res.json());
	if (!parsed.success) {
		throw new Error("Copilot Auto: invalid token exchange response");
	}
	cachedCopilotToken = {
		token: parsed.data.token,
		expires: parsed.data.expires_at * 1000 - 5 * 60 * 1000,
	};
	return parsed.data.token;
}
