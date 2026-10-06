/**
 * GitHub Copilot Auto — Pi provider extension
 *
 * Adds a single `github-copilot-auto/auto` model that uses
 * GitHub Copilot's server-side Auto routing: the Auto session's model pool,
 * the intent router's pick for the conversation, and the
 * `Copilot-Session-Token` returned by POST /models/session on chat requests.
 *
 * Reuses the existing `github-copilot` login: reads Pi's stored credential from
 * ~/.pi/agent/auth.json (no second /login), refreshes the short-lived Copilot
 * token itself, then streams through Pi's matching built-in API.
 *
 * Install: pi install npm:pi-github-copilot-auto
 * Local development: pi -e ./ (then /reload after editing this source)
 *
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { AUTO_MODEL_ID, log, PROVIDER_ID } from "./config.ts";
import { runDoctor } from "./doctor.ts";
import { AutoRouter, type RouteDecision } from "./router.ts";
import { streamCopilotAuto } from "./stream.ts";

const STATUS_KEY = "copilot-auto-route";

export default function (pi: ExtensionAPI) {
	// Held only between session_start and session_shutdown. Session replacement
	// invalidates the old context, so it is dropped on shutdown rather than
	// captured for the lifetime of the extension runtime.
	let session: ExtensionContext | undefined;
	// Routing state is per conversation: reset with the session, invalidated
	// after compaction so the next prompt is routed again.
	const router = new AutoRouter();

	// setStatus writes the interactive footer; RPC, JSON and print modes have no
	// status bar, so the whole route indicator is guarded on mode === "tui".
	const showRoute = (decision: RouteDecision) => {
		if (session?.mode !== "tui") return;
		session.ui.setStatus(
			STATUS_KEY,
			session.ui.theme.fg(
				"muted",
				`auto (${decision.model}, ${decision.source})`,
			),
		);
	};
	const clearRoute = () => {
		if (session?.mode === "tui") session.ui.setStatus(STATUS_KEY, undefined);
	};

	pi.on("session_start", (_event, ctx) => {
		session = ctx;
		router.reset();
	});
	pi.on("session_shutdown", () => {
		// Idempotent: cancellation, reload, session replacement and process exit
		// can all converge here.
		clearRoute();
		router.reset();
		session = undefined;
	});
	pi.on("session_compact", () => {
		// VS Code re-routes after compaction (invalidateRouterCache); the
		// summarised conversation may call for a different model.
		router.invalidate();
	});
	pi.on("model_select", (event) => {
		if (event.model.provider !== PROVIDER_ID) clearRoute();
	});

	pi.registerCommand("copilot-auto-doctor", {
		description: "Check Copilot Auto auth, token exchange, and Auto routing",
		handler: async (_args, ctx) => {
			try {
				const report = await runDoctor(router);
				log(`doctor ok\n${report}`);
				// notify reaches interactive and RPC clients; elsewhere the log file
				// is the only channel.
				if (ctx.hasUI) ctx.ui.notify(report, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				log(`doctor failed: ${message}`);
				if (ctx.hasUI)
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
			streamCopilotAuto(m, context, options, { router, onRoute: showRoute }),
	});
}
