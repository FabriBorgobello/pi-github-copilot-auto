/**
 * Auto session lifecycle: opens and caches POST /models/session, which returns
 * the model pool + the Copilot-Session-Token used for chat requests.
 */
import { AUTO_MODEL_ID, COPILOT_HEADERS, log } from "./config.ts";
import { AutoSessionSchema } from "./schemas.ts";

export interface AutoSession {
	sessionToken: string;
	availableModels: string[];
	discountedCosts: Record<string, number>;
	expiresAtMs: number;
}

let cachedSession: AutoSession | null = null;

export async function getAutoSession(
	base: string,
	copilotToken: string,
	signal?: AbortSignal,
): Promise<AutoSession> {
	const now = Date.now();
	if (cachedSession && cachedSession.expiresAtMs - now > 5 * 60 * 1000)
		return cachedSession;

	const res = await fetch(`${base}/models/session`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${copilotToken}`,
			"Content-Type": "application/json",
			...COPILOT_HEADERS,
		},
		body: JSON.stringify({ auto_mode: { model_hints: [AUTO_MODEL_ID] } }),
		signal,
	});
	if (!res.ok) {
		throw new Error(
			`Copilot Auto: /models/session ${res.status}: ${await res.text().catch(() => "")}`,
		);
	}
	const parsed = AutoSessionSchema.safeParse(await res.json());
	if (!parsed.success) {
		throw new Error("Copilot Auto: invalid /models/session payload");
	}
	const data = parsed.data;
	cachedSession = {
		sessionToken: data.session_token,
		availableModels: data.available_models,
		discountedCosts: data.discounted_costs,
		expiresAtMs:
			data.expires_at != null ? data.expires_at * 1000 : now + 25 * 60 * 1000,
	};
	log(
		`session opened: available=[${cachedSession.availableModels.join(", ")}] discounted_costs=${JSON.stringify(cachedSession.discountedCosts)}`,
	);
	return cachedSession;
}
