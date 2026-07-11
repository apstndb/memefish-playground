import { describe, expect, it, vi } from "vitest";
import {
  loadVersionsManifest,
  ManifestError,
  manifestUrlFor,
  resolveVersionsManifest,
} from "./manifest";

const manifestFixture = {
  schemaVersion: 1,
  builtAt: "2026-07-11T03:04:05Z",
  goVersion: "go1.26.5",
  wasmExec: "wasm_exec-go1.26.5.js",
  channels: {
    release: {
      label: "Latest release",
      version: "v0.8.0",
      commit: "24fc9334defa75de8d8ca1afc9d7205d2c8c5bf9",
      artifact: "memefish-release-24fc9334defa.wasm",
      sha256: "a".repeat(64),
      bytes: 2_400_000,
      parseModes: ["statement", "query", "expr", "type", "ddl", "dml"],
      ci: {
        workflow: "Go",
        path: ".github/workflows/go.yml",
        runId: 101,
        url: "https://github.com/cloudspannerecosystem/memefish/actions/runs/101",
        conclusion: "success",
        completedAt: "2026-07-10T02:03:04Z",
      },
    },
    main: {
      label: "main snapshot",
      version: "v0.8.1-0.20260710071317-fd610852d27f",
      commit: "fd610852d27f8b6cf3f0202398cfaa00ead90ce7",
      artifact: "memefish-main-fd610852d27f.wasm",
      sha256: "b".repeat(64),
      bytes: 2_500_000,
      parseModes: [
        "statement",
        "statements",
        "query",
        "expr",
        "type",
        "schemaType",
        "ddl",
        "ddls",
        "dml",
        "dmls",
      ],
      ci: {
        workflow: "Go",
        path: ".github/workflows/go.yml",
        runId: 102,
        url: "https://github.com/cloudspannerecosystem/memefish/actions/runs/102",
        conclusion: "success",
        completedAt: "2026-07-11T02:03:04Z",
      },
    },
  },
};

const presetDigest = "c".repeat(64);
const manifestWithPresets = {
  ...manifestFixture,
  presets: {
    schemaVersion: 1,
    channel: "main",
    commit: manifestFixture.channels.main.commit,
    artifact: `memefish-main-testdata-${presetDigest}.json`,
    sha256: presetDigest,
    bytes: 12_345,
    count: 321,
    sourceBytes: 9_876,
  },
};

