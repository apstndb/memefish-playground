import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  buildPresetCatalog,
  collectPresetEntries,
  DEFAULT_PRESET_LIMITS,
} from "./preset-catalog.mjs";

const commit = "a".repeat(40);
const version = "v0.8.1-0.20260710071317-aaaaaaaaaaaa";
const moduleSum = "h1:example";
const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("buildPresetCatalog", () => {
  test.each([
    "testdata/inputs",
    "testdata/input",
  ])("preserves source and provenance from %s", (sourceRoot) => {
    const source = "SELECT '雪😀'";
    const workspace = fixture([["query/example.sql", source]], sourceRoot);
    const catalog = readCatalog(workspace, build(workspace));

    expect(catalog.source.root).toBe(sourceRoot);
    expect(catalog.entries).toEqual([
      {
        path: "query/example.sql",
        category: "query",
        suggestedMode: "query",
        expectedError: false,
        source,
      },
    ]);
  });

  test("prefers the current layout when both roots exist", () => {
    const workspace = fixture([["query/current.sql", "SELECT 1"]], "testdata/inputs");
    const legacyInput = join(workspace.moduleDir, "testdata/input");
    mkdirSync(legacyInput);
    writeFileSync(join(legacyInput, "legacy.sql"), "SELECT 2");

    const catalog = readCatalog(workspace, build(workspace));
    expect(catalog.source.root).toBe("testdata/inputs");
    expect(catalog.entries.map((entry) => entry.path)).toEqual(["query/current.sql"]);
  });

  test("rejects missing roots and never falls back from an invalid current root", () => {
    const missing = fixture([]);
    rmSync(missing.input, { recursive: true });
    expect(() => build(missing)).toThrow(/preset source directory is missing/u);

    const linked = fixture([["query/example.sql", "SELECT 1"]]);
    symlinkSync("input", join(linked.moduleDir, "testdata/inputs"));
    expect(() => build(linked)).toThrow(/symbolic link/u);

    const regularFile = fixture([["query/example.sql", "SELECT 1"]]);
    writeFileSync(join(regularFile.moduleDir, "testdata/inputs"), "not a directory");
    expect(() => build(regularFile)).toThrow(/regular directory/u);
  });

  test("is deterministic across filesystem creation order", () => {
    const files = [
      ["query/z.sql", "SELECT 3"],
      ["ddl/a.sql", "CREATE TABLE T (K INT64) PRIMARY KEY (K)"],
      ["query/a.sql", "SELECT 1"],
    ];
    const first = fixture(files);
    const second = fixture(files.toReversed());

    const firstMetadata = build(first);
    const secondMetadata = build(second);
    const firstContent = readFileSync(join(first.output, firstMetadata.artifact));
    const secondContent = readFileSync(join(second.output, secondMetadata.artifact));

    expect(firstMetadata).toEqual(secondMetadata);
    expect(firstContent).toEqual(secondContent);
    expect(firstMetadata.artifact).toMatch(/^memefish-main-presets-[0-9a-f]{64}\.json$/u);
    expect(firstMetadata.sha256).toBe(createHash("sha256").update(firstContent).digest("hex"));
    expect(firstMetadata.bytes).toBe(firstContent.byteLength);
    expect(firstContent.toString("utf8")).toBe(
      JSON.stringify(JSON.parse(firstContent.toString("utf8"))),
    );

    const catalog = JSON.parse(firstContent.toString("utf8"));
    expect(catalog.entries.map((entry) => entry.path)).toEqual([
      "ddl/a.sql",
      "query/a.sql",
      "query/z.sql",
    ]);
    expect(catalog.source).toEqual({
      module: "github.com/cloudspannerecosystem/memefish",
      channel: "main",
      version,
      commit,
      moduleSum,
      root: "testdata/input",
    });
    expect(catalog.count).toBe(3);
    expect(firstMetadata.count).toBe(3);
    expect(firstMetadata.sourceBytes).toBe(catalog.sourceBytes);
  });

  test("preserves Unicode and the exact absence of a final newline", () => {
    const source = "SELECT '雪😀'";
    const workspace = fixture([["query/unicode.sql", source]]);
    const metadata = build(workspace);
    const catalog = readCatalog(workspace, metadata);

    expect(catalog.entries[0]).toEqual({
      path: "query/unicode.sql",
      category: "query",
      suggestedMode: "query",
      expectedError: false,
      source,
    });
    expect(catalog.entries[0].source.endsWith("\n")).toBe(false);
    expect(metadata.sourceBytes).toBe(Buffer.byteLength(source));
  });

  test("derives nested and unknown categories without hard-coding the directory set", () => {
    const workspace = fixture([
      ["gql/nested/!bad_graph.sql", "GRAPH G MATCH RETURN"],
      ["future/deep/new_syntax.sql", "FUTURE SYNTAX"],
      ["root.sql", "SELECT 1"],
    ]);
    const catalog = readCatalog(workspace, build(workspace));

    expect(catalog.entries).toEqual([
      {
        path: "future/deep/new_syntax.sql",
        category: "future",
        suggestedMode: null,
        expectedError: false,
        source: "FUTURE SYNTAX",
      },
      {
        path: "gql/nested/!bad_graph.sql",
        category: "gql",
        suggestedMode: "statement",
        expectedError: true,
        source: "GRAPH G MATCH RETURN",
      },
      {
        path: "root.sql",
        category: "root",
        suggestedMode: null,
        expectedError: false,
        source: "SELECT 1",
      },
    ]);
  });

  test("suggests the bridge mode for every current testdata category", () => {
    const workspace = fixture([
      ["ddl/example.sql", "CREATE DATABASE example"],
      ["dml/example.sql", "DELETE T WHERE TRUE"],
      ["expr/example.sql", "1 + 1"],
      ["gql/example.sql", "GRAPH G MATCH RETURN 1"],
      ["query/example.sql", "SELECT 1"],
      ["statement/example.sql", "CALL P()"],
    ]);
    const catalog = readCatalog(workspace, build(workspace));

    expect(
      Object.fromEntries(catalog.entries.map((entry) => [entry.category, entry.suggestedMode])),
    ).toEqual({
      ddl: "ddl",
      dml: "dml",
      expr: "expr",
      gql: "statement",
      query: "query",
      statement: "statement",
    });
  });

  test("rejects invalid provenance and an oversized encoded artifact", () => {
    const workspace = fixture([["query/a.sql", "SELECT 1"]]);

    expect(() => build(workspace, { channel: "release" })).toThrow(/must be main/u);
    expect(() => build(workspace, { commit: "not-a-commit" })).toThrow(/invalid/u);
    expect(() =>
      build(workspace, {
        limits: { ...DEFAULT_PRESET_LIMITS, maxArtifactBytes: 1 },
      }),
    ).toThrow(/catalog is .* limit/u);
  });
});

