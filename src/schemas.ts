/**
 * Zod schemas for the untrusted JSON payloads this extension parses.
 * `.parse()` replaces the hand-rolled typeof / Array.isArray guards.
 */
import { z } from "zod";

/**
 * POST /auto — GitHub's single-call Auto endpoint. Shape taken from
 * AutoV2Response in microsoft/vscode extensions/copilot
 * src/platform/endpoint/node/autoV2Fetcher.ts. Only the fields the extension
 * reads are kept; `selection_reason` stays a free string so a new value does
 * not invalidate the whole decision.
 */
export const AutoDecisionSchema = z.object({
	session_token: z.string(),
	expires_at: z.number(), // seconds epoch; the token lasts 24 h, no refresh
	selected_model: z.object({ id: z.string() }),
	selection_reason: z.string().optional(),
});
export type AutoDecisionPayload = z.infer<typeof AutoDecisionSchema>;
