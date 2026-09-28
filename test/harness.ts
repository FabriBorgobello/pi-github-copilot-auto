/**
 * Shared fixtures for the Copilot Auto tests.
 *
 * `redirectAgentDir()` must run before any `src/` module is imported, because
 * config.ts resolves AUTH_PATH and LOG_PATH once at module init. Test files
 * therefore call it at top level and then `await import()` the module under
 * test, rather than importing it statically.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Point the extension's auth file and log file at a scratch directory so tests
 * never read the developer's real credential or append to their real log.
 */
export function redirectAgentDir(): string {
	const home = mkdtempSync(join(tmpdir(), "copilot-auto-test-"));
	mkdirSync(join(home, ".pi", "agent"), { recursive: true });
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	const authPath = join(home, ".pi", "agent", "auth.json");
	process.env.PI_COPILOT_AUTH = authPath;
	process.on("exit", () => rmSync(home, { recursive: true, force: true }));
	return authPath;
}

/** Write the `github-copilot` entry Pi would have stored after /login. */
export function writeStoredCopilot(authPath: string, entry: unknown): void {
	writeFileSync(authPath, JSON.stringify({ "github-copilot": entry }), "utf8");
}

/** Remove the auth file entirely, as if the user had never run /login. */
export function clearStoredCopilot(authPath: string): void {
	rmSync(authPath, { force: true });
}

export interface StubbedCall {
	url: string;
	init: RequestInit | undefined;
	headers: Record<string, string>;
}

export interface FetchStub {
	calls: StubbedCall[];
	restore(): void;
}

/**
 * Replace global fetch. The stub reproduces the one behaviour the abort path
 * depends on: a fetch given an already-aborted signal rejects with an
 * AbortError rather than issuing a request.
 */
export function stubFetch(
	handler: (call: StubbedCall) => Response | Promise<Response>,
): FetchStub {
	const original = globalThis.fetch;
	const calls: StubbedCall[] = [];
	globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: (input as Request).url;
		// init.headers may be a plain object, an entry array, or a Headers
		// instance depending on which built-in API assembled the request.
		const headers: Record<string, string> = {};
		for (const [key, value] of new Headers(
			(init?.headers ?? {}) as ConstructorParameters<typeof Headers>[0],
		).entries())
			headers[key.toLowerCase()] = value;
		const call: StubbedCall = { url, init, headers };
		calls.push(call);
		if (init?.signal?.aborted)
			throw new DOMException("The operation was aborted.", "AbortError");
		return handler(call);
	}) as typeof globalThis.fetch;
	return {
		calls,
		restore() {
			globalThis.fetch = original;
		},
	};
}

export function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

export function textResponse(body: string, status = 500): Response {
	return new Response(body, { status });
}

const NOW_SECONDS = () => Math.floor(Date.now() / 1000);

/**
 * A token-exchange payload whose expiry is too near to be cached. Most tests
 * want every call to re-fetch, so a warm module-level cache cannot silently
 * satisfy an assertion about request count.
 */
export function uncacheableTokenPayload(token = SAMPLE_COPILOT_TOKEN) {
	return { token, expires_at: NOW_SECONDS() };
}

/** An Auto session payload too near expiry to be cached. */
export function uncacheableSessionPayload(availableModels: string[]) {
	return {
		session_token: SAMPLE_SESSION_TOKEN,
		available_models: availableModels,
		discounted_costs: {},
		expires_at: NOW_SECONDS(),
	};
}

export const SAMPLE_GITHUB_TOKEN = "gho_16CharactersLongToken0000000000";
export const SAMPLE_COPILOT_TOKEN =
	"tid=deadbeefcafe;exp=1799999999;sku=copilot_individual;proxy-ep=proxy.individual.githubcopilot.com";
export const SAMPLE_SESSION_TOKEN = "session-token-abcdef";
export const EXPECTED_API_BASE = "https://api.individual.githubcopilot.com";
