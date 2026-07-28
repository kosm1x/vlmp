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
immutable and every shorter one unambiguously a pointer. A **fifth part**
(`v0.1.9.9.1`) is the same idea one level down — a hotfix on a published build;
it is immutable like any 4-part tag, and the moving pointers stay the 1–3-part
prefixes (`0.1.9`, `0.1`), so publishing it never reuses a 4-part name.

Pre-releases append a semver-style suffix (`v0.2.0.0-rc.1`) and publish only
their own exact tag — never `latest`, never a moving pointer.

Things worth knowing before you bump it:

- **Bump by editing files, not `npm version`.** npm happily installs and runs a
  non-semver version (verified on npm 10 — `npm ci` is unaffected), but
  `npm version` refuses to compute the next one. Edit `package.json` and the two
  `version` fields in `package-lock.json` together, or the next install rewrites
  the lock and dirties the tree. The release workflow **refuses to publish** if
  the tag, `package.json` and the lock disagree, so a forgotten bump fails the
  release instead of shipping an image that misreports its own version.
- **Publishing to npm is not an option** under this scheme, and isn't wanted —
  VLMP ships as a container image and a Windows installer, not a package.
- Only VLMP's _own_ version is non-semver; dependency ranges are ordinary semver.
- `sort -V` orders the scheme correctly (`0.1.9 < 0.1.9.1 < 0.1.10 < 0.2.0`),
  which is what the release workflow's newest-tag check depends on.

## Releasing

The version bump must be **committed before the tag is pushed** — the release
workflow compares the tag against `package.json` and both `package-lock.json`
version fields and refuses to publish if they disagree.

1. Bump `package.json` and both `version` fields in `package-lock.json`.
2. Add a line to the README's `Shipped in v0.1.x` list.
3. Commit and push to `master`; wait for CI to go green.
4. Tag and push: `git tag -a vX.Y.Z.B -m "..." && git push origin vX.Y.Z.B`.

Pushing the tag runs `.github/workflows/release.yml`, which re-runs the suite
(`ci.yml` does not trigger on tags, so without this a tag cut from a red commit
would publish) and then pushes a multi-arch image to GHCR.

A release publishes two immutable names — `vX.Y.Z.B` and `X.Y.Z.B` — and moves
the `X.Y.Z`, `X.Y` and `latest` pointers **only** if the tag is the highest
non-pre-release tag in the repo. A pre-release (`v0.2.0.0-rc.1`) publishes its
own names and moves nothing.

Tags are immutable once they have published anything. If a tag is wrong, cut the
next number rather than moving it.

> `release.yml` publishes the container image only. The GitHub **Releases** page
> is maintained by hand and will look out of date unless you add an entry.

## Dependencies

Automated version-update PRs were switched off on 2026-07-27 — they produced a
backlog of major bumps aimed at the release pipeline faster than it was sensible
to review them. Dependabot **security** updates remain enabled at the repository
level, so known CVEs still arrive as PRs.

That makes routine upgrades a manual, deliberate act:

- Bump one thing at a time and let CI's image job prove the container still
  builds and boots.
- GitHub Actions are pinned to commit SHAs on purpose — the release job holds
  `packages: write`, so a retagged upstream action could push an arbitrary image
  to every user. Refresh those by hand.
- `docker/metadata-action` deserves particular care: the guarded `:latest` logic
  is built on verified v5 behaviour, so a major bump needs that behaviour
  re-checked at the new SHA, ideally by running a `-rc` tag through the release
  path first.

## Good first contributions

- Documentation fixes and clarifications
- Additional test coverage for existing behavior
- Small, well-scoped bug fixes with a reproduction
- Cross-platform correctness fixes (path handling, FFmpeg edge cases)

Appreciate you. Even if a PR doesn't merge, a clear bug report with a
reproduction is a real gift.
