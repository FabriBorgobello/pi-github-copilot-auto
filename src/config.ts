/**
 * Static config + logging for pi-github-copilot-auto.
 */
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PROVIDER_ID = "github-copilot-auto";
export const AUTO_MODEL_ID = "auto";
const COPILOT_API_VERSION = "2026-06-01";

// Same client identity the built-in github-copilot provider sends. Copilot-Integration-Id
// is the gate for the /models/session endpoints; reuse the value that already works for chat.
export const COPILOT_HEADERS: Record<string, string> = {
	"User-Agent": "GitHubCopilotChat/0.35.0",
	"Editor-Version": "vscode/1.107.0",
	"Editor-Plugin-Version": "copilot-chat/0.35.0",
	"Copilot-Integration-Id": "vscode-chat",
	"X-GitHub-Api-Version": COPILOT_API_VERSION,
};

export const TOKEN_EXCHANGE_URL =
	"https://api.github.com/copilot_internal/v2/token";
export const AUTH_PATH =
	process.env.PI_COPILOT_AUTH || join(homedir(), ".pi", "agent", "auth.json");
const LOG_PATH = join(homedir(), ".pi", "agent", "copilot-auto.log");

export function log(msg: string): void {
	try {
		appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`, "utf8");
	} catch {
		/* logging is best-effort */
	}
}
