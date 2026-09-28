/**
 * GitHub Copilot Auto — Pi provider extension
 *
 * Adds a single `github-copilot-auto/auto` model that uses
 * GitHub Copilot's server-side Auto routing. It forwards the
 * `Copilot-Session-Token` returned by POST /models/session on chat requests.
 *
 * Reuses the existing `github-copilot` login: reads Pi's stored credential from
 * ~/.pi/agent/auth.json (no second /login), refreshes the short-lived Copilot
 * token itself, then streams through Pi's matching built-in API.
 *
 * Usage: pi -e ~/pi-github-copilot-auto
 *
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AUTO_MODEL_ID, log, PROVIDER_ID } from "./config.ts";
import { runDoctor } from "./doctor.ts";
import { streamCopilotAuto } from "./stream.ts";

export default function (pi: ExtensionAPI) {
	let showRoute = (_model: string) => {};

	pi.on("session_start", (_event, ctx) => {
		showRoute = (model) => {
			ctx.ui.setStatus(
				"copilot-auto-route",
				ctx.ui.theme.fg("muted", `auto (${model})`),
			);
		};
	});
	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setStatus("copilot-auto-route", undefined);
	});
	pi.on("model_select", (event, ctx) => {
		if (event.model.provider !== PROVIDER_ID)
			ctx.ui.setStatus("copilot-auto-route", undefined);
	});

	pi.registerCommand("copilot-auto-doctor", {
		description: "Check Copilot Auto auth, token exchange, and Auto routing",
		handler: async (_args, ctx) => {
			try {
				const report = await runDoctor();
				log(`doctor ok\n${report}`);
				ctx.ui.notify(report, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				log(`doctor failed: ${message}`);
				ctx.ui.notify(`Copilot Auto doctor failed\n${message}`, "error");
			}
		},
	});

	pi.registerProvider(PROVIDER_ID, {
		name: "GitHub Copilot Auto",
		baseUrl: "https://api.individual.githubcopilot.com", // real base resolved per-request from the token
		apiKey: "copilot-auto", // literal so Pi treats the provider as authenticated; streamSimple uses the real token
		api: "openai-responses",
		models: [
			{
				id: AUTO_MODEL_ID,
				name: "Copilot Auto",
				reasoning: true,
				input: ["text", "image"],
				// Static 0 cost — Auto routes across models and provider billing is opaque.
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 400000,
				maxTokens: 128000,
			},
		],
		streamSimple: (m, context, options) =>
			streamCopilotAuto(m, context, options, showRoute),
	});
}
