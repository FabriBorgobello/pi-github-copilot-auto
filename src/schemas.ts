/**
 * Zod schemas for the untrusted JSON payloads this extension parses:
 * the Auto session and the intent router's decision.
 * `.parse()` replaces the hand-rolled typeof / Array.isArray guards.
 */
import { z } from "zod";

/** POST /models/session */
export const AutoSessionSchema = z.object({
	session_token: z.string(),
	available_models: z.array(z.string()),
	discounted_costs: z.record(z.string(), z.number()).default({}),
	expires_at: z.number().optional(), // seconds epoch
});

/**
 * POST /models/session/intent — GitHub's intent router. Shape taken from
 * RouterDecisionResponse in
 * https://github.com/microsoft/vscode-copilot-chat/blob/main/src/platform/endpoint/node/routerDecisionFetcher.ts
 * `latency_ms` and `scores` are ignored; `predicted_label` is kept as a free
 * string so a new label does not invalidate the whole decision.
 */
export const RouterDecisionSchema = z.object({
	predicted_label: z.string(),
	confidence: z.number().optional(),
	candidate_models: z.array(z.string()),
	sticky_override: z.boolean().optional(),
});
export type RouterDecision = z.infer<typeof RouterDecisionSchema>;
