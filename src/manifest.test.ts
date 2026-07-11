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
    },
    main: {
      label: "main snapshot",
      version: "v0.8.1-0.20260710071317-fd610852d27f",
      commit: "fd610852d27f8b6cf3f0202398cfaa00ead90ce7",
      artifact: "memefish-main-fd610852d27f.wasm",
      sha256: "b".repeat(64),
      bytes: 2_500_000,
    },
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
  });
});
