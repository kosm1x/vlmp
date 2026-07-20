# Security Policy

VLMP is a network-facing media server that can hold your personal library and,
via federation, connect to other people's servers. Security is taken seriously,
even though this is a personal open-source project.

## Supported versions

Only the latest released version receives security fixes. There are no
long-term support branches.

| Version        | Supported |
| -------------- | --------- |
| latest release | ✅        |
| older releases | ❌        |

## Reporting a vulnerability

**Please do not open a public GitHub issue for security problems.**

Report privately via **[GitHub Security Advisories](https://github.com/kosm1x/vlmp/security/advisories/new)**
("Report a vulnerability" on the Security tab). This keeps the details private
until a fix is available.

When reporting, please include:

- A description of the issue and its impact
- Steps to reproduce (a proof of concept if you have one)
- Affected version / commit
- Any suggested remediation

## What to expect

This is a best-effort, single-maintainer project. Realistic expectations:

- **Acknowledgement:** within about a week
- **Assessment & fix:** depends on severity and complexity; critical issues are
  prioritized
- **Disclosure:** coordinated — a public advisory is published once a fix ships,
  with credit to the reporter unless you prefer to remain anonymous

## Scope

In scope: the server (auth, streaming, federation, admin surfaces), the client,
and the Windows installer.

Out of scope: vulnerabilities in third-party dependencies (report those
upstream), issues that require physical access to an already-compromised host,
and misconfiguration of the deployment environment (e.g. exposing the raw port
to the internet without TLS — see the README's remote-access guidance).

## Hardening background

VLMP has been through several adversarial audit passes covering performance,
code, logic, resilience, usability, and access control. Historical findings and
the deferred queue are documented under `docs/` (e.g. `docs/AUDIT-2026-07-19.md`).
Reviewing those is a good starting point before reporting, to avoid duplicating
already-tracked items.

## Deploying safely

- Always set a strong `VLMP_JWT_SECRET` (or `VLMP_JWT_SECRET_FILE`). Never ship
  the default.
- Do not port-forward VLMP directly to the internet. Put it behind a mesh VPN
  (Tailscale/WireGuard) or a TLS-terminating reverse proxy / tunnel.
- Keep FFmpeg and Node.js up to date.
- Restrict the data directory and any config files to the service account.
