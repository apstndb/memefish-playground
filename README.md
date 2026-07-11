# memefish-playground

A browser playground for
[`cloudspannerecosystem/memefish`](https://github.com/cloudspannerecosystem/memefish),
the Go parser and unparser for Cloud Spanner GoogleSQL and GQL.

The site runs entirely in the browser with Go WebAssembly. Its engine selector
offers the latest published memefish release and an exact snapshot of memefish
`main`, with the embedded tag and commit shown in the UI.

Open the playground at
[cloudspannerecosystem.github.io/memefish-playground](https://cloudspannerecosystem.github.io/memefish-playground/).
The scheduled Pages build refreshes the release and `main` snapshots every six
hours; the UI shows exactly which commits are loaded.

## Stack

- Go 1.26 WebAssembly, isolated in a module Web Worker
- Preact 10 and strict TypeScript 6
- Vite 8.1 and CodeMirror 6
- Biome, Vitest, and Playwright

See [DESIGN.md](DESIGN.md) for the architecture and [TODO.md](TODO.md) for the
ordered follow-up backlog.

## Development

Prerequisites are Go 1.26.5 or later in the Go 1.26 series, Node.js 24 LTS, and
npm 11.

```bash
npm install
make check
npx playwright install chromium
make e2e
npm run dev
```

Generated WASM assets are not committed. `npm run dev` builds both engines
before starting Vite. `make check` is the required local gate; `make e2e` runs
the production bundle with real release and `main` WASM engines.

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
