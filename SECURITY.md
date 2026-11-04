# Security

Y-Hub runs a local backend on `127.0.0.1`. Treat `~/.config/yhub/.env` as a secret: it may hold
tokens for services you connect, and it must never be pasted into an issue.

## Reporting a vulnerability

Please use GitHub's private security advisory flow:

<https://github.com/yhub-labs/yhub/security/advisories/new>

Do not open a public issue for a vulnerability. Include the affected version, reproduction steps,
and the impact you observed; a proof of concept helps but is not required.

We aim to acknowledge a report within a few days and to publish a fix before disclosing details.

## Scope

In scope: the local HTTP API, capsule isolation, the MCP server, the plugin loader, and the desktop
shell's IPC surface. Out of scope: third-party plugins installed from other repositories, and
services you configure Y-Hub to call.
