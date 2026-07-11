import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { EngineSelector } from "./app";
import { resolveVersionsManifest } from "./manifest";

const manifest = resolveVersionsManifest(
  {
    schemaVersion: 1,
    builtAt: "2026-07-11T03:04:05Z",
    goVersion: "go1.26.5",
    wasmExec: "wasm_exec.js",
    channels: {
      release: {
        label: "Latest release",
        version: "v0.8.0",
        commit: "24fc9334defa75de8d8ca1afc9d7205d2c8c5bf9",
        artifact: "release.wasm",
        sha256: "a".repeat(64),
        bytes: 2_000_000,
      },
      main: {
        label: "main snapshot",
        version: "v0.8.1-main",
        commit: "fd610852d27f8b6cf3f0202398cfaa00ead90ce7",
        artifact: "main.wasm",
        sha256: "b".repeat(64),
        bytes: 2_100_000,
      },
    },
  },
  "https://example.test/memefish-playground/wasm/versions.json",
);

describe("EngineSelector", () => {
  it("exposes labeled radio controls and selects the requested snapshot", () => {
    const onChange = vi.fn();
    render(<EngineSelector manifest={manifest} selected="release" onChange={onChange} />);

    expect(screen.getByRole("group", { name: "Parser engine" })).toBeInTheDocument();
    const release = screen.getByRole("radio", { name: /Latest release/ });
    const main = screen.getByRole("radio", { name: /main snapshot/ });
    expect(release).toBeChecked();
    expect(main).not.toBeChecked();

    fireEvent.click(main);
    expect(onChange).toHaveBeenCalledWith("main");
  });
});
