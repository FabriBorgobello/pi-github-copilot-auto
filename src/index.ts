/**
 * GitHub Copilot Auto — Pi virtual model extension
 *
 * Adds a `github-copilot-auto/auto` virtual model that uses GitHub Copilot's
 * server-side Auto routing: the Auto session's model pool, the intent
 * router's pick for the conversation, and the `Copilot-Session-Token`
 * returned by POST /models/session on chat requests.
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

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { copilotModels, getCopilotAuth } from "./auth.ts";
import {
	AUTO_MODEL_ID,
	COPILOT_PROVIDER_ID,
	log,
	PROVIDER_ID,
} from "./config.ts";
import { runDoctor } from "./doctor.ts";
import {
	AutoRouter,
	type AutoRouteState,
	type RouteDecision,
} from "./router.ts";
import { getAutoSession } from "./session.ts";

const STATUS_KEY = "copilot-auto-route";
const SESSION_TOKEN_HEADER = "Copilot-Session-Token";

function isAutoModel(model: { provider: string; id: string } | undefined) {
	return model?.provider === PROVIDER_ID && model.id === AUTO_MODEL_ID;
}

export default function (pi: ExtensionAPI) {
	// Held only between session_start and session_shutdown. Session replacement
	// invalidates the old context, so it is dropped on shutdown rather than
	// captured for the lifetime of the extension runtime.
	let session: ExtensionContext | undefined;
	const router = new AutoRouter();
	// Session token of the Auto session the latest route came from. Every
	// request Pi makes while Auto is selected is routed through route() first,
	// though not always immediately before its headers: threshold compaction
	// can run its own routed request in between. So the token is kept for as
	// long as Auto is selected rather than handed to a single request.
	let sessionToken: string | undefined;

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
		sessionToken = undefined;
		session = undefined;
	});
	pi.on("session_compact", () => {
		// VS Code re-routes after compaction (invalidateRouterCache); the
		// summarised conversation may call for a different model.
		router.invalidate();
	});
	pi.on("model_select", (event) => {
		if (!isAutoModel(event.model)) {
			clearRoute();
			sessionToken = undefined;
		}
	});
	pi.on("before_provider_headers", (event, ctx) => {
		// The hook does not name the request's model. While Auto is selected,
		// Pi's session requests all go through route(), which only returns
		// github-copilot models, so the token never reaches another provider.
		if (sessionToken && isAutoModel(ctx.model))
			event.headers[SESSION_TOKEN_HEADER] = sessionToken;
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

	pi.registerVirtualModel<AutoRouteState>({
		provider: PROVIDER_ID,
		id: AUTO_MODEL_ID,
		name: "Copilot Auto",
		// Passed through to the routed model; Pi clamps it to what that model supports.
		thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"],
		// Shown until the first response; Pi then uses the routed model's limits.
		contextWindow: 400000,
		maxTokens: 128000,
		input: ["text", "image"],
		async route(request, ctx) {
			const registry = ctx.modelRegistry;
			const { token, apiBase } = await getCopilotAuth(registry);
			const auto = await getAutoSession(apiBase, token, request.signal);
			const known = copilotModels(registry);
			const previous = request.previous?.model;
			const route = await router.resolve({
				base: apiBase,
				copilotToken: token,
				session: auto,
				messages: request.messages,
				known,
				reason: request.reason,
				state: request.state,
				previousModel:
					previous?.provider === COPILOT_PROVIDER_ID ? previous.id : undefined,
				signal: request.signal,
			});
			if (!route) {
				throw new Error(
					`Copilot Auto: no model in the Auto pool is available to your GitHub Copilot login in Pi. Pool: [${auto.availableModels.join(", ")}]`,
				);
			}
			// resolve() only returns ids from the pool ∩ known.
			const model = known.get(route.model);
			if (!model) {
				throw new Error(
					`Copilot Auto: selected model ${route.model} is missing from Pi's catalog.`,
				);
			}
			sessionToken = auto.sessionToken;
			if (route.decision) showRoute(route.decision);
			return {
				model,
				thinkingLevel: request.thinkingLevel,
				state: route.state,
			};
		},
	});
}
