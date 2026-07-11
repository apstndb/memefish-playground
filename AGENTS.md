# AGENTS.md

Guidance for contributors and coding agents working on
`github.com/cloudspannerecosystem/memefish-playground`.

## Project

memefish-playground is a static GitHub Pages application. It compiles
`github.com/cloudspannerecosystem/memefish` to Go WebAssembly and lets users
parse and unparse Spanner GoogleSQL and GQL entirely in the browser.

The deployed site contains two independently built engines:

- the latest published memefish release;
- the exact `main` commit resolved during the most recent deployment.

Never describe the `main` engine as continuously live. Display its embedded
commit and build time.

## Architecture

- `internal/bridge/` owns the host-testable parser protocol and AST projection.
- `cmd/wasm/` is a minimal `syscall/js` adapter.
- `src/` contains the Preact UI and Web Worker client.
- `scripts/build-wasm.mjs` resolves and builds both memefish channels.
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
- Projected AST JSON is a playground display format, not a stable memefish
  serialization format.

## Commands

```bash
make fmt       # Go formatting plus Biome writes
make test      # Go unit tests plus frontend unit tests
make build     # resolve and build both WASM engines, then Vite production build
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

The build must use content-addressed WASM filenames and generate version
metadata containing the exact memefish version, commit, Go version, digest, and
build time.

## Verification

- Add table-driven Go tests for parser modes, diagnostics, panic containment,
  AST projection, and UTF-8-to-UTF-16 range conversion.
- Add frontend tests for the Worker protocol and stale-response handling.
- A Pages-affecting change must build with a non-root base path.
- Browser smoke tests must parse with both release and main engines.
- Check generated asset sizes; WASM dominates the payload, so avoid eager
  loading both engines or adding IDE-sized frontend dependencies.

## Git hygiene

- Preserve unrelated work.
- Use `git add <file> ...`, not `git add .`.
- Commit prefixes: `feat:`, `fix:`, `doc:`, `test:`, `ci:`, `chore:`.
- Keep `DESIGN.md` and `TODO.md` current when architectural decisions or
  milestone status change.
