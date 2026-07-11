# Design

## Status

Initial implementation in progress.

## Goals

- Parse and unparse Spanner GoogleSQL and GQL locally in the browser.
- Let the user choose the latest memefish release or a recent exact `main`
  snapshot.
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
2. A module Web Worker loads exactly one Go/WASM engine and serializes requests.
3. A small Go bridge dispatches to public memefish `Parse*` helpers, projects
   AST nodes to display JSON, and returns structured diagnostics.
4. GitHub Actions resolves `@latest` and `@main`, builds two content-addressed
   WASM artifacts, builds the Vite site for the Pages base path, and deploys it.

There is no dependency-injection container. Pure functions in
`internal/bridge` provide the test seam; the WASM command is the composition
root.

## Engine freshness

Static Pages assets are snapshots. The deployment workflow runs on changes to
this repository, manually, and on a six-hour schedule. The UI must show the
exact release tag or pseudo-version, full upstream commit, Go version, and
generation time. A future upstream-triggered `repository_dispatch` may reduce
latency, but it would require cross-repository credentials and is not part of
the initial design.

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

## Frontend choices

- Preact 10 with hooks for a small component/state model.
- Vite 8.1 for static bundling and project-relative assets.
- TypeScript 6 in strict mode. TypeScript 7 is intentionally deferred while its
  newly rewritten compiler ecosystem settles.
- CodeMirror 6 for an accessible, mobile-capable editor without Monaco's IDE
  payload.
- Native CSS custom properties and CSS Modules; no Tailwind or component kit.
- Biome for formatting and linting, Vitest for unit tests, and Playwright for a
  production browser smoke test.