describe("collectPresetEntries", () => {
  test("rejects invalid UTF-8 and source size limits", () => {
    const invalid = fixture([["query/invalid.sql", Buffer.from([0xc3, 0x28])]]);
    expect(() => collectPresetEntries(invalid.input)).toThrow(/not valid UTF-8/u);

    const oversized = fixture([["query/large.sql", "12345"]]);
    expect(() =>
      collectPresetEntries(oversized.input, {
        ...DEFAULT_PRESET_LIMITS,
        maxFileBytes: 4,
      }),
    ).toThrow(/per-file limit/u);

    const total = fixture([
      ["query/a.sql", "123"],
      ["query/b.sql", "456"],
    ]);
    expect(() =>
      collectPresetEntries(total.input, {
        ...DEFAULT_PRESET_LIMITS,
        maxSourceBytes: 5,
      }),
    ).toThrow(/sources total/u);
  });

  test("rejects count and path size limits", () => {
    const workspace = fixture([
      ["query/a.sql", "SELECT 1"],
      ["query/b.sql", "SELECT 2"],
    ]);
    expect(() =>
      collectPresetEntries(workspace.input, {
        ...DEFAULT_PRESET_LIMITS,
        maxEntries: 1,
      }),
    ).toThrow(/count exceeds/u);
    expect(() =>
      collectPresetEntries(workspace.input, {
        ...DEFAULT_PRESET_LIMITS,
        maxPathBytes: 4,
      }),
    ).toThrow(/preset path/u);
  });

  test("rejects symlinks, unsupported files, and unsafe path segments", () => {
    const linked = fixture([["query/target.sql", "SELECT 1"]]);
    symlinkSync("target.sql", join(linked.input, "query", "linked.sql"));
    expect(() => collectPresetEntries(linked.input)).toThrow(/symbolic links/u);

    const unsupported = fixture([["query/readme.txt", "not SQL"]]);
    expect(() => collectPresetEntries(unsupported.input)).toThrow(/expected \.sql/u);

    const unsafe = fixture([["query/unsafe\\name.sql", "SELECT 1"]]);
    expect(() => collectPresetEntries(unsafe.input)).toThrow(/unsafe preset path/u);
  });
});

function fixture(files, sourceRoot = "testdata/input") {
  const root = mkdtempSync(join(tmpdir(), "preset-catalog-test-"));
  temporaryRoots.push(root);
  const input = join(root, sourceRoot);
  const output = join(root, "output");
  mkdirSync(input, { recursive: true });
  for (const [path, content] of files) {
    const destination = join(input, ...path.split("/"));
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }
  return { moduleDir: root, input, output };
}

function build(workspace, overrides = {}) {
  return buildPresetCatalog({
    moduleDir: workspace.moduleDir,
    outputDir: workspace.output,
    channel: "main",
    version,
    commit,
    moduleSum,
    ...overrides,
  });
}

function readCatalog(workspace, metadata) {
  return JSON.parse(readFileSync(join(workspace.output, metadata.artifact), "utf8"));
}
