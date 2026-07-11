# AGENTS.md

Guidance for contributors and coding agents working on
`github.com/apstndb/memefish-playground`.

## Project

memefish-playground is a static GitHub Pages application. It compiles
`github.com/cloudspannerecosystem/memefish` to Go WebAssembly and lets users
parse and unparse Spanner GoogleSQL and GQL entirely in the browser.

The deployed site contains independently built engines for:

- every stable memefish release tag, defaulting to the newest published release;
- the newest `main` push commit with a successful upstream Go workflow.

Upstream release CI is advisory and must be displayed separately from the
playground's own verification. A release CI failure must not by itself remove a
published tag or make an older release the default.

Never describe the `main` engine as continuously live. Display its embedded
commit and build time.

## Architecture

- `internal/bridge/` owns the host-testable parser protocol and AST projection.
- `cmd/wasm/` is a minimal `syscall/js` adapter.
- `src/` contains the Preact UI and Web Worker client.
- `scripts/build-wasm.mjs` resolves and builds all release engines plus `main`.
- `scripts/resolve-memefish-refs.mjs` applies the release and `main` freshness
  policies.
- `scripts/memefish-capabilities.mjs` maps upstream API-version boundaries to
  build tags and advertised parse modes.
- `scripts/preset-catalog.mjs` snapshots every `.sql` input from the selected
  main module's `testdata/input` tree.
- `public/wasm/` is generated and must not be committed.

Keep the structure flat. This small app uses no DI framework and no backend.
Do not add a router, service worker, UI kit, or state-management library unless
a concrete requirement justifies it.

## Protocol rules

- The JS/Go boundary is JSON string in, JSON string out.
- Keep `protocolVersion` explicit and update tests when the shape changes.
- Preserve partial AST and unparsed SQL when memefish returns diagnostics.
- Recover parser panics at the bridge boundary so malformed input cannot kill
  the Worker.
- memefish offsets are UTF-8 byte offsets. Browser editor ranges are UTF-16
  code-unit offsets; keep both and test non-ASCII input.
- Cap input size. Parsing is synchronous inside a dedicated Worker.
- Verify the selected WASM artifact's manifest size and SHA-256 digest before
  instantiating it.
- Projected AST JSON is a playground display format, not a stable memefish
  serialization format.

## Commands

```bash
make fmt       # Go formatting plus Biome writes
make test      # Go unit tests plus frontend unit tests
make build     # build every release WASM plus main, then the Vite production site
make check     # required local gate: formatting, tests, vet, typecheck, build
make e2e       # Chromium smoke test against the production preview
```

Use Go 1.26.5 or a later supported Go 1.26 patch. `wasm_exec.js` must come from
the same Go toolchain that builds the WASM artifacts.

## Generated files

Do not hand-edit or commit:

- `public/wasm/`
- `dist/`
- `coverage/`
- Playwright reports

The build must use content-addressed WASM and preset-catalog filenames and
generate version metadata containing the exact memefish version, commit, Go
version, digest, build time, and advisory upstream CI status. Do not fall back
to unverified `@latest` or `@main` refs when exact GitHub refs are unavailable.

## Verification

- Add table-driven Go tests for parser modes, diagnostics, panic containment,
  AST projection, and UTF-8-to-UTF-16 range conversion.
- Add frontend tests for the Worker protocol and stale-response handling.
- A Pages-affecting change must build with a non-root base path.
- Browser smoke tests must cover the default release, a legacy release, and
  `main`; every generated release artifact needs at least a lightweight parse
  smoke check in CI.
- Preset tests must verify exact source preservation, provenance and digest
  validation, dynamic categories, expected-error cases, and that loading a
  preset never switches engines.
- Check generated asset sizes; WASM dominates the payload, so avoid eager
  loading both engines or adding IDE-sized frontend dependencies.

## Git hygiene

- Preserve unrelated work.
- Use `git add <file> ...`, not `git add .`.
- Commit prefixes: `feat:`, `fix:`, `doc:`, `test:`, `ci:`, `chore:`.
- Keep `DESIGN.md` and `TODO.md` current when architectural decisions or
  milestone status change.
