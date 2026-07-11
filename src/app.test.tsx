import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { EngineDetails, EngineSelector } from "./app";
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
    render(
      <EngineSelector
        manifest={manifest}
        selected="release"
        selectedReleaseVersion="v0.8.0"
        onChange={onChange}
        onReleaseChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("group", { name: "Parser engine" })).toBeInTheDocument();
    const release = screen.getByRole("radio", { name: /Latest release/ });
    const main = screen.getByRole("radio", { name: /main snapshot/ });
    expect(release).toBeChecked();
    expect(main).not.toBeChecked();

    fireEvent.click(main);
    expect(onChange).toHaveBeenCalledWith("main");
  });

  it("offers historical releases and retains the chosen version across channel switches", () => {
    const historicalRelease = {
      ...manifest.channels.release,
      label: "v0.7.0",
      version: "v0.7.0",
      commit: "7".repeat(40),
      artifact: "release-v0.7.0.wasm",
      sha256: "7".repeat(64),
      wasmUrl: "https://example.test/memefish-playground/wasm/release-v0.7.0.wasm",
    };
    const manifestWithHistory = {
      ...manifest,
      releases: [manifest.channels.release, historicalRelease],
    };
    const onReleaseChange = vi.fn();
    const onChange = vi.fn();
    const { rerender } = render(
      <EngineSelector
        manifest={manifestWithHistory}
        selected="release"
        selectedReleaseVersion="v0.8.0"
        onChange={onChange}
        onReleaseChange={onReleaseChange}
      />,
    );

    const releases = screen.getByRole("combobox", { name: "Release version" });
    expect(releases).toHaveValue("v0.8.0");
    expect(screen.getByRole("option", { name: "v0.8.0 (latest)" })).toBeInTheDocument();
    fireEvent.change(releases, { target: { value: "v0.7.0" } });
    expect(onReleaseChange).toHaveBeenCalledWith("v0.7.0");

    rerender(
      <EngineSelector
        manifest={manifestWithHistory}
        selected="main"
        selectedReleaseVersion="v0.7.0"
        onChange={onChange}
        onReleaseChange={onReleaseChange}
      />,
    );
    expect(screen.queryByRole("combobox", { name: "Release version" })).not.toBeInTheDocument();

    rerender(
      <EngineSelector
        manifest={manifestWithHistory}
        selected="release"
        selectedReleaseVersion="v0.7.0"
        onChange={onChange}
        onReleaseChange={onReleaseChange}
      />,
    );
    expect(screen.getByRole("combobox", { name: "Release version" })).toHaveValue("v0.7.0");
    expect(screen.getByRole("radio", { name: /Release.*v0\.7\.0/ })).toBeChecked();
  });
});

describe("EngineDetails", () => {
  it.each([
    ["passed", "success", "Upstream CI passed", true],
    ["not_passed", "failure", "Upstream CI did not pass", true],
    ["not_recorded", undefined, "Upstream CI not recorded", false],
    ["not_checked", undefined, "Upstream CI not checked", false],
  ] as const)("renders advisory upstream CI status %s", (status, conclusion, label, linked) => {
    const runFields =
      conclusion === undefined
        ? {}
        : {
            runId: 401,
            url: "https://github.com/cloudspannerecosystem/memefish/actions/runs/401",
            conclusion,
            completedAt: "2026-07-11T02:03:04Z",
          };
    const engine = resolveEngine({
      upstreamCI: {
        status,
        workflow: "Go",
        path: ".github/workflows/go.yml",
        ...runFields,
      },
    });

    const view = render(<EngineDetails engine={engine} />);

    const advisory = view.container.querySelector(".upstream-ci");
    if (!(advisory instanceof HTMLElement)) {
      throw new Error("upstream CI advisory was not rendered");
    }
    expect(advisory).toHaveTextContent(label);
    expect(advisory.tagName).toBe(linked ? "A" : "SPAN");
    expect(advisory).toHaveAttribute("title", expect.stringContaining("advisory only"));
    if (linked) {
      expect(advisory).toHaveAttribute(
        "href",
        "https://github.com/cloudspannerecosystem/memefish/actions/runs/401",
      );
    }
  });

  it("maps legacy successful CI provenance to the advisory passed label", () => {
    const engine = resolveEngine({
      ci: {
        workflow: "Go",
        path: ".github/workflows/go.yml",
        runId: 402,
        url: "https://github.com/cloudspannerecosystem/memefish/actions/runs/402",
        conclusion: "success",
        completedAt: "2026-07-11T02:03:04Z",
      },
    });

    const view = render(<EngineDetails engine={engine} />);

    expect(view.container.querySelector(".upstream-ci")).toHaveAttribute(
      "href",
      "https://github.com/cloudspannerecosystem/memefish/actions/runs/402",
    );
  });

  it("accepts older engine metadata without any CI advisory", () => {
    const view = render(<EngineDetails engine={manifest.channels.release} />);

    expect(view.container.querySelector(".upstream-ci")).toBeNull();
  });
});

function resolveEngine(metadata: Record<string, unknown>) {
  return resolveVersionsManifest(
    {
      schemaVersion: manifest.schemaVersion,
      builtAt: manifest.builtAt,
      goVersion: manifest.goVersion,
      wasmExec: manifest.wasmExec,
      channels: {
        release: { ...manifest.channels.release, ...metadata },
        main: manifest.channels.main,
      },
    },
    manifest.manifestUrl,
  ).channels.release;
}
