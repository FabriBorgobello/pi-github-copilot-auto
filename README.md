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
- Asks GitHub's Auto endpoint (`POST /auto`) which model fits the prompt, the way VS Code's Auto mode does. The answer carries the picked model and a session token bound to it.
- Hands the chosen `github-copilot/<model>` back to Pi, which streams it and records it as the model that answered; a `before_provider_headers` hook adds the session token and the API version Copilot needs to honour it.

## How routing works

- `/auto` sees only the text of your latest prompt, the routing tier (`balance`, VS Code's default) and whether an image is attached. Tool output and earlier turns are never sent.
- `/auto` is asked on the first prompt of a conversation; its pick then sticks for the whole conversation, including every tool-call step. After `/compact` the next prompt is routed again, as is a prompt that attaches an image the current model cannot take.
- The picked model is stored as Pi router state, so it follows forks and `/tree`. The session token (valid 24 hours) is kept in memory only and never written to the session file, so a conversation resumed in a new Pi process asks `/auto` again and may land on a different model.
- Requests outside the agent loop, such as compaction summaries, stay on the latest route.
- If `/auto` fails, the conversation keeps its current route while that is still valid and able to take the prompt's images. Otherwise the request fails with `/auto`'s error: there is no fallback model, because plans that only allow Auto (Free, Education) can't use any other.
- Pi's footer shows the routed model (`auto → mai-code-2-flash`).

## Commands

- `/copilot-auto-doctor` — checks the Copilot login in Pi, asks `/auto` to route a fixed test prompt (no model runs), says whether Pi can serve the pick, and shows the last route seen in this process.

## Runtime notes

- Responses are recorded under the physical model that answered, so `/session` costs, context limits, and compaction use that model's real values.
- Route decisions (model and `/auto`'s reason) and routing failures are logged to `~/.pi/agent/copilot-auto.log`. Prompt text and tokens are never logged.
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
to a temporary directory. It covers the pure helpers, the auth lookup, the
`/auto` client, the routing policy (sticky routes, re-routing, resume, failure
handling, timeout, cancellation, direct requests, images), and the doctor
report. `test/extension.test.ts` runs the
extension inside a real Pi SDK session to check routing, the recorded model,
the session-token header, router state, compaction, and model switching.
Streaming, tool calls, and token refresh belong to Pi's built-in
`github-copilot` provider and are covered by Pi's own suites.

## Troubleshooting

- **No GitHub Copilot login found**: run `/login` and pick GitHub Copilot.
- **GitHub Enterprise**: Pi's `github-copilot` provider derives the API host from your login; `/copilot-auto-doctor` shows it under "API base".
- **`/auto` fails**: the doctor's "Auto pick" line shows the status and body. GitHub may have changed the Copilot base URL, headers, or payload.
- **Auto picked a model Pi does not list**: run `pi update` to refresh Pi's model catalog.
- **`model_not_supported`**: Copilot did not accept the session token for the routed model. Check that you run this version or later; earlier versions did not send the API version header that Copilot requires to read the token.

## Security

This package uses the Copilot token of Pi's `github-copilot` provider and adds the Auto session token to chat requests while Copilot Auto is selected. Review the source before installing it from third parties.

## Known limitations

- Pi estimates cost from each model's list price; it does not apply any Auto discount.
- The routing tier is fixed at `balance`.
- Pi's `before_provider_headers` hook does not name the request's model, so the session token is attached to every request Pi makes while Copilot Auto is selected. All of them are routed to `github-copilot` models.

## Upstream references

The Copilot Auto protocol is undocumented; this extension mirrors the open-source VS Code client. Diff against these when GitHub changes something:

- `/auto` request/response and the 5 s timeout: [autoV2Fetcher.ts](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/platform/endpoint/node/autoV2Fetcher.ts).
- Routing cadence, re-route after compaction, reuse of the last route on failure, vision check on a kept route (`_isCacheEntryCompatible`): [automodeService.ts](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/platform/endpoint/node/automodeService.ts).
- Tiers and the `balance` default: [autoModeTiers.ts](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/platform/endpoint/common/autoModeTiers.ts).
- Endpoint path and API version (`2026-08-01`): [`@vscode/copilot-api`](https://www.npmjs.com/package/@vscode/copilot-api) 0.5.2 (`capiAutoURL`).
- Copilot ignores the session token on a chat request without `X-GitHub-Api-Version`: found in [yetone/magpie#256](https://github.com/yetone/magpie/issues/256) and reproduced on a Copilot Free account (#6).
- Virtual model and hook contract: `docs/virtual-models.md` (route reasons, router state) and `docs/extensions.md` (`before_provider_headers`, `session_compact`) in `@earendil-works/pi-coding-agent` 1.5.2.

Verified against microsoft/vscode `extensions/copilot` (automodeService.ts at `e54f253d94`, autoV2Fetcher.ts at `c9479adea7`) and `@vscode/copilot-api` 0.5.2 in November 2026. VS Code removed the older `/models/session` + `/models/session/intent` flow in `fe7e476752` (August 2026).

## Compatibility

- Requires Pi 1.5.0 or later (`pi.registerVirtualModel`).
- Sessions answered by earlier versions of this extension record `github-copilot-auto/auto` on old responses; Pi treats them as unknown models and routes the next prompt normally.
