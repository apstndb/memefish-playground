import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedPresetAsset } from "./manifest";
import type { PresetCatalog, PresetEntry } from "./presets";

const { loadPresetCatalogMock } = vi.hoisted(() => ({
  loadPresetCatalogMock: vi.fn(),
}));

vi.mock("./presets", async () => {
  const actual = await vi.importActual<typeof import("./presets")>("./presets");
  return {
    ...actual,
    loadPresetCatalog: loadPresetCatalogMock,
  };
});

import { PresetPicker } from "./preset-picker";

const commit = "fd610852d27f8b6cf3f0202398cfaa00ead90ce7";
const entries: PresetEntry[] = [
  {
    path: "ddl/!bad_create_table.sql",
    category: "ddl",
    source: "CREATE TABLE",
    expectedError: true,
    suggestedMode: "ddl",
  },
  {
    path: "query/select_star.sql",
    category: "query",
    source: "SELECT * FROM Singers",
    expectedError: false,
    suggestedMode: "query",
  },
];
const asset: ResolvedPresetAsset = {
  schemaVersion: 1,
  channel: "main",
  version: "v0.8.1-0.20260710071317-fd610852d27f",
  commit,
  artifact: "memefish-main-testdata.json",
  catalogUrl: "https://example.test/wasm/memefish-main-testdata.json",
  sha256: "a".repeat(64),
  bytes: 512,
  count: entries.length,
  sourceBytes: entries.reduce((total, entry) => total + entry.source.length, 0),
};
const catalog: PresetCatalog = {
  schemaVersion: 1,
  source: {
    module: "github.com/cloudspannerecosystem/memefish",
    channel: "main",
    version: asset.version,
    commit,
    moduleSum: `h1:${"A".repeat(43)}=`,
    root: "testdata/input",
  },
  count: entries.length,
  sourceBytes: asset.sourceBytes,
  entries,
};

const originalShowModal = HTMLDialogElement.prototype.showModal;
const originalClose = HTMLDialogElement.prototype.close;

beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.setAttribute("open", "");
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    },
  });
});

afterAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: originalShowModal,
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: originalClose,
  });
});

beforeEach(() => {
  loadPresetCatalogMock.mockReset();
  loadPresetCatalogMock.mockResolvedValue(catalog);
});

afterEach(cleanup);

describe("PresetPicker", () => {
  it("lazy-loads once, filters entries, and returns the selected preset", async () => {
    const onLoad = vi.fn();
    render(<PresetPicker asset={asset} onLoad={onLoad} />);

    const trigger = screen.getByRole("button", { name: "Browse 2 presets" });
    expect(loadPresetCatalogMock).not.toHaveBeenCalled();
    fireEvent.click(trigger);

    expect(await screen.findByRole("dialog", { name: "Browse parser presets" })).toBeVisible();
    expect(loadPresetCatalogMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("link")).toHaveTextContent(commit);
    expect(screen.getByRole("option", { name: "All (2)" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "ddl (1)" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "query (1)" })).toBeInTheDocument();

    fireEvent.input(screen.getByRole("searchbox", { name: "Search path or source" }), {
      target: { value: "select_star" },
    });
    expect(screen.getByRole("option", { name: "All (1)" })).toBeInTheDocument();
    expect(screen.getByRole("listbox", { name: "Preset files" })).toHaveValue(
      "query/select_star.sql",
    );
    expect(screen.getByText("Expected to parse")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Load preset" }));
    expect(onLoad).toHaveBeenCalledWith(entries[1]);
    expect(trigger).toHaveFocus();

    fireEvent.click(trigger);
    await waitFor(() => expect(screen.getByRole("dialog")).toBeVisible());
    expect(loadPresetCatalogMock).toHaveBeenCalledTimes(1);
  });

  it("labels expected diagnostics and retries a failed catalog request", async () => {
    loadPresetCatalogMock
      .mockRejectedValueOnce(new Error("Catalog download failed."))
      .mockResolvedValueOnce(catalog);
    render(<PresetPicker asset={asset} onLoad={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Browse 2 presets" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Catalog download failed.");

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("searchbox", { name: "Search path or source" });
    expect(loadPresetCatalogMock).toHaveBeenCalledTimes(2);

    fireEvent.change(screen.getByRole("combobox", { name: "Category" }), {
      target: { value: "ddl" },
    });
    expect(
      screen.getByRole("option", { name: "ddl/!bad_create_table.sql — expects diagnostics" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Expects diagnostics")).toBeInTheDocument();
  });

  it("disables browsing when an older manifest has no preset metadata", () => {
    render(<PresetPicker asset={undefined} onLoad={vi.fn()} />);

    const trigger = screen.getByRole("button", { name: "Presets unavailable" });
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveAttribute(
      "title",
      "This deployment does not include memefish main testdata metadata.",
    );
  });
});
