# pi-github-copilot-auto

A Pi extension that adds a `github-copilot-auto/auto` [virtual model](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/virtual-models.md) using GitHub Copilot's server-side Auto routing.

Each request is routed to one of Pi's built-in `github-copilot` models, using your existing GitHub Copilot login, with the `Copilot-Session-Token` of the Auto session attached.

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

- Registers `github-copilot-auto/auto` as a Pi virtual model.
- Borrows the Copilot token and API host from Pi's `github-copilot` provider, which owns login, refresh, and GitHub Enterprise.
- Opens a `/models/session` Auto pool.
- Asks GitHub's intent router (`POST /models/session/intent`) which pool model fits the prompt, the way VS Code's Auto mode does.
- Falls back to the first pool model available in Pi when the router is unavailable, times out (1 s), or returns nothing usable.
- Hands the chosen `github-copilot/<model>` back to Pi, which streams it and records it as the model that answered; a `before_provider_headers` hook adds the session token.

## How routing works

- The router sees only the text of your latest prompt plus a few signals (turn number, a random conversation id, previous model, prompt length). Tool output and earlier turns are never sent.
- The router is consulted on the first prompt of a conversation; its pick then sticks for the whole conversation, including every tool-call step. The pick is stored as Pi router state, so it survives resume and follows forks and `/tree`. After `/compact` the next prompt is routed again, as it is when the picked model leaves the pool.
- Requests outside the agent loop, such as compaction summaries, stay on the model that answered last.
- A candidate is used only if GitHub listed it in this session's pool and it is available to your Copilot login in Pi. Anything else, and any router failure, uses the default route: the first such model in GitHub's pool order.
- Prompts with images skip the router and take the default route, preferring a vision-capable pool model.
- Pi's footer shows the routed model (`auto → gpt-5.4`). Whether the router or the default route picked it is in the log and in `/copilot-auto-doctor`.

## Commands

- `/copilot-auto-doctor` — checks the Copilot login in Pi, the Auto session, available models, the default route, and the last router outcome seen in this process. It never routes a prompt itself.

## Runtime notes

- Responses are recorded under the physical model that answered, so `/session` costs, context limits, and compaction use that model's real values.
- Route decisions (model, source, fallback reason) and Auto session details are logged to `~/.pi/agent/copilot-auto.log`. Prompt text and tokens are never logged.
- The package is shipped as TypeScript source; Pi loads it directly.

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

The suite is network-free: `test/harness.ts` stubs `fetch` and redirects HOME
to a temporary directory. It covers the pure helpers, the auth lookup, the Auto
session, the intent router client, the routing policy (ranking, candidate
filtering, fallback, timeout, cancellation, sticky routes, re-routing, direct
requests, images), and the doctor report. `test/extension.test.ts` runs the
extension inside a real Pi SDK session to check routing, the recorded model,
the session-token header, router state, compaction, and model switching.
Streaming, tool calls, and token refresh belong to Pi's built-in
`github-copilot` provider and are covered by Pi's own suites.

## Troubleshooting

- **No GitHub Copilot login found**: run `/login` and pick GitHub Copilot.
- **GitHub Enterprise**: Pi's `github-copilot` provider derives the API host from your login; `/copilot-auto-doctor` shows it under "API base".
- **`/models/session` fails**: GitHub may have changed the Copilot base URL, headers, or payload.
- **No matching model in pool**: the Auto pool returned model IDs Pi doesn't know yet, or that your Copilot login in Pi does not list.
- **Status line always says `default`**: check the "Last router outcome" line in `/copilot-auto-doctor`. A `router_error 404` means the intent endpoint is not enabled for your account (VS Code gates it behind an experiment too); the extension keeps working on the default route.

## Security

This package uses the Copilot token of Pi's `github-copilot` provider and adds the Auto session token to chat requests while Copilot Auto is selected. Review the source before installing it from third parties.

## Known limitations

- Pi estimates cost from each model's list price; it does not apply the Auto discount GitHub reports in `discounted_costs`.
- Pi's `before_provider_headers` hook does not name the request's model, so the session token is attached to every request Pi makes while Copilot Auto is selected. All of them are routed to `github-copilot` models.

## Upstream references

The Copilot Auto protocol is undocumented; this extension mirrors the open-source VS Code client. Diff against these when GitHub changes something:

- Intent router request/response and the 1 s timeout: [routerDecisionFetcher.ts](https://github.com/microsoft/vscode-copilot-chat/blob/main/src/platform/endpoint/node/routerDecisionFetcher.ts) in microsoft/vscode-copilot-chat.
- Routing cadence, fallback reasons, vision fallback: [automodeService.ts](https://github.com/microsoft/vscode-copilot-chat/blob/main/src/platform/endpoint/node/automodeService.ts).
- Endpoint paths (`/models/session`, `/models/session/intent`): [`@vscode/copilot-api`](https://www.npmjs.com/package/@vscode/copilot-api) (`capiAutoModelURL`, `capiModelRouterURL`).
- Request headers and the session-token flow: Pi's built-in `github-copilot` provider and [m0wer/opencode-github-copilot-auto-model](https://github.com/m0wer/opencode-github-copilot-auto-model), an OpenCode plugin for the same API.
- Virtual model and hook contract: `docs/virtual-models.md` (route reasons, router state) and `docs/extensions.md` (`before_provider_headers`, `session_compact`) in `@earendil-works/pi-coding-agent` 1.5.0.

Verified against vscode-copilot-chat commit `5863f5a` and `@vscode/copilot-api` 0.5.2 (October 2026). microsoft/vscode-copilot-chat was archived in May 2026; the Copilot client now lives in [microsoft/vscode](https://github.com/microsoft/vscode) under `extensions/copilot`, so diff future changes there.

## Compatibility

- Requires Pi 1.5.0 or later (`pi.registerVirtualModel`).
- Sessions answered by earlier versions of this extension record `github-copilot-auto/auto` on old responses; Pi treats them as unknown models and routes the next prompt normally.
