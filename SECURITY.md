# Security Policy

## Supported versions

Only the latest published version is supported.

## Reporting a vulnerability

Do not open a public issue for credential-handling or token-leak bugs.

Report it privately to the maintainer through the repository security contact once the repository metadata is set, or through a private channel you already use with the maintainer.

Include:

- Pi version
- package version
- OS
- exact steps to reproduce
- whether any token was exposed

## Notes

This package asks Pi's model registry for the GitHub Copilot token of Pi's built-in `github-copilot` provider and adds the Auto session token to chat requests while Copilot Auto is selected. It never reads Pi's auth file itself. Review changes to auth, the `before_provider_headers` hook, logging, and network calls carefully.
