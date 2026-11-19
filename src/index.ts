/**
 * GitHub Copilot Auto — Pi virtual model extension
 *
 * Adds a `github-copilot-auto/auto` virtual model that uses GitHub Copilot's
 * server-side Auto routing: POST /auto picks the model for the
 * conversation and mints the `Copilot-Session-Token` sent on its chat
 * requests.
 *
 * Each request is routed to one of Pi's built-in github-copilot models, so Pi
 * owns the login, token refresh, streaming, cost and context limits, and
 * records the model that actually answered. See docs/virtual-models.md in
 * @earendil-works/pi-coding-agent for the contract.
 *
 * Install: pi install npm:pi-github-copilot-auto
 * Local development: pi -e ./ (then /reload after editing this source)
 *
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { copilotModels, getCopilotAuth } from "./auth.ts";
import {
	AUTO_MODELS,
	COPILOT_API_VERSION,
	log,
	PROVIDER_ID,
} from "./config.ts";
import { runDoctor } from "./doctor.ts";
import { AutoRouter, type AutoRouteState } from "./router.ts";

const SESSION_TOKEN_HEADER = "Copilot-Session-Token";

function isAutoModel(model: { provider: string; id: string } | undefined) {
	return (
		model?.provider === PROVIDER_ID &&
		AUTO_MODELS.some((auto) => auto.id === model.id)
	);
}

export default function (pi: ExtensionAPI) {
	const router = new AutoRouter();
	// Session token of the latest route. Every
	// request Pi makes while Auto is selected is routed through route() first,
	// though not always immediately before its headers: threshold compaction
	// can run its own routed request in between. So the token is kept for as
	// long as Auto is selected rather than handed to a single request.
	let sessionToken: string | undefined;

	pi.on("session_start", () => {
		router.reset();
	});
	pi.on("session_shutdown", () => {
		// Idempotent: cancellation, reload, session replacement and process exit
		// can all converge here.
		router.reset();
		sessionToken = undefined;
	});
	pi.on("session_compact", () => {
		// VS Code re-routes after compaction (invalidateRouterCache); the
		// summarised conversation may call for a different model.
		router.invalidate();
	});
	pi.on("model_select", (event) => {
		if (!isAutoModel(event.model)) sessionToken = undefined;
	});
	pi.on("before_provider_headers", (event, ctx) => {
		// The hook does not name the request's model. While Auto is selected,
		// Pi's session requests all go through route(), which only returns
		// github-copilot models, so the token never reaches another provider.
		// Copilot ignores the session token on a request without an API version
		// and treats it as a hand-picked model, which Auto-only plans (Free,
		// Education) reject with model_not_supported. Pi's chat requests send none.
		if (sessionToken && isAutoModel(ctx.model)) {
			event.headers[SESSION_TOKEN_HEADER] = sessionToken;
			event.headers["X-GitHub-Api-Version"] = COPILOT_API_VERSION;
		}
	});

	pi.registerCommand("copilot-auto-doctor", {
		description: "Check Copilot Auto auth, token exchange, and Auto routing",
		handler: async (_args, ctx) => {
			try {
				const report = await runDoctor(ctx.modelRegistry, router);
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

	for (const auto of AUTO_MODELS)
		pi.registerVirtualModel<AutoRouteState>({
			provider: PROVIDER_ID,
			id: auto.id,
			name: auto.name,
			// Passed through to the routed model; Pi clamps it to what that model supports.
			thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"],
			// Shown until the first response; Pi then uses the routed model's limits.
			contextWindow: 400000,
			maxTokens: 128000,
			input: ["text", "image"],
			async route(request, ctx) {
				const registry = ctx.modelRegistry;
				const { token, apiBase } = await getCopilotAuth(registry);
				const known = copilotModels(registry);
				const route = await router.resolve({
					base: apiBase,
					copilotToken: token,
					messages: request.messages,
					known,
					tier: auto.tier,
					reason: request.reason,
					state: request.state,
					signal: request.signal,
				});
				// resolve() only returns models in `known`.
				const model = known.get(route.model);
				if (!model) {
					throw new Error(
						`Copilot Auto: selected model ${route.model} is missing from Pi's catalog.`,
					);
				}
				sessionToken = route.sessionToken;
				return {
					model,
					thinkingLevel: request.thinkingLevel,
					state: route.state,
				};
			},
		});
}
