# TODO

This is the living, ordered milestone backlog for memefish-playground. It is a
tracked project document, not a temporary agent scratch file.

## Milestone 1: usable public playground

- [x] Implement the host-testable Go parser bridge and structured protocol.
- [x] Add the thin Go/WASM `syscall/js` adapter.
- [x] Build latest-release and main-HEAD engines with immutable metadata.
- [x] Implement the Preact editor, modes, diagnostics, AST, and SQL views.
- [x] Add unit and Chromium smoke tests for both engines.
- [x] Add CI and GitHub Pages deployment with a six-hour refresh schedule.
- [ ] Publish the initial site and verify the deployed version metadata.

## Later

- [ ] Add shareable URL state after defining a practical source-size limit.
- [ ] Consider upstream-triggered refresh if six-hour freshness is insufficient.
- [ ] Evaluate AST tree virtualization only if real inputs demonstrate a need.
- [ ] Add a comparison view only after the single-engine workflow is stable.
