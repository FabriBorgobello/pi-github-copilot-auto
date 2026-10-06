# pi-github-copilot-auto

A Pi extension that adds a single `github-copilot-auto/auto` model using GitHub Copilot's server-side Auto routing.

It reuses your existing `github-copilot` login from `~/.pi/agent/auth.json` and forwards the `Copilot-Session-Token` returned for the Auto session.

## Install

```bash
pi install npm:pi-github-copilot-auto
```

Run `/reload` in an active session to pick it up, or restart Pi.

## Use

1. Run `/login` in Pi and pick **GitHub Copilot**.
2. Open `/model` and choose **Copilot Auto**.
3. Optional: run `/copilot-auto-doctor` to verify auth, token exchange, and Auto routing.

Pi loads the extension from the package manifest in `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

## What it does

- Reads Pi's stored `github-copilot` credential.
- Exchanges the GitHub token for a short-lived Copilot token, against your GitHub Enterprise host when you logged in with one.
- Opens a `/models/session` Auto pool.
- Asks GitHub's intent router (`POST /models/session/intent`) which pool model fits the prompt, the way VS Code's Auto mode does.
- Falls back to the first pool model Pi already knows when the router is unavailable, times out (1 s), or returns nothing usable.
- Streams through Pi's matching built-in provider with the session token attached.

## How routing works

- The router sees only the text of your latest prompt plus a few signals (turn number, a random conversation id, previous model, prompt length). Tool output and earlier turns are never sent.
- The router is consulted on the first prompt of a conversation; its pick then sticks for the whole conversation, including every tool-call step. After `/compact` the next prompt is routed again.
- A candidate is used only if GitHub listed it in this session's pool and Pi can stream it. Anything else, and any router failure, uses the default route: the first supported model in GitHub's pool order.
- Prompts with images skip the router and take the default route, preferring a vision-capable pool model.
- The status line shows the source: `auto (gpt-5.4, router)` or `auto (gpt-5.4, default)`.

## Commands

- `/copilot-auto-doctor` — checks the stored login, token exchange, Auto session, available models, the default route, and the last router outcome seen in this process. It never routes a prompt itself.

## Runtime notes

- The Pi status line shows the model serving the conversation and whether the router or the default picked it.
- Route decisions (model, source, fallback reason) and Auto session details are logged to `~/.pi/agent/copilot-auto.log`. Prompt text and tokens are never logged.
- The package is shipped as TypeScript source; Pi loads it directly.

## Configuration

- `PI_COPILOT_AUTH` — override the auth file path. Default: `~/.pi/agent/auth.json`.

## Development

```bash
pi -e ./        # load this checkout directly
```

Run `/reload` after editing the source in an active session.

## Tests

```bash
pnpm test       # node --test over test/*.test.ts
pnpm check      # biome lint + format
```

The suite is network-free: `test/harness.ts` stubs `fetch` and redirects the
auth and log paths to a temporary directory. It covers the pure helpers, the
token exchange, the Auto session, the intent router client, the doctor report,
and the streaming path (router ranking, candidate filtering, fallback, timeout,
sticky routes, header forwarding, abort, and malformed streams). Behaviour owned by
Pi's built-in APIs this delegates to — tool calls, image input, Unicode
boundaries, context overflow — is covered by pi-ai's own suites.

## Troubleshooting

- **No `github-copilot` login found**: run `/login` and pick GitHub Copilot.
- **Auth file unreadable**: check `PI_COPILOT_AUTH` or `~/.pi/agent/auth.json`.
- **GitHub Enterprise**: the host comes from the `enterpriseUrl` Pi stores at `/login`; `/copilot-auto-doctor` shows it under "GitHub host".
- **`/models/session` fails**: GitHub may have changed the Copilot base URL, headers, or payload.
- **No matching model in pool**: the Auto pool returned model IDs Pi doesn't know yet.
- **Status line always says `default`**: check the "Last router outcome" line in `/copilot-auto-doctor`. A `router_error 404` means the intent endpoint is not enabled for your account (VS Code gates it behind an experiment too); the extension keeps working on the default route.
- **Cost display looks wrong**: Auto routing is opaque, so the provider is intentionally reported as zero-cost.

## Security

This package reads the stored Pi GitHub Copilot credential and exchanges it for a short-lived Copilot token. Review the source before installing it from third parties.

## Known limitations

- Provider billing is opaque; Pi reports this Auto model as zero-cost, so Pi's cost estimate may not match actual account usage.

## Upstream references

The Copilot Auto protocol is undocumented; this extension mirrors the open-source VS Code client. Diff against these when GitHub changes something:

- Intent router request/response and the 1 s timeout: [routerDecisionFetcher.ts](https://github.com/microsoft/vscode-copilot-chat/blob/main/src/platform/endpoint/node/routerDecisionFetcher.ts) in microsoft/vscode-copilot-chat.
- Routing cadence, fallback reasons, vision fallback: [automodeService.ts](https://github.com/microsoft/vscode-copilot-chat/blob/main/src/platform/endpoint/node/automodeService.ts).
- Endpoint paths (`/models/session`, `/models/session/intent`): [`@vscode/copilot-api`](https://www.npmjs.com/package/@vscode/copilot-api) (`capiAutoModelURL`, `capiModelRouterURL`).
- Request headers and the session-token flow: Pi's built-in `github-copilot` provider and [m0wer/opencode-github-copilot-auto-model](https://github.com/m0wer/opencode-github-copilot-auto-model), an OpenCode plugin for the same API.
- Provider extension contract: `docs/custom-provider.md` and `docs/extensions.md` in `@earendil-works/pi-coding-agent`.

Verified against vscode-copilot-chat commit `5863f5a` and `@vscode/copilot-api` 0.5.2 (October 2026).

## Compatibility guard

- If GitHub Auto routes to a future API family Pi does not expose yet, the extension fails clearly with the routed model and API instead of guessing how to stream it.
