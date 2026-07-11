import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { AstTree, type AstTreeItem, buildAstTreeModel, findDeepestRangedAstNode } from "./ast-tree";
import { type SelectionRequest, SqlEditor } from "./editor";
import {
  loadVersionsManifest,
  type ResolvedEngine,
  type ResolvedVersionsManifest,
} from "./manifest";
import { loadPreferences, savePreferences } from "./persistence";
import { PresetPicker } from "./preset-picker";
import { type PresetEntry, suggestedModeForPreset } from "./presets";
import {
  type EngineChannel,
  type EngineIdentity,
  PARSE_MODES,
  type ParseDiagnostic,
  type ParseMode,
  type ParseResponse,
} from "./protocol";
import { MemefishClient } from "./worker-client";

type OutputTab = "ast" | "json" | "sql";
type StatusTone = "neutral" | "working" | "success" | "error";

const OUTPUT_TABS: readonly OutputTab[] = ["ast", "json", "sql"];

interface StatusState {
  tone: StatusTone;
  label: string;
  message: string;
}

interface LoadedPresetState {
  entry: PresetEntry;
  mode: ParseMode;
}

const MODE_LABELS: Record<ParseMode, string> = {
  statement: "Statement",
  statements: "Statements",
  query: "Query",
  expr: "Expression",
  type: "Type",
  schemaType: "Schema type",
  ddl: "DDL",
  ddls: "DDL statements",
  dml: "DML",
  dmls: "DML statements",
};

