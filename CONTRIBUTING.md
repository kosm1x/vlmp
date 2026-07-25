# Contributing to VLMP

Thanks for taking a look. First, some honesty so nobody's time gets wasted.

## The project's stance

VLMP is a **personal project shared as open source**. It scratches a specific
itch: a featherweight, web-first media server for someone who wanted their own
catalog anywhere without a heavy stack. It is maintained in spare time, on a
best-effort basis, by one person.

That means:

- **Bug reports and small, focused PRs are genuinely welcome.**
- **Response times vary.** Days, sometimes longer. That's normal here, not a
  slight.
- **Not every good idea will be merged.** Scope creep is the enemy of "very
  light." Features that grow the footprint significantly (new heavy
  dependencies, native TV clients, plugin systems) are unlikely to land, even if
  they're well built. Please open a discussion _before_ investing in a large PR.

If you need a feature-rich, actively-staffed media server, Jellyfin and Plex
exist and are excellent. VLMP is intentionally a smaller thing.

## Before you open an issue

- Search existing issues and the `docs/` audit notes first.
- For **security** problems, do **not** open a public issue — see
  [SECURITY.md](SECURITY.md).
- Include your OS, Node version, FFmpeg version, and how you're running it
  (Docker / source / Windows installer).

## Development setup

```bash
git clone https://github.com/kosm1x/vlmp.git
cd vlmp
npm install
npm run dev          # auto-reloading dev server on :8080
```

Requires Node.js >= 22 and FFmpeg + FFprobe on your `$PATH`.

Useful scripts:

| Command             | What it does                  |
| ------------------- | ----------------------------- |
| `npm run dev`       | Dev server with auto-reload   |
| `npm run build`     | Compile TypeScript to `dist/` |
| `npm test`          | Run the test suite (vitest)   |
| `npm run typecheck` | Type-check without emitting   |

## Pull request guidelines

- **Keep PRs small and single-purpose.** One fix or one feature per PR.
- **Add or update tests.** The suite is a point of pride here; regressions with
  no coverage are hard to accept. `npm test` must pass.
- **Respect the "very light" principle.** No new heavy runtime dependencies
  without discussion. The client stays build-step-free and vendored.
- **Match the existing style.** TypeScript strict, no clever indirection where
  plain code reads better.
- **Security-sensitive areas** (auth, federation, streaming path handling, the
  installer) get extra scrutiny. Explain your threat reasoning in the PR
  description.
- By contributing, you agree your contributions are licensed under the project's
  [Apache License 2.0](LICENSE).

## Versioning

VLMP uses a 4-part **`MAJOR.MINOR.PATCH.BUILD`** version, e.g. `0.1.9.4`. This is
deliberately **not** semver — the fourth part counts small shipped increments on a
patch line, which fits how this project actually releases better than stretching
semver's pre-release syntax to mean "the fourth 0.1.9".

It is one string, the same characters everywhere:

| Where                   | Value                            |
| ----------------------- | -------------------------------- |
| git tag                 | `v0.1.9.4` — the only `v` prefix |
| `package.json`          | `0.1.9.4`                        |
| `/api/info`, `/version` | `0.1.9.4` (read verbatim)        |
| Windows installer       | `vlmp-setup-0.1.9.4-win-x64.exe` |
| container image tags    | see the tag table in the README  |

`BUILD` is optional — `v0.2.0` is a valid tag and the derivation in
[`release.yml`](.github/workflows/release.yml) handles both lengths — but
**include it.** Image pointers are the version's shorter prefixes (`0.1.9.4`
yields `0.1.9` and `0.1`), so a three-part release publishes an image tag that a
later fourth-part build will move. Tagging `v0.2.0.0` keeps every four-part name
immutable and every shorter one unambiguously a pointer.

Pre-releases append a semver-style suffix (`v0.2.0.0-rc.1`) and publish only
their own exact tag — never `latest`, never a moving pointer.

Things worth knowing before you bump it:

- **Bump by editing files, not `npm version`.** npm happily installs and runs a
  non-semver version (verified on npm 10 — `npm ci` is unaffected), but
  `npm version` refuses to compute the next one. Edit `package.json` and the two
  `version` fields in `package-lock.json` together, or the next install rewrites
  the lock and dirties the tree.
- **Publishing to npm is not an option** under this scheme, and isn't wanted —
  VLMP ships as a container image and a Windows installer, not a package.
- Only VLMP's _own_ version is non-semver; dependency ranges are ordinary semver.
- `sort -V` orders the scheme correctly (`0.1.9 < 0.1.9.1 < 0.1.10 < 0.2.0`),
  which is what the release workflow's newest-tag check depends on.

## Good first contributions

- Documentation fixes and clarifications
- Additional test coverage for existing behavior
- Small, well-scoped bug fixes with a reproduction
- Cross-platform correctness fixes (path handling, FFmpeg edge cases)

Appreciate you. Even if a PR doesn't merge, a clear bug report with a
reproduction is a real gift.
