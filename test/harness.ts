/**
 * Shared fixtures for the Copilot Auto tests.
 *
 * `redirectAgentDir()` must run before any `src/` module is imported, because
 * config.ts resolves LOG_PATH once at module init. Test files therefore call
 * it at top level and then `await import()` the module under test, rather
 * than importing it statically.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Point HOME, and with it the extension's log file and Pi's agent directory,
 * at a scratch directory so tests never touch the developer's real files.
 * Returns the scratch home.
 */
export function redirectAgentDir(): string {
	const home = mkdtempSync(join(tmpdir(), "copilot-auto-test-"));
	mkdirSync(join(home, ".pi", "agent"), { recursive: true });
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");
	process.on("exit", () => rmSync(home, { recursive: true, force: true }));
	return home;
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
 * Replace global fetch. The stub reproduces the two behaviours the abort and
 * timeout paths depend on: a fetch given an already-aborted signal rejects
 * with an AbortError rather than issuing a request, and a pending fetch
 * rejects with an AbortError as soon as its signal fires.
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
		const abortError = () =>
			new DOMException("The operation was aborted.", "AbortError");
		const signal = init?.signal;
		if (signal?.aborted) throw abortError();
		if (!signal) return handler(call);
		return new Promise<Response>((resolve, reject) => {
			signal.addEventListener("abort", () => reject(abortError()), {
				once: true,
			});
			Promise.resolve()
				.then(() => handler(call))
				.then(resolve, reject);
		});
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

export function sseResponse(body: string): Response {
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

const NOW_SECONDS = () => Math.floor(Date.now() / 1000);

/** An Auto session payload too near expiry to be cached. */
export function uncacheableSessionPayload(availableModels: string[]) {
	return {
		session_token: SAMPLE_SESSION_TOKEN,
		available_models: availableModels,
		discounted_costs: {},
		expires_at: NOW_SECONDS(),
	};
}

export const SAMPLE_COPILOT_TOKEN =
	"tid=deadbeefcafe;exp=1799999999;sku=copilot_individual;proxy-ep=proxy.individual.githubcopilot.com";
export const SAMPLE_SESSION_TOKEN = "session-token-abcdef";

/** A response that never arrives; pair it with a timeout or an abort. */
export function pendingResponse(): Promise<Response> {
	return new Promise<Response>(() => {});
}
export const EXPECTED_API_BASE = "https://api.individual.githubcopilot.com";

/**
 * A model registry holding Pi's github-copilot catalog, with or without a
 * login. Only the two methods the extension calls are implemented.
 */
export async function fakeRegistry(
	options: { login?: boolean; baseUrl?: string } = {},
) {
	const { getBuiltinModels } = await import(
		"@earendil-works/pi-ai/providers/all"
	);
	const { login = true, baseUrl = EXPECTED_API_BASE } = options;
	const models = getBuiltinModels("github-copilot");
	return {
		getAvailable: () => (login ? models : []),
		getApiKeyAndHeaders: async () =>
			login
				? { ok: true as const, apiKey: SAMPLE_COPILOT_TOKEN, baseUrl }
				: { ok: false as const, error: "No API key found." },
	};
}
