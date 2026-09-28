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
- whether any token or auth file content was exposed

## Notes

This package reads Pi's stored GitHub Copilot credential from disk and exchanges it for a short-lived Copilot token. Review changes to auth, logging, and network calls carefully.
