/**
 * Static config + logging for pi-github-copilot-auto.
 */
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PROVIDER_ID = "github-copilot-auto";
/**
 * Routing profile sent to POST /auto. It biases which models the router may
 * pick. VS Code offers efficiency, balance and intelligence in its picker,
 * defaulting to balance; `fast` is its inline-chat profile and is not offered
 * (autoModeTiers.ts).
 */
export type AutoTier = "efficiency" | "balance" | "intelligence";
export const AUTO_TIER: AutoTier = "balance";

/** The Auto models, one per tier. `auto` keeps the default tier. */
export const AUTO_MODELS: readonly {
	id: string;
	name: string;
	tier: AutoTier;
}[] = [
	{ id: "auto", name: "Copilot Auto", tier: AUTO_TIER },
	{
		id: "auto-efficiency",
		name: "Copilot Auto (Efficiency)",
		tier: "efficiency",
	},
	{
		id: "auto-intelligence",
		name: "Copilot Auto (Intelligence)",
		tier: "intelligence",
	},
];
/** Pi's built-in provider whose models and login the Auto model routes to. */
export const COPILOT_PROVIDER_ID = "github-copilot";
// The version @vscode/copilot-api 0.5.2 sends on every Copilot API request.
// Copilot ignores the Auto session token on a chat request without one.
export const COPILOT_API_VERSION = "2026-08-01";

// Same client identity the built-in github-copilot provider sends. Copilot-Integration-Id
// is the gate for the Auto endpoint; reuse the value that already works for chat.
export const COPILOT_HEADERS: Record<string, string> = {
	"User-Agent": "GitHubCopilotChat/0.35.0",
	"Editor-Version": "vscode/1.107.0",
	"Editor-Plugin-Version": "copilot-chat/0.35.0",
	"Copilot-Integration-Id": "vscode-chat",
	"X-GitHub-Api-Version": COPILOT_API_VERSION,
};

const LOG_PATH = join(homedir(), ".pi", "agent", "copilot-auto.log");

export function log(msg: string): void {
	try {
		appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`, "utf8");
	} catch {
		/* logging is best-effort */
	}
}
