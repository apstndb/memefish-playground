# memefish-playground

A browser playground for
[`cloudspannerecosystem/memefish`](https://github.com/cloudspannerecosystem/memefish),
the Go parser and unparser for Cloud Spanner GoogleSQL and GQL.

The site runs entirely in the browser with Go WebAssembly. Its engine selector
offers every stable memefish release tag and the newest successful `main`
snapshot. The default release is the newest published stable tag; upstream CI
status is shown as advisory metadata, while the playground's own build and
browser checks determine whether it can be deployed. Every `.sql` file under
the exact `main` snapshot's `testdata/input` tree is available through the
preset browser. Parsed AST nodes are shown as an expandable tree; selecting a
node highlights its source range, and moving the editor cursor reveals the
deepest matching node.

Open the playground at
[apstndb.github.io/memefish-playground](https://apstndb.github.io/memefish-playground/).
The Pages workflow refreshes the release, `main`, and preset snapshots daily,
or on changes to this repository. A failed or unavailable upstream CI metadata
lookup, or the absence of a successful `main` run, stops the build and leaves
the previously deployed site unchanged. A published release's CI conclusion
remains advisory.

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

Generated WASM assets are not committed. `npm run dev` builds all stable release
engines and the selected `main` snapshot before starting Vite. `make check` is
the required local gate; `make e2e` runs the production bundle with real release
and `main` WASM engines.

Normal builds enumerate stable upstream tags, resolve the newest published
release, and query the public GitHub Actions history. A release's upstream CI
result is displayed but does not disqualify it; `main` still comes from the
newest successful push run of memefish's `Go` workflow. For deterministic
offline checks, set `MEMEFISH_RELEASE_TAG`, `MEMEFISH_RELEASE_SHA`, and
`MEMEFISH_MAIN_SHA` together; these explicit overrides are intended for
testing, not deployment.

## Automated refreshes

The daily schedule needs no cross-repository credential. Every run resolves the
upstream release tags and successful `main` workflow history again before
building and testing the complete site.

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