export function App() {
  const initialPreferences = useMemo(loadPreferences, []);
  const [selectedEngine, setSelectedEngine] = useState<EngineChannel>(initialPreferences.engine);
  const [selectedReleaseVersion, setSelectedReleaseVersion] = useState<string | null>(null);
  const [mode, setMode] = useState<ParseMode>(initialPreferences.mode);
  const [source, setSource] = useState(initialPreferences.source);
  const [manifest, setManifest] = useState<ResolvedVersionsManifest | null>(null);
  const [response, setResponse] = useState<ParseResponse | null>(null);
  const [outputTab, setOutputTab] = useState<OutputTab>("ast");
  const [selectionRequest, setSelectionRequest] = useState<SelectionRequest | null>(null);
  const [sourceSelectionOffset, setSourceSelectionOffset] = useState(0);
  const [selectedAstItemId, setSelectedAstItemId] = useState<string | null>(null);
  const [fatalMessage, setFatalMessage] = useState<string | null>(null);
  const [loadedPreset, setLoadedPreset] = useState<LoadedPresetState | null>(null);
  const [status, setStatus] = useState<StatusState>({
    tone: "working",
    label: "Loading",
    message: "Reading engine version metadata…",
  });
  const debounceTimer = useRef<number | null>(null);
  const selectionToken = useRef(0);
  const selectedReleaseEngine =
    manifest?.releases?.find((engine) => engine.version === selectedReleaseVersion) ??
    manifest?.channels.release ??
    null;
  const currentEngine =
    selectedEngine === "release" ? selectedReleaseEngine : (manifest?.channels.main ?? null);
  const availableParseModes = currentEngine?.parseModes ?? PARSE_MODES;
  const effectiveMode = availableParseModes.includes(mode)
    ? mode
    : (availableParseModes[0] ?? "statement");
  const astTreeModel = useMemo(
    () => buildAstTreeModel(response?.results ?? [], source),
    [response, source],
  );

  const client = useMemo(
    () =>
      new MemefishClient({
        onLoading: (engine) => {
          setResponse(null);
          setFatalMessage(null);
          setStatus({
            tone: "working",
            label: "Loading",
            message: `Starting ${engineDisplayName(engine)}…`,
          });
        },
        onReady: (engine) => {
          setStatus({
            tone: "success",
            label: "Ready",
            message: `${engineDisplayName(engine)} is ready.`,
          });
        },
        onResponse: (nextResponse) => {
          setResponse(nextResponse);
          setFatalMessage(nextResponse.fatal?.message ?? null);

          if (nextResponse.fatal !== null) {
            setStatus({
              tone: "error",
              label: "Parse failed",
              message: `The parser could not parse this request: ${nextResponse.fatal.message}`,
            });
          } else if (nextResponse.diagnostics.length > 0) {
            setStatus({
              tone: "error",
              label: "Diagnostics",
              message: `${nextResponse.diagnostics.length} parser diagnostic${nextResponse.diagnostics.length === 1 ? "" : "s"}; ${nextResponse.results.length} partial result${nextResponse.results.length === 1 ? "" : "s"}.`,
            });
          } else {
            setStatus({
              tone: "success",
              label: "Parsed",
              message: `${nextResponse.results.length} result${nextResponse.results.length === 1 ? "" : "s"} returned.`,
            });
          }
        },
        onError: (message) => {
          setFatalMessage(message);
          setStatus({ tone: "error", label: "Unavailable", message });
        },
      }),
    [],
  );

  useEffect(() => {
    let active = true;
    void loadVersionsManifest()
      .then((loadedManifest) => {
        if (active) {
          setManifest(loadedManifest);
        }
      })
      .catch((error: unknown) => {
        if (active) {
          const message =
            error instanceof Error ? error.message : "Engine version metadata could not be loaded.";
          setFatalMessage(message);
          setStatus({ tone: "error", label: "Unavailable", message });
        }
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (currentEngine !== null) {
      client.selectEngine(currentEngine);
    }
  }, [client, currentEngine]);

  useEffect(() => {
    if (mode !== effectiveMode) {
      client.invalidateRequests();
      setResponse(null);
      setFatalMessage(null);
      setMode(effectiveMode);
    }
  }, [client, effectiveMode, mode]);

  useEffect(() => {
    const offset = Math.min(sourceSelectionOffset, astTreeModel.sourceLength);
    setSelectedAstItemId(findDeepestRangedAstNode(astTreeModel, offset)?.id ?? null);
  }, [astTreeModel, sourceSelectionOffset]);

  useEffect(() => {
    if (manifest === null) {
      return;
    }
    clearDebounce(debounceTimer);
    debounceTimer.current = window.setTimeout(() => {
      if (client.parse(effectiveMode, source) !== null) {
        setStatus({ tone: "working", label: "Parsing", message: "Parsing in the worker…" });
      }
      debounceTimer.current = null;
    }, 250);

    return () => clearDebounce(debounceTimer);
  }, [client, effectiveMode, manifest, selectedEngine, selectedReleaseVersion, source]);

  useEffect(() => {
    savePreferences({ engine: selectedEngine, mode: effectiveMode, source });
  }, [effectiveMode, selectedEngine, source]);

  useEffect(() => () => client.dispose(), [client]);

  const parseNow = () => {
    clearDebounce(debounceTimer);
    if (client.parse(effectiveMode, source) !== null) {
      setStatus({ tone: "working", label: "Parsing", message: "Parsing in the worker…" });
    }
  };

  const invalidateParse = () => {
    client.invalidateRequests();
    setResponse(null);
    if (manifest !== null) {
      setFatalMessage(null);
    }
  };

  const changeEngine = (engine: EngineChannel) => {
    invalidateParse();
    setSelectedEngine(engine);
  };

  const changeReleaseVersion = (version: string) => {
    invalidateParse();
    setSelectedReleaseVersion(version);
  };

  const changeMode = (nextMode: ParseMode) => {
    invalidateParse();
    setMode(nextMode);
  };

  const changeSource = (nextSource: string) => {
    invalidateParse();
    setSource(nextSource);
  };

  const loadPreset = (entry: PresetEntry) => {
    const nextMode = suggestedModeForPreset(entry) ?? effectiveMode;
    invalidateParse();
    setMode(nextMode);
    setSource(entry.source);
    setLoadedPreset({ entry, mode: nextMode });
  };

  const selectDiagnostic = (diagnostic: ParseDiagnostic) => {
    setSourceSelectionOffset(diagnostic.range.from);
    setSelectedAstItemId(findDeepestRangedAstNode(astTreeModel, diagnostic.range.from)?.id ?? null);
    setSelectionRequest({
      from: diagnostic.range.from,
      to: diagnostic.range.to,
      token: ++selectionToken.current,
    });
  };

  const selectAstNode = (item: AstTreeItem) => {
    if (item.range === null) {
      return;
    }
    setSelectedAstItemId(item.id);
    setSelectionRequest({
      from: item.range.from,
      to: item.range.to,
      token: ++selectionToken.current,
      focus: false,
    });
  };

  const selectAstFromSource = (offset: number) => {
    setSourceSelectionOffset(offset);
    setSelectedAstItemId(findDeepestRangedAstNode(astTreeModel, offset)?.id ?? null);
  };

  const diagnostics = response?.diagnostics ?? [];
  const presetModified =
    loadedPreset !== null &&
    (source !== loadedPreset.entry.source || effectiveMode !== loadedPreset.mode);

  return (
    <div class="app-shell">
      <header class="site-header">
        <div class="brand-block">
          <p class="eyebrow">Cloud Spanner parser · browser local</p>
          <h1>memefish playground</h1>
          <p class="tagline">Inspect parsed ASTs and normalized SQL without sending source away.</p>
        </div>

        {manifest === null ? (
          <div class="engine-placeholder" aria-hidden="true">
            Loading engine metadata…
          </div>
        ) : (
          <EngineSelector
            manifest={manifest}
            selected={selectedEngine}
            selectedReleaseVersion={
              selectedReleaseEngine?.version ?? manifest.channels.release.version
            }
            onChange={changeEngine}
            onReleaseChange={changeReleaseVersion}
          />
        )}
      </header>

      {currentEngine !== null && <EngineDetails engine={currentEngine} />}

      <main class="workspace">
        <section class="source-pane" aria-labelledby="source-heading">
          <div class="pane-toolbar">
            <div class="source-heading-copy">
              <p class="pane-kicker">Input</p>
              <h2 id="source-heading">Spanner GoogleSQL / GQL</h2>
              {loadedPreset !== null && (
                <p class="loaded-preset">
                  Preset <code>{loadedPreset.entry.path}</code>
                  <span class={presetModified ? "preset-modified" : ""}>
                    {presetModified ? "Modified" : "Loaded"}
                  </span>
                </p>
              )}
            </div>
            <div class="parse-controls">
              <PresetPicker
                asset={manifest === null ? null : manifest.presets}
                onLoad={loadPreset}
              />
              <label class="select-label">
                <span>Parse mode</span>
                <select
                  value={effectiveMode}
                  onChange={(event) => changeMode(event.currentTarget.value as ParseMode)}
                >
                  {availableParseModes.map((parseMode) => (
                    <option key={parseMode} value={parseMode}>
                      {MODE_LABELS[parseMode]}
                    </option>
                  ))}
                </select>
              </label>
              <button
                class="parse-button"
                type="button"
                onClick={parseNow}
                disabled={manifest === null}
              >
                Parse
              </button>
            </div>
          </div>

          <p id="editor-shortcut" class="editor-hint">
            Live parsing is debounced. Press <kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>Enter</kbd> to
            parse now.
          </p>
          <SqlEditor
            value={source}
            diagnostics={diagnostics}
            selectionRequest={selectionRequest}
            onChange={changeSource}
            onSelectionChange={selectAstFromSource}
            onParse={parseNow}
          />

          <Status status={status} />
          <Diagnostics
            diagnostics={diagnostics}
            fatalMessage={fatalMessage}
            onSelect={selectDiagnostic}
          />
        </section>

        <section class="output-pane" aria-labelledby="output-heading">
          <div class="output-heading-row">
            <div>
              <p class="pane-kicker">Output</p>
              <h2 id="output-heading">Parser result</h2>
            </div>
            <div class="tabs" role="tablist" aria-label="Parser output">
              <OutputTabButton tab="ast" selected={outputTab} onSelect={setOutputTab}>
                AST tree
              </OutputTabButton>
              <OutputTabButton tab="json" selected={outputTab} onSelect={setOutputTab}>
                JSON
              </OutputTabButton>
              <OutputTabButton tab="sql" selected={outputTab} onSelect={setOutputTab}>
                SQL
              </OutputTabButton>
            </div>
          </div>

          <div
            id="output-panel-ast"
            class="output-panel"
            role="tabpanel"
            aria-labelledby="output-tab-ast"
            hidden={outputTab !== "ast"}
          >
            {response === null ? (
              <div class="empty-output">
                <p>No result yet.</p>
                <span>The selected engine runs in a dedicated Web Worker.</span>
              </div>
            ) : (
              <div class="ast-tree-panel">
                <p class="ast-tree-hint">
                  Select a ranged node to reveal its source. Moving the source cursor selects the
                  deepest matching node.
                </p>
                <AstTree
                  model={astTreeModel}
                  selectedItemId={selectedAstItemId}
                  onSelectNode={selectAstNode}
                />
              </div>
            )}
          </div>
          <div
            id="output-panel-json"
            class="output-panel"
            role="tabpanel"
            aria-labelledby="output-tab-json"
            hidden={outputTab !== "json"}
          >
            {response === null ? (
              <div class="empty-output">
                <p>No result yet.</p>
                <span>The selected engine runs in a dedicated Web Worker.</span>
              </div>
            ) : (
              <textarea
                class="output-text"
                aria-label="AST JSON output"
                value={formatAst(response)}
                readOnly
                wrap="off"
              />
            )}
          </div>
          <div
            id="output-panel-sql"
            class="output-panel"
            role="tabpanel"
            aria-labelledby="output-tab-sql"
            hidden={outputTab !== "sql"}
          >
            {response === null ? (
              <div class="empty-output">
                <p>No result yet.</p>
                <span>The selected engine runs in a dedicated Web Worker.</span>
              </div>
            ) : (
              <textarea
                class="output-text"
                aria-label="SQL output"
                value={formatSql(response)}
                readOnly
                wrap="off"
              />
            )}
          </div>
        </section>
      </main>

      <footer>
        <p>
          Parsing happens locally. memefish reports syntax structure, not Cloud Spanner semantic
          validation.
        </p>
        <nav class="footer-links" aria-label="Project repositories">
          <a href="https://github.com/cloudspannerecosystem/memefish" rel="noreferrer">
            memefish repository
          </a>
          <a href="https://github.com/apstndb/memefish-playground" rel="noreferrer">
            memefish-playground repository
          </a>
        </nav>
      </footer>
    </div>
  );
}

interface EngineSelectorProps {
  manifest: ResolvedVersionsManifest;
  selected: EngineChannel;
  selectedReleaseVersion: string;
  onChange(engine: EngineChannel): void;
  onReleaseChange(version: string): void;
}

export function EngineSelector({
  manifest,
  selected,
  selectedReleaseVersion,
  onChange,
  onReleaseChange,
}: EngineSelectorProps) {
  const selectedRelease =
    manifest.releases?.find((engine) => engine.version === selectedReleaseVersion) ??
    manifest.channels.release;
  return (
    <fieldset class="engine-selector">
      <legend>Parser engine</legend>
      {(["release", "main"] as const).map((channel) => {
        const engine = channel === "release" ? selectedRelease : manifest.channels.main;
        return (
          <label key={channel} class="engine-option">
            <input
              type="radio"
              name="engine"
              value={channel}
              checked={selected === channel}
              onChange={() => onChange(channel)}
            />
            <span class="engine-option-copy">
              <strong>
                {channel === "release"
                  ? manifest.releases === undefined
                    ? "Latest release"
                    : "Release"
                  : "main snapshot"}
              </strong>
              <span>
                {channel === "release" ? engine.version : "main"} · {shortCommit(engine.commit)}
              </span>
            </span>
          </label>
        );
      })}
      {selected === "release" &&
        manifest.releases !== undefined &&
        manifest.releases.length > 1 && (
          <label class="release-version-select">
            <span>Release version</span>
            <select
              value={selectedReleaseVersion}
              onChange={(event) => onReleaseChange(event.currentTarget.value)}
            >
              {manifest.releases.map((release, index) => (
                <option key={release.version} value={release.version}>
                  {release.version}
                  {index === 0 ? " (latest)" : ""}
                </option>
              ))}
            </select>
          </label>
        )}
    </fieldset>
  );
}

export function EngineDetails({ engine }: { engine: ResolvedEngine }) {
  const commitUrl = `https://github.com/cloudspannerecosystem/memefish/commit/${engine.commit}`;
  const releaseUrl = `https://github.com/cloudspannerecosystem/memefish/releases/tag/${encodeURIComponent(engine.version)}`;
  const upstreamCI = upstreamCIAdvisory(engine);

  return (
    <aside class="engine-details" aria-label="Loaded engine identity">
      <span class="identity-label">Selected snapshot</span>
      <strong>{engine.channel === "release" ? engine.version : "main"}</strong>
      <a class="commit-link" href={commitUrl} rel="noreferrer">
        commit <code>{engine.commit}</code>
      </a>
      {engine.channel === "release" ? (
        <a href={releaseUrl} rel="noreferrer">
          release notes
        </a>
      ) : (
        <span title={engine.version}>module {engine.version}</span>
      )}
      <span>{engine.goVersion}</span>
      <span>{formatBytes(engine.bytes)} WASM</span>
      {upstreamCI !== null &&
        (upstreamCI.url === undefined ? (
          <span class="upstream-ci" title={upstreamCI.title}>
            {upstreamCI.label}
          </span>
        ) : (
          <a class="upstream-ci" href={upstreamCI.url} rel="noreferrer" title={upstreamCI.title}>
            {upstreamCI.label}
          </a>
        ))}
      <span>
        built <time dateTime={engine.builtAt}>{formatBuildTime(engine.builtAt)}</time>
      </span>
    </aside>
  );
}

interface UpstreamCIAdvisory {
  label: string;
  title: string;
  url?: string;
}

function upstreamCIAdvisory(engine: ResolvedEngine): UpstreamCIAdvisory | null {
  const upstreamCI = engine.upstreamCI;
  if (upstreamCI !== undefined) {
    switch (upstreamCI.status) {
      case "passed":
        return {
          label: "Upstream CI passed",
          title: `${upstreamCI.workflow} workflow concluded successfully (advisory only)`,
          url: upstreamCI.url,
        };
      case "not_passed":
        return {
          label: "Upstream CI did not pass",
          title: `${upstreamCI.workflow} workflow concluded ${upstreamCI.conclusion} (advisory only)`,
          url: upstreamCI.url,
        };
      case "not_recorded":
        return {
          label: "Upstream CI not recorded",
          title: "No matching completed upstream workflow run was recorded (advisory only)",
        };
      case "not_checked":
        return {
          label: "Upstream CI not checked",
          title: "Upstream workflow status was not checked (advisory only)",
        };
    }
  }

  if (engine.ci !== undefined) {
    return {
      label: "Upstream CI passed",
      title: `${engine.ci.workflow} workflow concluded successfully (advisory only)`,
      url: engine.ci.url,
    };
  }
  return null;
}

function Status({ status }: { status: StatusState }) {
  return (
    <div class={`status status-${status.tone}`} role="status" aria-live="polite" aria-atomic="true">
      <strong>{status.label}</strong>
      <span>{status.message}</span>
    </div>
  );
}

interface DiagnosticsProps {
  diagnostics: ParseDiagnostic[];
  fatalMessage: string | null;
  onSelect(diagnostic: ParseDiagnostic): void;
}

function Diagnostics({ diagnostics, fatalMessage, onSelect }: DiagnosticsProps) {
  return (
    <section class="diagnostics" aria-labelledby="diagnostics-heading">
      <div class="section-heading-row">
        <h3 id="diagnostics-heading">Diagnostics</h3>
        <span>{diagnostics.length}</span>
      </div>
      {fatalMessage !== null && (
        <div class="fatal-message" role="alert">
          <strong>Parser failure</strong>
          <span>{fatalMessage}</span>
        </div>
      )}
      {diagnostics.length === 0 ? (
        <p class="no-diagnostics">No syntax diagnostics.</p>
      ) : (
        <ol class="diagnostic-list">
          {diagnostics.map((diagnostic, index) => (
            <li key={`${diagnostic.range.from}:${diagnostic.range.to}:${diagnostic.message}`}>
              <button type="button" onClick={() => onSelect(diagnostic)}>
                <span class="diagnostic-number">Error {index + 1}</span>
                <span>{diagnostic.message}</span>
                <code>
                  chars {diagnostic.range.from}–{diagnostic.range.to} · bytes{" "}
                  {diagnostic.range.startByte}–{diagnostic.range.endByte}
                </code>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

interface OutputTabButtonProps {
  tab: OutputTab;
  selected: OutputTab;
  onSelect(tab: OutputTab): void;
  children: string;
}

function OutputTabButton({ tab, selected, onSelect, children }: OutputTabButtonProps) {
  const active = tab === selected;
  return (
    <button
      id={`output-tab-${tab}`}
      type="button"
      role="tab"
      aria-selected={active}
      aria-controls={`output-panel-${tab}`}
      tabIndex={active ? 0 : -1}
      onClick={() => onSelect(tab)}
      onKeyDown={(event) => {
        if (
          event.key === "ArrowLeft" ||
          event.key === "ArrowRight" ||
          event.key === "Home" ||
          event.key === "End"
        ) {
          event.preventDefault();
          const nextTab =
            event.key === "Home"
              ? "ast"
              : event.key === "End"
                ? "sql"
                : adjacentTab(tab, event.key === "ArrowRight" ? 1 : -1);
          onSelect(nextTab);
          window.requestAnimationFrame(() =>
            document.getElementById(`output-tab-${nextTab}`)?.focus(),
          );
        }
      }}
    >
      {children}
    </button>
  );
}

function formatAst(response: ParseResponse): string {
  return JSON.stringify(
    response.results.map((result) => ({
      nodeType: result.nodeType,
      range: result.range,
      ast: result.ast,
    })),
    null,
    2,
  );
}

function formatSql(response: ParseResponse): string {
  if (response.results.length === 0) {
    return "-- No SQL result";
  }
  return response.results.map((result) => result.sql).join("\n\n");
}

function shortCommit(commit: string): string {
  return commit.slice(0, 12);
}

function engineDisplayName(engine: ResolvedEngine | EngineIdentity): string {
  return `${engine.channel === "release" ? engine.version : "main"} @ ${shortCommit(engine.commit)}`;
}

function formatBuildTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
}

function formatBytes(value: number): string {
  if (value < 1024 * 1024) {
    return `${Math.max(1, Math.round(value / 1024))} KiB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function clearDebounce(timer: { current: number | null }): void {
  if (timer.current !== null) {
    window.clearTimeout(timer.current);
    timer.current = null;
  }
}

export function adjacentTab(tab: OutputTab, direction: -1 | 1): OutputTab {
  const index = OUTPUT_TABS.indexOf(tab);
  return OUTPUT_TABS[(index + direction + OUTPUT_TABS.length) % OUTPUT_TABS.length] ?? "ast";
}
