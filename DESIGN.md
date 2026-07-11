# Design

## Status

Milestone 1 is deployed and verified at
<https://apstndb.github.io/memefish-playground/>.

## Goals

- Parse and unparse Spanner GoogleSQL and GQL locally in the browser.
- Let the user choose the latest memefish release or a recent exact `main`
  snapshot.
- Let the user reproduce behavior with every stable release tag.
- Make every input fixture from the selected `main` snapshot available as an
  exact-source preset.
- Deploy as a static GitHub Pages project site with no server-side runtime.
- Keep engine identity visible and reproducible.
- Stay responsive while Go parses by running each engine in a Web Worker.

## Non-goals

- A stable JSON serialization contract for memefish AST values.
- Running multiple memefish versions in one Go binary.
- A full IDE, LSP client, account system, server API, or persistent cloud state.
- Reproducing semantic validation performed by Cloud Spanner.

## Structure

The app is deliberately flat:

1. A Preact single-page UI owns editor state, mode selection, result tabs, and
   accessibility.
2. A module Web Worker loads exactly one Go/WASM engine, verifies its exact
   size and SHA-256 digest before instantiation, and serializes requests.
3. A small Go bridge dispatches to public memefish `Parse*` helpers, projects
   AST nodes to display JSON, and returns structured diagnostics.
4. The build resolves every stable release tag and a CI-qualified `main`
   commit, builds content-addressed WASM artifacts, and generates a
   content-addressed catalog from the same downloaded `main` module tree.
5. GitHub Actions builds the Vite site for the Pages base path and deploys it.

There is no dependency-injection container. Pure functions in
`internal/bridge` provide the test seam; the WASM command is the composition
root.

## Engine freshness

Static Pages assets are snapshots. Release and `main` use intentionally
different eligibility policies:

- `main` is the head SHA of the newest successful `push` run of memefish's
  `.github/workflows/go.yml` workflow on `main`.
- the default release is the newest published, non-draft, non-prerelease stable
  GitHub release. Every stable semantic-version tag is also built and available
  as a historical engine. If a stable tag appears before its GitHub Release,
  it is selectable without displacing the published default.
- release upstream CI is advisory metadata (`passed`, `did not pass`, or `not
  recorded`), not an eligibility gate. Published releases are instead gated by
  the playground's own version-specific WASM build, vulnerability scan, and
  browser smoke tests.

The resolver fails closed when it cannot resolve exact tags or a successful
`main`; it never falls back to unscreened Go `@latest` or `@main` queries. It
also does not silently replace an unbuildable newest release with an older tag.
Artifact installation and Pages deployment are atomic, so any resolver, build,
scan, or smoke-test failure preserves the prior site. The UI shows the exact tag
or pseudo-version, full upstream commit, advisory upstream workflow status, Go
version, and generation time.

The deployment workflow runs on changes to this repository, manually, and once
daily at 03:37 UTC. Every run re-resolves and verifies upstream metadata. There
is intentionally no cross-repository event trigger or credential to maintain.

## Preset catalog

The preset generator walks `testdata/input` in the same module directory used
to build the CI-qualified `main` engine. It preserves every UTF-8 source byte,
including whether a final newline exists, and records path, category, suggested
parse mode, and the `!bad_` expected-diagnostic marker. The compact JSON catalog
is sorted deterministically and named with its full SHA-256 digest.

`versions.json` exposes the catalog as optional additive metadata so an older
cached manifest remains readable. The browser fetches the immutable catalog
only when requested, then verifies its URL boundary, exact size, SHA-256,
UTF-8, provenance, totals, paths, and schema before rendering source as text.
Loading a preset replaces the editor source and applies its suggested parse
mode, but never changes the selected release or `main` engine. Presets are
upstream parser fixtures, including intentional error cases, not a curated SQL
tutorial.

## Bridge protocol

Requests and responses are JSON strings across a single Worker-global function.
Protocol version 1 uses a request ID, parser mode, and source text. Responses
always use a `results` array, including single-node modes, and distinguish:

- syntax diagnostics, which may accompany recovery AST nodes;
- fatal bridge failures, such as invalid requests, size limits, parser panics,
  or encoding failures.

The AST projection recursively records concrete Go type names and exported
fields. It is meant for inspection only. It may evolve with a protocol-version
change and must not be presented as round-trippable memefish JSON.

## Upstream constraints and workarounds

- memefish exposes UTF-8 byte offsets, while CodeMirror uses JavaScript UTF-16
  code-unit offsets. The bridge converts ranges and retains raw byte offsets.
- Some first-token lexer failures in memefish v0.8.0 and the current main can
  panic before the parser's internal recovery boundary. The bridge contains an
  outer `recover` so the Worker survives malformed input.
- `syscall/js` is outside the Go compatibility promise. Both engines and
  `wasm_exec.js` are built from one pinned Go toolchain, and Go upgrades require
  a browser smoke test.
- CodeMirror SQL highlighting is best effort. memefish remains authoritative
  for Spanner GoogleSQL and GQL syntax and diagnostics.
- `testdata/input` can change without a schema promise. Unknown first-level
  categories remain discoverable and loadable; only known categories receive a
  parse-mode suggestion.
- `ParseSchemaType` became public in memefish v0.8.0. Older releases are built
  with a narrow compatibility tag and advertise their supported parse modes in
  the manifest, so the browser does not offer an API that an engine cannot
  safely expose.

## Frontend choices

- Preact 10 with hooks for a small component/state model.
- Vite 8.1 for static bundling and project-relative assets.
- TypeScript 6 in strict mode. TypeScript 7 is intentionally deferred while its
  newly rewritten compiler ecosystem settles.
- CodeMirror 6 for an accessible, mobile-capable editor without Monaco's IDE
  payload.
- Native CSS custom properties in a small global stylesheet; no Tailwind or
  component kit.
- Biome for formatting and linting, Vitest for unit tests, and Playwright for a
  production browser smoke test.
