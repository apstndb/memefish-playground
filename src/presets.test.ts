import { webcrypto } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedPresetAsset } from "./manifest";
import {
  filterPresets,
  loadPresetCatalog,
  type PresetCatalog,
  presetCategories,
  suggestedModeForCategory,
  suggestedModeForPreset,
} from "./presets";

const subtle = webcrypto.subtle as SubtleCrypto;
const commit = "fd610852d27f8b6cf3f0202398cfaa00ead90ce7";
const version = "v0.8.1-0.20260710071317-fd610852d27f";
const moduleSum = `h1:${"A".repeat(43)}=`;

const validEntries = [
  {
    path: "ddl/create_table.sql",
    category: "ddl",
    suggestedMode: "ddl",
    expectedError: false,
    source: "CREATE TABLE T (K INT64) PRIMARY KEY (K)",
  },
  {
    path: "mystery/extension.sql",
    category: "mystery",
    expectedError: false,
    source: "SELECT 'é'",
  },
  {
    path: "query/!bad_unclosed.sql",
    category: "query",
    suggestedMode: "query",
    expectedError: true,
    source: "SELECT (",
  },
];

function sourceByteCount(entries: readonly { source: string }[]): number {
  const encoder = new TextEncoder();
  return entries.reduce((total, entry) => total + encoder.encode(entry.source).byteLength, 0);
}

function validCatalog(root = "testdata/input"): Record<string, unknown> {
  return {
    schemaVersion: 1,
    source: {
      module: "github.com/cloudspannerecosystem/memefish",
      channel: "main",
      version,
      commit,
      moduleSum,
      root,
    },
    count: validEntries.length,
    sourceBytes: sourceByteCount(validEntries),
    entries: structuredClone(validEntries),
  };
}

async function encodeValue(value: unknown): Promise<{
  asset: ResolvedPresetAsset;
  bytes: ArrayBuffer;
  fetcher: ReturnType<typeof makeFetcher>;
}> {
  return fixtureFromBytes(new TextEncoder().encode(JSON.stringify(value)));
}

async function fixtureFromBytes(input: Uint8Array): Promise<{
  asset: ResolvedPresetAsset;
  bytes: ArrayBuffer;
  fetcher: ReturnType<typeof makeFetcher>;
}> {
  const bytes = input.buffer.slice(
    input.byteOffset,
    input.byteOffset + input.byteLength,
  ) as ArrayBuffer;
  const digest = await subtle.digest("SHA-256", bytes);
  const sha256 = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const catalog = tryReadCatalog(bytes);
  const asset: ResolvedPresetAsset = {
    schemaVersion: 1,
    channel: "main",
    version,
    commit,
    artifact: `memefish-main-testdata-${sha256}.json`,
    catalogUrl: `https://example.test/repo/wasm/memefish-main-testdata-${sha256}.json`,
    sha256,
    bytes: bytes.byteLength,
    count: typeof catalog?.count === "number" ? catalog.count : validEntries.length,
    sourceBytes:
      typeof catalog?.sourceBytes === "number"
        ? catalog.sourceBytes
        : sourceByteCount(validEntries),
  };
  const fetcher = makeFetcher(bytes);
  return { asset, bytes, fetcher };
}

function makeFetcher(bytes: ArrayBuffer) {
  return vi.fn(async (_input: string, _init: { cache: "force-cache" }) => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => bytes,
  }));
}

function tryReadCatalog(bytes: ArrayBuffer): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function expectCatalogError(
  value: unknown,
  message: string,
  mutateAsset?: (asset: ResolvedPresetAsset) => void,
): Promise<void> {
  const { asset, fetcher } = await encodeValue(value);
  mutateAsset?.(asset);
  await expect(loadPresetCatalog(asset, fetcher, subtle)).rejects.toThrow(message);
}

