import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ResolvedPresetAsset } from "./manifest";
import {
  filterPresets,
  loadPresetCatalog,
  type PresetEntry,
  presetCategories,
  suggestedModeForPreset,
} from "./presets";

interface PresetPickerProps {
  asset: ResolvedPresetAsset | null | undefined;
  onLoad(entry: PresetEntry): void;
}

type CatalogState = "idle" | "loading" | "ready" | "error";

export function PresetPicker({ asset, onLoad }: PresetPickerProps) {
  const openerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const loadingRef = useRef(false);
  const requestTokenRef = useRef(0);
  const [catalogState, setCatalogState] = useState<CatalogState>("idle");
  const [entries, setEntries] = useState<readonly PresetEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState("");

  const assetKey = asset?.catalogUrl ?? null;
  useEffect(() => {
    requestTokenRef.current += 1;
    loadingRef.current = false;
    setCatalogState("idle");
    setEntries(null);
    setLoadError(null);
    setQuery("");
    setCategory(null);
    setSelectedPath("");
    if (dialogRef.current?.open) {
      dialogRef.current.close();
    }
  }, [assetKey]);

  const categories = useMemo(() => presetCategories(entries ?? []), [entries]);
  const matchingSearch = useMemo(() => filterPresets(entries ?? [], query, null), [entries, query]);
  const filteredEntries = useMemo(
    () => filterPresets(entries ?? [], query, category),
    [category, entries, query],
  );
  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of matchingSearch) {
      counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);
    }
    return counts;
  }, [matchingSearch]);

  useEffect(() => {
    if (!filteredEntries.some((entry) => entry.path === selectedPath)) {
      setSelectedPath(filteredEntries[0]?.path ?? "");
    }
  }, [filteredEntries, selectedPath]);

  useEffect(() => {
    if (catalogState === "ready" && dialogRef.current?.open) {
      searchRef.current?.focus();
    }
  }, [catalogState]);

  const selectedEntry =
    filteredEntries.find((entry) => entry.path === selectedPath) ?? filteredEntries[0] ?? null;

  const loadCatalog = async () => {
    if (asset === null || asset === undefined || loadingRef.current || entries !== null) {
      return;
    }

    const requestToken = ++requestTokenRef.current;
    loadingRef.current = true;
    setCatalogState("loading");
    setLoadError(null);
    try {
      const catalog = await loadPresetCatalog(asset);
      if (requestToken !== requestTokenRef.current) {
        return;
      }
      setEntries(catalog.entries);
      setSelectedPath(catalog.entries[0]?.path ?? "");
      setCatalogState("ready");
    } catch (error: unknown) {
      if (requestToken !== requestTokenRef.current) {
        return;
      }
      setCatalogState("error");
      setLoadError(
        error instanceof Error ? error.message : "The preset catalog could not be loaded.",
      );
    } finally {
      if (requestToken === requestTokenRef.current) {
        loadingRef.current = false;
      }
    }
  };

  const openDialog = () => {
    const dialog = dialogRef.current;
    if (dialog === null || asset === null || asset === undefined) {
      return;
    }
    if (!dialog.open) {
      dialog.showModal();
    }
    window.requestAnimationFrame(() => searchRef.current?.focus());
    if (entries === null && catalogState !== "loading") {
      void loadCatalog();
    }
  };

  const closeDialog = () => dialogRef.current?.close();

  const loadSelected = () => {
    if (selectedEntry === null) {
      return;
    }
    onLoad(selectedEntry);
    closeDialog();
  };

  const triggerLabel =
    asset === null
      ? "Loading presets…"
      : asset === undefined
        ? "Presets unavailable"
        : `Browse ${asset.count} presets`;

  return (
    <>
      <button
        ref={openerRef}
        class="preset-trigger"
        type="button"
        onClick={openDialog}
        disabled={asset === null || asset === undefined}
        title={
          asset === undefined
            ? "This deployment does not include memefish main testdata metadata."
            : undefined
        }
      >
        {triggerLabel}
      </button>

      <dialog
        ref={dialogRef}
        class="preset-dialog"
        aria-labelledby="preset-dialog-title"
        onClose={() => openerRef.current?.focus()}
      >
        <div class="preset-dialog-header">
          <div>
            <p class="pane-kicker">memefish main testdata</p>
            <h2 id="preset-dialog-title">Browse parser presets</h2>
            {asset !== null && asset !== undefined && (
              <p class="preset-provenance">
                Snapshot{" "}
                <a
                  href={`https://github.com/cloudspannerecosystem/memefish/commit/${asset.commit}`}
                  rel="noreferrer"
                >
                  <code>{asset.commit}</code>
                </a>
              </p>
            )}
          </div>
          <button class="dialog-close" type="button" onClick={closeDialog}>
            Close
          </button>
        </div>

        {catalogState === "loading" && (
          <div class="preset-load-state" role="status" aria-live="polite">
            <strong>Loading presets</strong>
            <span>Downloading and verifying the main testdata catalog…</span>
          </div>
        )}

        {catalogState === "error" && (
          <div class="preset-load-state preset-load-error" role="alert">
            <strong>Presets unavailable</strong>
            <span>{loadError}</span>
            <button type="button" onClick={() => void loadCatalog()}>
              Retry
            </button>
          </div>
        )}

        {catalogState === "ready" && entries !== null && (
          <div class="preset-browser">
            <div class="preset-filters">
              <label>
                <span>Search path or source</span>
                <input
                  ref={searchRef}
                  type="search"
                  value={query}
                  onInput={(event) => setQuery(event.currentTarget.value)}
                  placeholder="query/select_star.sql or SELECT"
                />
              </label>
              <label>
                <span>Category</span>
                <select
                  value={category ?? ""}
                  onChange={(event) => setCategory(event.currentTarget.value || null)}
                >
                  <option value="">All ({matchingSearch.length})</option>
                  {categories.map((name) => (
                    <option key={name} value={name}>
                      {name} ({categoryCounts.get(name) ?? 0})
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div class="preset-browser-grid">
              <div class="preset-results">
                <div class="preset-results-heading">
                  <label for="preset-files">Preset files</label>
                  <span>
                    {filteredEntries.length} of {entries.length}
                  </span>
                </div>
                <select
                  id="preset-files"
                  class="preset-list"
                  size={12}
                  value={selectedEntry?.path ?? ""}
                  onChange={(event) => setSelectedPath(event.currentTarget.value)}
                >
                  {filteredEntries.map((entry) => (
                    <option key={entry.path} value={entry.path}>
                      {entry.path}
                      {entry.expectedError ? " — expects diagnostics" : ""}
                    </option>
                  ))}
                </select>
                {filteredEntries.length === 0 && (
                  <p class="preset-empty">No presets match these filters.</p>
                )}
              </div>

              <section class="preset-preview" aria-labelledby="preset-preview-heading">
                <div class="preset-preview-heading">
                  <div>
                    <p class="pane-kicker">Preview</p>
                    <h3 id="preset-preview-heading">
                      {selectedEntry?.path ?? "No preset selected"}
                    </h3>
                  </div>
                  {selectedEntry !== null && (
                    <span
                      class={
                        "preset-expectation" +
                        (selectedEntry.expectedError ? " preset-expectation-error" : "")
                      }
                    >
                      {selectedEntry.expectedError ? "Expects diagnostics" : "Expected to parse"}
                    </span>
                  )}
                </div>
                {selectedEntry !== null && (
                  <>
                    <p class="preset-mode">
                      Suggested mode:{" "}
                      <strong>
                        {suggestedModeForPreset(selectedEntry) ?? "keep current mode"}
                      </strong>
                    </p>
                    <pre>{selectedEntry.source}</pre>
                  </>
                )}
              </section>
            </div>

            <div class="preset-dialog-actions">
              <span>Loading a preset does not change the selected parser engine.</span>
              <button
                class="parse-button"
                type="button"
                onClick={loadSelected}
                disabled={selectedEntry === null}
              >
                Load preset
              </button>
            </div>
          </div>
        )}
      </dialog>
    </>
  );
}
