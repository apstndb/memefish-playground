# TODO

This is the living, ordered milestone backlog for memefish-playground. It is a
tracked project document, not a temporary agent scratch file.

## Milestone 1: usable public playground

- [x] Implement the host-testable Go parser bridge and structured protocol.
- [x] Add the thin Go/WASM `syscall/js` adapter.
- [x] Build latest-release and main-HEAD engines with immutable metadata.
- [x] Implement the Preact editor, modes, diagnostics, AST, and SQL views.
- [x] Add unit and Chromium smoke tests for both engines.
- [x] Add CI and GitHub Pages deployment with a scheduled refresh.
- [x] Publish the initial site and verify the deployed version metadata.

## Milestone 2: upstream presets and version history

- [x] Generate an immutable catalog containing every `main` `testdata/input`
  source file.
- [x] Add a lazy, searchable preset browser with dynamic categories and
  expected-diagnostic labels.
- [x] Preserve exact source, apply suggested parse modes, and keep engine
  selection independent from preset origin.
- [x] Build every stable release tag, default to the newest published release,
  and expose upstream CI as advisory provenance.
- [x] Keep `main` restricted to the newest successful upstream Go workflow run.
- [x] Add daily refreshes without a cross-repository credential.
- [x] Cover catalog integrity, UI behavior, and a real preset with unit and
  browser tests.

## Milestone 3: synchronized AST inspection

- [x] Project a validated UTF-8 byte and UTF-16 source range for every AST
  node that exposes valid memefish positions.
- [x] Render an accessible, expandable AST tree with bounded rendering for
  large collections.
- [x] Synchronize tree selection with CodeMirror ranges in both directions
  without stealing focus or creating selection loops.
- [x] Keep the raw AST projection available on a separate JSON tab and cover
  the interaction with unit and real-WASM browser tests.
- [x] Add an on-demand colorized Go value view using `k0kubun/pp/v3`, with
  browser-safe depth, complexity, byte, and ANSI SGR page limits and no
  terminal-emulator dependency.

## Later

- [ ] Add shareable URL state after defining a practical source-size limit.
- [ ] Consider an upstream-triggered refresh only if daily freshness proves
  insufficient and a cross-repository credential is acceptable.
- [ ] Add CI reporting and explicit regression budgets for raw and gzip sizes
  of each WASM engine and the frontend bundle before adding more dependencies.
- [ ] Evaluate AST tree virtualization only if real inputs demonstrate a need.
- [ ] Add a comparison view only after the single-engine workflow is stable.