describe("preset catalog loading", () => {
  it.each([
    "testdata/input",
    "testdata/inputs",
  ])("verifies and preserves the %s catalog source with immutable caching", async (root) => {
    const { asset, fetcher } = await encodeValue(validCatalog(root));

    const catalog = await loadPresetCatalog(asset, fetcher, subtle);

    expect(fetcher).toHaveBeenCalledWith(asset.catalogUrl, { cache: "force-cache" });
    expect(catalog.count).toBe(3);
    expect(catalog.source).toEqual(validCatalog(root).source);
    expect(catalog.entries[1]).toMatchObject({
      path: "mystery/extension.sql",
      category: "mystery",
      source: "SELECT 'é'",
      expectedError: false,
      suggestedMode: null,
    });
  });

  it("rejects HTTP failures before decoding", async () => {
    const { asset, fetcher } = await encodeValue(validCatalog());
    fetcher.mockResolvedValue({
      ok: false,
      status: 404,
      arrayBuffer: async () => new ArrayBuffer(0),
    });

    await expect(loadPresetCatalog(asset, fetcher, subtle)).rejects.toThrow("HTTP 404");
  });

  it("enforces the exact artifact size and digest", async () => {
    const value = validCatalog();
    await expectCatalogError(value, "size does not match", (asset) => {
      asset.bytes += 1;
    });
    await expectCatalogError(value, "digest does not match", (asset) => {
      asset.sha256 = "f".repeat(64);
    });
  });

  it("rejects digest-provider failures", async () => {
    const { asset, fetcher } = await encodeValue(validCatalog());
    const brokenDigest = {
      digest: vi.fn().mockRejectedValue(new Error("unavailable")),
    } as unknown as Pick<SubtleCrypto, "digest">;

    await expect(loadPresetCatalog(asset, fetcher, brokenDigest)).rejects.toThrow(
      "digest could not be verified",
    );
  });

  it("uses fatal UTF-8 decoding and separately reports invalid JSON", async () => {
    const invalidUtf8 = await fixtureFromBytes(new Uint8Array([0xc3, 0x28]));
    await expect(loadPresetCatalog(invalidUtf8.asset, invalidUtf8.fetcher, subtle)).rejects.toThrow(
      "not valid UTF-8",
    );

    const invalidJson = await fixtureFromBytes(new TextEncoder().encode("not json"));
    await expect(loadPresetCatalog(invalidJson.asset, invalidJson.fetcher, subtle)).rejects.toThrow(
      "not valid JSON",
    );
  });

  it.each([
    ["module", "example.com/fork"],
    ["channel", "release"],
    ["version", "v0.8.0"],
    ["commit", "a".repeat(40)],
    ["moduleSum", "h1:not-a-checksum"],
    ["root", "testdata/result"],
  ])("rejects invalid source provenance field %s", async (field, replacement) => {
    const catalog = validCatalog();
    (catalog.source as Record<string, unknown>)[field] = replacement;
    await expectCatalogError(catalog, "source provenance is invalid");
  });

  it.each([
    "testdata/other",
    "testdata/inputs/",
    "/testdata/inputs",
    "../testdata/inputs",
    "testdata/inputs/../result",
    "testdata\\inputs",
    "testdata/%69nputs",
    "testdata/inputs?raw=true",
    "https://example.test/testdata/inputs",
    "testdata/inputs\u0000",
  ])("rejects unrecognized or unsafe source root %j", async (root) => {
    await expectCatalogError(validCatalog(root), "source provenance is invalid");
  });

  it("cross-checks catalog and manifest totals", async () => {
    const countMismatch = validCatalog();
    countMismatch.count = validEntries.length - 1;
    await expectCatalogError(countMismatch, "entry count is inconsistent", (asset) => {
      asset.count = validEntries.length - 1;
    });

    const metadataCountMismatch = validCatalog();
    await expectCatalogError(metadataCountMismatch, "totals do not match", (asset) => {
      asset.count += 1;
    });

    const computedBytesMismatch = validCatalog();
    computedBytesMismatch.sourceBytes = sourceByteCount(validEntries) - 1;
    await expectCatalogError(
      computedBytesMismatch,
      "source byte count is inconsistent",
      (asset) => {
        asset.sourceBytes = sourceByteCount(validEntries) - 1;
      },
    );
  });

  it.each([
    ["../outside.sql", "ddl"],
    ["/ddl/outside.sql", "ddl"],
    ["ddl\\outside.sql", "ddl"],
    ["ddl//empty.sql", "ddl"],
    ["ddl/./dot.sql", "ddl"],
    ["ddl/../parent.sql", "ddl"],
    ["ddl/file.sql", "query"],
    ["unsafe\u0000category/file.sql", "unsafe\u0000category"],
  ])("rejects unsafe or inconsistent path %s", async (path, category) => {
    const entries = [{ path, category, source: "SELECT 1", expectedError: false }];
    const catalog = validCatalog();
    catalog.entries = entries;
    catalog.count = 1;
    catalog.sourceBytes = sourceByteCount(entries);
    await expectCatalogError(catalog, "unsafe entry path", (asset) => {
      asset.count = 1;
      asset.sourceBytes = sourceByteCount(entries);
    });
  });

  it("requires unique, strictly sorted paths", async () => {
    for (const paths of [
      ["query/a.sql", "query/a.sql"],
      ["query/z.sql", "query/a.sql"],
    ]) {
      const entries = paths.map((path) => ({
        path,
        category: "query",
        source: "SELECT 1",
        expectedError: false,
      }));
      const catalog = validCatalog();
      catalog.entries = entries;
      catalog.count = entries.length;
      catalog.sourceBytes = sourceByteCount(entries);
      await expectCatalogError(catalog, "unique and strictly sorted", (asset) => {
        asset.count = entries.length;
        asset.sourceBytes = sourceByteCount(entries);
      });
    }
  });

  it("requires expected-error markers to agree with !bad_ filenames", async () => {
    for (const entry of [
      {
        path: "query/!bad_broken.sql",
        category: "query",
        source: "SELECT (",
        expectedError: false,
      },
      {
        path: "query/good.sql",
        category: "query",
        source: "SELECT 1",
        expectedError: true,
      },
    ]) {
      const catalog = validCatalog();
      catalog.entries = [entry];
      catalog.count = 1;
      catalog.sourceBytes = sourceByteCount([entry]);
      await expectCatalogError(catalog, "expected-error marker does not match", (asset) => {
        asset.count = 1;
        asset.sourceBytes = sourceByteCount([entry]);
      });
    }
  });

  it("accepts missing and null suggested modes but rejects unknown modes", async () => {
    const nullMode = validCatalog();
    (nullMode.entries as Array<Record<string, unknown>>)[1] = {
      ...validEntries[1],
      suggestedMode: null,
    };
    const { asset, fetcher } = await encodeValue(nullMode);
    await expect(loadPresetCatalog(asset, fetcher, subtle)).resolves.toBeDefined();

    const invalidMode = validCatalog();
    (invalidMode.entries as Array<Record<string, unknown>>)[1] = {
      ...validEntries[1],
      suggestedMode: "gql",
    };
    await expectCatalogError(invalidMode, "invalid suggested parse mode");
  });

  it("enforces catalog and per-entry caps", async () => {
    const excessiveCount = validCatalog();
    excessiveCount.count = 4_097;
    await expectCatalogError(excessiveCount, "invalid entry count", (asset) => {
      asset.count = 4_097;
    });

    const oversizedSource = "x".repeat(1024 * 1024 + 1);
    const oversizedEntry = {
      path: "query/large.sql",
      category: "query",
      source: oversizedSource,
      expectedError: false,
    };
    const oversizedCatalog = validCatalog();
    oversizedCatalog.entries = [oversizedEntry];
    oversizedCatalog.count = 1;
    oversizedCatalog.sourceBytes = sourceByteCount([oversizedEntry]);
    await expectCatalogError(oversizedCatalog, "oversized source file", (asset) => {
      asset.count = 1;
      asset.sourceBytes = sourceByteCount([oversizedEntry]);
    });
  });
});

