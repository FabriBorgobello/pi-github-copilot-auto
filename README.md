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
- Exchanges the GitHub token for a short-lived Copilot token.
- Opens a `/models/session` Auto pool.
- Picks the first supported model Pi already knows.
- Streams through Pi's matching built-in provider with the session token attached.

## Commands

- `/copilot-auto-doctor` — checks the stored login, token exchange, Auto session, available models, and the route Pi would pick.

## Runtime notes

- The Pi status line shows the most recently routed model.
- Route picks and Auto session details are logged to `~/.pi/agent/copilot-auto.log`.
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
token exchange, the Auto session, the doctor report, and the streaming path
(routing, header forwarding, abort, and malformed streams). Behaviour owned by
Pi's built-in APIs this delegates to — tool calls, image input, Unicode
boundaries, context overflow — is covered by pi-ai's own suites.

## Troubleshooting

- **No `github-copilot` login found**: run `/login` and pick GitHub Copilot.
- **Auth file unreadable**: check `PI_COPILOT_AUTH` or `~/.pi/agent/auth.json`.
- **`/models/session` fails**: GitHub may have changed the Copilot base URL, headers, or payload.
- **No matching model in pool**: the Auto pool returned model IDs Pi doesn't know yet.
- **Cost display looks wrong**: Auto routing is opaque, so the provider is intentionally reported as zero-cost.

## Security

This package reads the stored Pi GitHub Copilot credential and exchanges it for a short-lived Copilot token. Review the source before installing it from third parties.

## Known limitations

- Provider billing is opaque; Pi reports this Auto model as zero-cost, so Pi's cost estimate may not match actual account usage.

## Compatibility guard

- If GitHub Auto routes to a future API family Pi does not expose yet, the extension fails clearly with the routed model and API instead of guessing how to stream it.
