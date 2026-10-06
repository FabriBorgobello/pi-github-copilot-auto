/**
 * Copilot token lifecycle: reads Pi's stored github-copilot credential and
 * exchanges/caches the short-lived Copilot token.
 */
import { readFileSync } from "node:fs";
import { AUTH_PATH, COPILOT_HEADERS } from "./config.ts";
import {
	deriveApiBase,
	normalizeEnterpriseDomain,
	redactResponseBody,
	tokenExchangeUrl,
} from "./helpers.ts";
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
	enterpriseDomain: string | null;
}

export function getStoredCopilotStatus(): StoredCopilotStatus {
	const stored = readStoredCopilot();
	return {
		authPath: AUTH_PATH,
		hasAccessToken: Boolean(stored.access),
		accessTokenExpiresAtMs: stored.expires ?? null,
		hasRefreshToken: Boolean(stored.refresh),
		enterpriseDomain: normalizeEnterpriseDomain(stored.enterpriseUrl) ?? null,
	};
}

/** A Copilot token plus the API host it is valid for. */
export interface CopilotAuth {
	token: string;
	apiBase: string;
}

let cachedCopilotAuth: (CopilotAuth & { expires: number }) | null = null;

export async function getCopilotAuth(
	signal?: AbortSignal,
): Promise<CopilotAuth> {
	const now = Date.now();
	if (cachedCopilotAuth && cachedCopilotAuth.expires > now)
		return {
			token: cachedCopilotAuth.token,
			apiBase: cachedCopilotAuth.apiBase,
		};

	const stored = readStoredCopilot();
	const enterpriseDomain = normalizeEnterpriseDomain(stored.enterpriseUrl);
	// Reuse the still-valid stored Copilot token when present.
	if (stored.access && stored.expires && stored.expires > now) {
		const apiBase = deriveApiBase(stored.access, enterpriseDomain);
		cachedCopilotAuth = {
			token: stored.access,
			apiBase,
			expires: stored.expires,
		};
		return { token: stored.access, apiBase };
	}
	// Otherwise exchange the GitHub token for a fresh Copilot token.
	const res = await fetch(tokenExchangeUrl(enterpriseDomain), {
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${stored.refresh}`,
			...COPILOT_HEADERS,
		},
		signal,
	});
	if (!res.ok) {
		throw new Error(
			`Copilot Auto: token exchange failed ${res.status}: ${redactResponseBody(
				await res.text().catch(() => ""),
			)}`,
		);
	}
	const parsed = TokenExchangeSchema.safeParse(await res.json());
	if (!parsed.success) {
		throw new Error("Copilot Auto: invalid token exchange response");
	}
	const { token } = parsed.data;
	const apiBase = deriveApiBase(token, enterpriseDomain);
	cachedCopilotAuth = {
		token,
		apiBase,
		expires: parsed.data.expires_at * 1000 - 5 * 60 * 1000,
	};
	return { token, apiBase };
}