describe("preset catalog helpers", () => {
  const entries = validEntries.map((entry) => ({
    ...entry,
    suggestedMode:
      "suggestedMode" in entry && entry.suggestedMode !== undefined ? entry.suggestedMode : null,
  })) as PresetCatalog["entries"];

  it("discovers dynamic categories and filters by category and text", () => {
    expect(presetCategories(entries)).toEqual(["ddl", "mystery", "query"]);
    expect(filterPresets(entries, "", "mystery").map((entry) => entry.path)).toEqual([
      "mystery/extension.sql",
    ]);
    expect(filterPresets(entries, "É", null).map((entry) => entry.path)).toEqual([
      "mystery/extension.sql",
    ]);
    expect(filterPresets(entries, "unclosed", "query").map((entry) => entry.path)).toEqual([
      "query/!bad_unclosed.sql",
    ]);
  });

  it("uses explicit suggested modes and safe category fallbacks", () => {
    expect(suggestedModeForPreset(entries[0] as PresetCatalog["entries"][number])).toBe("ddl");
    expect(suggestedModeForCategory("gql")).toBe("statement");
    expect(suggestedModeForCategory("statement")).toBe("statement");
    expect(suggestedModeForPreset(entries[1] as PresetCatalog["entries"][number])).toBeNull();
    expect(suggestedModeForCategory("future-category")).toBeNull();
  });

  it("returns new arrays without mutating catalog order", () => {
    const filtered = filterPresets(entries, "SELECT", null);
    expect(filtered).not.toBe(entries);
    expect(entries.map((entry) => entry.path)).toEqual(validEntries.map((entry) => entry.path));
  });
});