describe("version manifest", () => {
  it("resolves the project Pages base and every asset relative to the manifest", () => {
    const manifestUrl = manifestUrlFor(
      "/memefish-playground/",
      "https://example.test/another/page",
    );
    expect(manifestUrl).toBe("https://example.test/memefish-playground/wasm/versions.json");

    const resolved = resolveVersionsManifest(manifestFixture, manifestUrl);
    expect(resolved.wasmExecUrl).toBe(
      "https://example.test/memefish-playground/wasm/wasm_exec-go1.26.5.js",
    );
    expect(resolved.channels.release.wasmUrl).toBe(
      "https://example.test/memefish-playground/wasm/memefish-release-24fc9334defa.wasm",
    );
    expect(resolved.channels.main.channel).toBe("main");
    expect(resolved.channels.main.ci).toMatchObject({
      runId: 102,
      conclusion: "success",
    });
    expect(resolved.channels.main.upstreamCI).toBeUndefined();
    expect(resolved.channels.release.parseModes).not.toContain("schemaType");
    expect(resolved.channels.main.parseModes).toContain("schemaType");
    expect(resolved.presets).toBeUndefined();
    expect(resolved.releases).toBeUndefined();
  });

  it("resolves every stable release with the latest published release first", () => {
    const v070 = {
      ...manifestFixture.channels.release,
      label: "v0.7.0",
      version: "v0.7.0",
      commit: "7".repeat(40),
      artifact: "memefish-release-v0.7.0.wasm",
      sha256: "7".repeat(64),
      bytes: 2_300_000,
      ci: undefined,
    };
    const v060 = {
      ...v070,
      label: "v0.6.0",
      version: "v0.6.0",
      commit: "6".repeat(40),
      artifact: "memefish-release-v0.6.0.wasm",
      sha256: "6".repeat(64),
      bytes: 2_200_000,
    };
    const resolved = resolveVersionsManifest(
      {
        ...manifestFixture,
        releases: [v060, manifestFixture.channels.release, v070],
      },
      "https://example.test/repo/wasm/versions.json",
    );

    expect(resolved.releases?.map((release) => release.version)).toEqual([
      "v0.8.0",
      "v0.7.0",
      "v0.6.0",
    ]);
    expect(resolved.releases?.every((release) => release.channel === "release")).toBe(true);
    expect(resolved.releases?.[1]?.wasmUrl).toBe(
      "https://example.test/repo/wasm/memefish-release-v0.7.0.wasm",
    );
  });

  it("decodes advisory upstream CI independently of engine availability", () => {
    const resolved = resolveVersionsManifest(
      {
        ...manifestFixture,
        channels: {
          release: {
            ...manifestFixture.channels.release,
            upstreamCI: {
              status: "not_passed",
              workflow: "Go",
              path: ".github/workflows/go.yml",
              runId: 201,
              url: "https://github.com/cloudspannerecosystem/memefish/actions/runs/201",
              conclusion: "failure",
              completedAt: "2026-07-10T02:03:04Z",
            },
          },
          main: {
            ...manifestFixture.channels.main,
            upstreamCI: {
              status: "passed",
              workflow: "Go",
              path: ".github/workflows/go.yml",
              runId: 202,
              url: "https://github.com/cloudspannerecosystem/memefish/actions/runs/202",
              conclusion: "success",
              completedAt: "2026-07-11T02:03:04.123Z",
            },
          },
        },
      },
      "https://example.test/repo/wasm/versions.json",
    );

    expect(resolved.channels.release.upstreamCI).toMatchObject({
      status: "not_passed",
      conclusion: "failure",
    });
    expect(resolved.channels.main.upstreamCI).toMatchObject({
      status: "passed",
      conclusion: "success",
    });
  });

  it.each([
    "not_recorded",
    "not_checked",
  ] as const)("accepts advisory upstream CI status %s without run fields", (status) => {
    const resolved = resolveVersionsManifest(
      {
        ...manifestFixture,
        channels: {
          ...manifestFixture.channels,
          release: {
            ...manifestFixture.channels.release,
            upstreamCI: {
              status,
              workflow: "Go",
              path: ".github/workflows/go.yml",
            },
          },
        },
      },
      "https://example.test/repo/wasm/versions.json",
    );

    expect(resolved.channels.release.upstreamCI).toEqual({
      status,
      workflow: "Go",
      path: ".github/workflows/go.yml",
    });
  });

  it("resolves optional main testdata metadata relative to the manifest", () => {
    const resolved = resolveVersionsManifest(
      manifestWithPresets,
      "https://example.test/repo/wasm/versions.json",
    );

    expect(resolved.presets).toMatchObject({
      channel: "main",
      commit: manifestFixture.channels.main.commit,
      version: manifestFixture.channels.main.version,
      count: 321,
      sourceBytes: 9_876,
      catalogUrl: `https://example.test/repo/wasm/memefish-main-testdata-${presetDigest}.json`,
    });
  });

  it("fetches mutable metadata without using the browser cache", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => manifestFixture,
    });

    await loadVersionsManifest("/memefish-playground/", "https://example.test/", fetcher);

    expect(fetcher).toHaveBeenCalledWith(
      "https://example.test/memefish-playground/wasm/versions.json",
      { cache: "no-store" },
    );
  });

  it("rejects malformed metadata and asset paths that escape its directory", () => {
    expect(() =>
      resolveVersionsManifest(
        {
          ...manifestFixture,
          channels: {
            ...manifestFixture.channels,
            main: { ...manifestFixture.channels.main, sha256: "not-a-digest" },
          },
        },
        "https://example.test/repo/wasm/versions.json",
      ),
    ).toThrow(ManifestError);

    expect(() =>
      resolveVersionsManifest(
        {
          ...manifestFixture,
          channels: {
            ...manifestFixture.channels,
            release: { ...manifestFixture.channels.release, artifact: "../outside.wasm" },
          },
        },
        "https://example.test/repo/wasm/versions.json",
      ),
    ).toThrow("non-relative asset path");

    expect(() =>
      resolveVersionsManifest(
        {
          ...manifestFixture,
          channels: {
            ...manifestFixture.channels,
            release: { ...manifestFixture.channels.release, bytes: 0 },
          },
        },
        "https://example.test/repo/wasm/versions.json",
      ),
    ).toThrow("invalid release artifact size");
  });

  it.each([
    ["failed conclusion", { conclusion: "failure" }],
    ["wrong workflow", { workflow: "Docs" }],
    ["wrong workflow path", { path: ".github/workflows/docs.yml" }],
    ["invalid run ID", { runId: 0 }],
    ["mismatched run URL", { url: "https://github.com/example/project/actions/runs/102" }],
    [
      "run URL query",
      { url: "https://github.com/cloudspannerecosystem/memefish/actions/runs/102?x=1" },
    ],
    ["invalid completion time", { completedAt: "not-a-date" }],
  ])("rejects %s in optional CI provenance", (_name, override) => {
    expect(() =>
      resolveVersionsManifest(
        {
          ...manifestFixture,
          channels: {
            ...manifestFixture.channels,
            main: {
              ...manifestFixture.channels.main,
              ci: { ...manifestFixture.channels.main.ci, ...override },
            },
          },
        },
        "https://example.test/repo/wasm/versions.json",
      ),
    ).toThrow("invalid main CI provenance");
  });

  it.each([
    ["unknown status", { status: "pending" }],
    ["success reported as not passed", { status: "not_passed", conclusion: "success" }],
    ["failure reported as passed", { status: "passed", conclusion: "failure" }],
    ["incomplete conclusion", { status: "not_passed", conclusion: "pending" }],
    ["wrong workflow", { workflow: "Docs" }],
    ["wrong workflow path", { path: ".github/workflows/docs.yml" }],
    ["invalid run ID", { runId: 0 }],
    ["mismatched run URL", { url: "https://github.com/example/project/actions/runs/301" }],
    [
      "run URL query",
      {
        url: "https://github.com/cloudspannerecosystem/memefish/actions/runs/301?check=1",
      },
    ],
    ["invalid completion date", { completedAt: "2026-02-30T02:03:04Z" }],
  ])("rejects %s in advisory upstream CI status", (_name, override) => {
    const upstreamCI = {
      status: "not_passed",
      workflow: "Go",
      path: ".github/workflows/go.yml",
      runId: 301,
      url: "https://github.com/cloudspannerecosystem/memefish/actions/runs/301",
      conclusion: "failure",
      completedAt: "2026-07-10T02:03:04Z",
      ...override,
    };
    expect(() =>
      resolveVersionsManifest(
        {
          ...manifestFixture,
          channels: {
            ...manifestFixture.channels,
            release: { ...manifestFixture.channels.release, upstreamCI },
          },
        },
        "https://example.test/repo/wasm/versions.json",
      ),
    ).toThrow("invalid release upstream CI status");
  });

  it("rejects run fields on upstream CI statuses without a run", () => {
    expect(() =>
      resolveVersionsManifest(
        {
          ...manifestFixture,
          channels: {
            ...manifestFixture.channels,
            release: {
              ...manifestFixture.channels.release,
              upstreamCI: {
                status: "not_recorded",
                workflow: "Go",
                path: ".github/workflows/go.yml",
                runId: 301,
              },
            },
          },
        },
        "https://example.test/repo/wasm/versions.json",
      ),
    ).toThrow("invalid release upstream CI status");
  });

  it.each([
    ["empty history", []],
    ["duplicate version", [manifestFixture.channels.release, manifestFixture.channels.release]],
    [
      "prerelease tag",
      [
        manifestFixture.channels.release,
        { ...manifestFixture.channels.release, version: "v0.7.0-rc.1" },
      ],
    ],
    ["missing latest release", [{ ...manifestFixture.channels.release, version: "v0.7.0" }]],
    [
      "mismatched latest artifact",
      [{ ...manifestFixture.channels.release, artifact: "different.wasm" }],
    ],
  ])("rejects %s in release history", (_name, releases) => {
    expect(() =>
      resolveVersionsManifest(
        { ...manifestFixture, releases },
        "https://example.test/repo/wasm/versions.json",
      ),
    ).toThrow(/release history/);
  });

  it.each([
    ["an empty list", []],
    ["an unknown mode", ["query", "gql"]],
    ["a duplicate mode", ["query", "query"]],
  ])("rejects %s in optional parse mode capabilities", (_name, parseModes) => {
    expect(() =>
      resolveVersionsManifest(
        {
          ...manifestFixture,
          channels: {
            ...manifestFixture.channels,
            release: { ...manifestFixture.channels.release, parseModes },
          },
        },
        "https://example.test/repo/wasm/versions.json",
      ),
    ).toThrow("invalid release parse modes");
  });

  it.each([
    ["unsupported schema", { schemaVersion: 2 }, "invalid preset metadata"],
    ["wrong channel", { channel: "release" }, "invalid preset metadata"],
    ["wrong commit", { commit: "d".repeat(40) }, "does not match"],
    ["invalid digest", { sha256: "not-a-digest" }, "invalid preset digest"],
    [
      "short digest filename",
      { artifact: "memefish-main-testdata-c.json" },
      "not content-addressed",
    ],
    ["zero bytes", { bytes: 0 }, "invalid preset artifact size"],
    ["excessive count", { count: 4_097 }, "invalid preset count"],
    ["excessive source size", { sourceBytes: 16 * 1024 * 1024 + 1 }, "invalid preset source"],
  ])("rejects %s in preset metadata", (_name, override, message) => {
    expect(() =>
      resolveVersionsManifest(
        {
          ...manifestWithPresets,
          presets: { ...manifestWithPresets.presets, ...override },
        },
        "https://example.test/repo/wasm/versions.json",
      ),
    ).toThrow(message);
  });

  it.each([
    `../memefish-main-testdata-${presetDigest}.json`,
    `https://other.test/memefish-main-testdata-${presetDigest}.json`,
    `memefish-main-testdata-${presetDigest}.json?download=1`,
    `memefish-main-testdata-${presetDigest}.json#catalog`,
    `nested\\memefish-main-testdata-${presetDigest}.json`,
  ])("rejects unsafe preset artifact path %s", (artifact) => {
    expect(() =>
      resolveVersionsManifest(
        {
          ...manifestWithPresets,
          presets: { ...manifestWithPresets.presets, artifact },
        },
        "https://example.test/repo/wasm/versions.json",
      ),
    ).toThrow(ManifestError);
  });
});
