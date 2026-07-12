import { fireEvent, render, screen, within } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { adjacentTab, EngineDetails, EngineSelector, GoPrettyOutput } from "./app";
import { resolveVersionsManifest } from "./manifest";
import type { ParseResponse } from "./protocol";

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

describe("output tab navigation", () => {
  it("moves through all four tabs and wraps in either direction", () => {
    expect(adjacentTab("ast", 1)).toBe("json");
    expect(adjacentTab("json", 1)).toBe("go");
    expect(adjacentTab("go", 1)).toBe("sql");
    expect(adjacentTab("sql", 1)).toBe("ast");
    expect(adjacentTab("ast", -1)).toBe("sql");
  });
});

describe("GoPrettyOutput", () => {
  it("renders only the selected root and requests result navigation", () => {
    const onSelectResult = vi.fn();
    const response = goPrettyResponse([
      "\u001b[32mfirst result\u001b[0m",
      "\u001b[31msecond result\u001b[0m",
    ]);
    const view = render(
      <GoPrettyOutput response={response} resultIndex={0} onSelectResult={onSelectResult} />,
    );

    expect(view.container.querySelector(".go-pretty-output")).toHaveTextContent("first result");
    expect(view.container.querySelector(".go-pretty-output")).not.toHaveTextContent(
      "second result",
    );
    fireEvent.click(screen.getByRole("button", { name: "Next Go pretty result" }));
    expect(onSelectResult).toHaveBeenCalledWith(1);

    view.rerender(
      <GoPrettyOutput response={response} resultIndex={1} onSelectResult={onSelectResult} />,
    );
    expect(view.container.querySelector(".go-pretty-output")).toHaveTextContent("second result");
    expect(screen.getByRole("spinbutton", { name: "Go pretty result number" })).toHaveValue(2);
  });

  it("bounds rendered ANSI runs and pages through the selected root", () => {
    const pretty = Array.from(
      { length: 2_001 },
      (_, index) => `\u001b[${index % 2 === 0 ? 31 : 32}m${index}|`,
    ).join("");
    const view = render(
      <div class="output-panel">
        <GoPrettyOutput
          response={goPrettyResponse([pretty])}
          resultIndex={0}
          onSelectResult={vi.fn()}
        />
      </div>,
    );

    expect(view.container.querySelectorAll(".go-pretty-output span")).toHaveLength(2_000);
    expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
    const panel = view.container.querySelector<HTMLElement>(".output-panel");
    if (panel === null) {
      throw new Error("output panel was not rendered");
    }
    panel.scrollTop = 100;
    fireEvent.click(screen.getByRole("button", { name: "Next Go pretty page" }));
    expect(panel.scrollTop).toBe(0);
    expect(view.container.querySelectorAll(".go-pretty-output span")).toHaveLength(1);
    expect(view.container.querySelector(".go-pretty-output")).toHaveTextContent("2000|");
  });

  it("discloses browser limits and per-result limiting states", () => {
    const limited = goPrettyResponse(["bounded"]);
    const limitedResult = limited.results[0];
    if (limitedResult === undefined) {
      throw new Error("limited result was not created");
    }
    limitedResult.goPrettyDepthLimited = true;
    limitedResult.goPrettyTruncated = true;
    const view = render(
      <GoPrettyOutput response={limited} resultIndex={0} onSelectResult={vi.fn()} />,
    );
    const scope = within(view.container as HTMLElement);

    expect(scope.getByText(/256 reflection levels/)).toBeInTheDocument();
    expect(scope.getByRole("status")).toHaveTextContent("The reflection depth limit was reached");
    expect(scope.getByRole("status")).toHaveTextContent(
      "Go pretty output was truncated at the 1 MiB raw-text limit",
    );

    const refused = goPrettyResponse(["placeholder"]);
    const refusedResult = refused.results[0];
    if (refusedResult === undefined) {
      throw new Error("refused result was not created");
    }
    delete refusedResult.goPretty;
    refusedResult.goPrettyRefused = true;
    view.rerender(<GoPrettyOutput response={refused} resultIndex={0} onSelectResult={vi.fn()} />);

    expect(scope.getByRole("status")).toHaveTextContent(
      "rendering was skipped because this AST exceeds the browser complexity budget",
    );
    expect(view.container.querySelector(".go-pretty-output")).toHaveTextContent(
      "rendering skipped",
    );
  });

  it("restores invalid result number drafts and commits valid ones", () => {
    const onSelectResult = vi.fn();
    const view = render(
      <GoPrettyOutput
        response={goPrettyResponse(["first", "second"])}
        resultIndex={0}
        onSelectResult={onSelectResult}
      />,
    );
    const input = within(view.container as HTMLElement).getByRole("spinbutton", {
      name: "Go pretty result number",
    }) as HTMLInputElement;

    fireEvent.input(input, { target: { value: "" } });
    expect(input.value).toBe("");
    fireEvent.blur(input);
    expect(input).toHaveValue(1);

    fireEvent.input(input, { target: { value: "3" } });
    fireEvent.blur(input);
    expect(input).toHaveValue(1);
    expect(onSelectResult).not.toHaveBeenCalled();

    fireEvent.input(input, { target: { value: "2" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input).toHaveValue(2);
    expect(onSelectResult).toHaveBeenCalledWith(1);
  });
});

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

function goPrettyResponse(values: readonly string[]): ParseResponse {
  return {
    protocolVersion: 2,
    id: "go-pretty",
    ok: true,
    engine: {
      channel: "release",
      version: "v0.8.0",
      commit: "24fc9334defa75de8d8ca1afc9d7205d2c8c5bf9",
      goVersion: "go1.26.5",
    },
    results: values.map((goPretty, index) => ({
      nodeType: "QueryStatement",
      range: { startByte: index, endByte: index + 1, from: index, to: index + 1 },
      sql: `SELECT ${index + 1}`,
      goPretty,
      ast: { type: "QueryStatement", fields: {} },
    })),
    diagnostics: [],
    fatal: null,
  };
}
