# memefish-playground

A browser playground for
[`cloudspannerecosystem/memefish`](https://github.com/cloudspannerecosystem/memefish),
the Go parser and unparser for Cloud Spanner GoogleSQL and GQL.

The site runs entirely in the browser with Go WebAssembly. Its engine selector
offers the latest published memefish release and an exact snapshot of memefish
`main`, with the embedded tag and commit shown in the UI.

Implementation is in progress. See [DESIGN.md](DESIGN.md) for architecture and
[TODO.md](TODO.md) for the milestone backlog.

## Development

Prerequisites are Go 1.26.5 or later in the Go 1.26 series, Node.js 24 LTS, and
npm 11.

```bash
npm install
make check
npm run dev
```

Generated WASM assets are not committed. `npm run dev` builds both engines
before starting Vite.

## License

MIT. See [LICENSE](LICENSE).
