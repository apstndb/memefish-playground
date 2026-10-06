import type { ResolvedPresetAsset } from "./manifest";
import { isParseMode, type ParseMode } from "./protocol";

const MEMEFISH_MODULE = "github.com/cloudspannerecosystem/memefish";
const MAX_ENTRY_SOURCE_BYTES = 1024 * 1024;
const MAX_PATH_BYTES = 1_024;

export interface PresetEntry {
  path: string;
  category: string;
  source: string;
  expectedError: boolean;
  suggestedMode: ParseMode | null;
}

export interface PresetCatalogSource {
  module: string;
  channel: "main";
  version: string;
  commit: string;
  moduleSum: string;
  root: "testdata/input" | "testdata/inputs";
}

export interface PresetCatalog {
  schemaVersion: 1;
  source: PresetCatalogSource;
  count: number;
  sourceBytes: number;
  entries: PresetEntry[];
}

export class PresetCatalogError extends Error {
  override name = "PresetCatalogError";
}

export interface PresetFetchResponse {
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type PresetFetcher = (
  input: string,
  init: { cache: "force-cache" },
) => Promise<PresetFetchResponse>;

export async function loadPresetCatalog(
  asset: ResolvedPresetAsset,
  fetcher: PresetFetcher = fetch,
  subtle: Pick<SubtleCrypto, "digest"> = crypto.subtle,
): Promise<PresetCatalog> {
  const response = await fetcher(asset.catalogUrl, { cache: "force-cache" });
  if (!response.ok) {
    throw new PresetCatalogError(`Preset catalog could not be loaded (HTTP ${response.status}).`);
  }

  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== asset.bytes) {
    throw new PresetCatalogError("Preset catalog size does not match version metadata.");
  }

  let digest: ArrayBuffer;
  try {
    digest = await subtle.digest("SHA-256", bytes);
  } catch (error) {
    throw new PresetCatalogError("Preset catalog digest could not be verified.", {
      cause: error,
    });
  }
  if (hex(new Uint8Array(digest)) !== asset.sha256.toLowerCase()) {
    throw new PresetCatalogError("Preset catalog digest does not match version metadata.");
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new PresetCatalogError("Preset catalog is not valid UTF-8.", { cause: error });
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new PresetCatalogError("Preset catalog is not valid JSON.", { cause: error });
  }

  return decodePresetCatalog(value, asset);
}

export function presetCategories(entries: readonly PresetEntry[]): string[] {
  return [...new Set(entries.map((entry) => entry.category))].sort();
}

export function filterPresets(
  entries: readonly PresetEntry[],
  query: string,
  category: string | null,
): PresetEntry[] {
  const normalizedQuery = query.trim().toLowerCase();
  return entries.filter((entry) => {
    if (category !== null && category.length > 0 && entry.category !== category) {
      return false;
    }
    if (normalizedQuery.length === 0) {
      return true;
    }
    return (
      entry.path.toLowerCase().includes(normalizedQuery) ||
      entry.source.toLowerCase().includes(normalizedQuery)
    );
  });
}

export function suggestedModeForCategory(category: string): ParseMode | null {
  switch (category) {
    case "query":
      return "query";
    case "expr":
      return "expr";
    case "ddl":
      return "ddl";
    case "dml":
      return "dml";
    case "gql":
    case "statement":
      return "statement";
    default:
      return null;
  }
}

export function suggestedModeForPreset(entry: PresetEntry): ParseMode | null {
  return entry.suggestedMode ?? suggestedModeForCategory(entry.category);
}

function decodePresetCatalog(value: unknown, asset: ResolvedPresetAsset): PresetCatalog {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.source)) {
    throw new PresetCatalogError("Preset catalog has an unsupported shape.");
  }

  const source = decodeCatalogSource(value.source, asset);
  const count = requireBoundedInteger(value.count, "entry count", 1, 4_096);
  const sourceBytes = requireBoundedInteger(
    value.sourceBytes,
    "source byte count",
    1,
    16 * 1024 * 1024,
  );
  if (count !== asset.count || sourceBytes !== asset.sourceBytes) {
    throw new PresetCatalogError("Preset catalog totals do not match version metadata.");
  }
  if (!Array.isArray(value.entries) || value.entries.length !== count) {
    throw new PresetCatalogError("Preset catalog entry count is inconsistent.");
  }

  const entries: PresetEntry[] = [];
  let previousPath: string | null = null;
  let computedSourceBytes = 0;
  const encoder = new TextEncoder();
  for (const item of value.entries) {
    const entry = decodeEntry(item);
    if (previousPath !== null && entry.path <= previousPath) {
      throw new PresetCatalogError("Preset catalog paths must be unique and strictly sorted.");
    }
    previousPath = entry.path;

    const entrySourceBytes = encoder.encode(entry.source).byteLength;
    if (entrySourceBytes > MAX_ENTRY_SOURCE_BYTES) {
      throw new PresetCatalogError("Preset catalog contains an oversized source file.");
    }
    computedSourceBytes += entrySourceBytes;
    if (computedSourceBytes > sourceBytes) {
      throw new PresetCatalogError("Preset catalog source byte count is inconsistent.");
    }
    entries.push(entry);
  }

  if (computedSourceBytes !== sourceBytes) {
    throw new PresetCatalogError("Preset catalog source byte count is inconsistent.");
  }

  return {
    schemaVersion: 1,
    source,
    count,
    sourceBytes,
    entries,
  };
}

function decodeCatalogSource(
  value: Record<string, unknown>,
  asset: ResolvedPresetAsset,
): PresetCatalogSource {
  const module = requireString(value.module, "source module");
  const channel = value.channel;
  const version = requireString(value.version, "source version");
  const commit = requireString(value.commit, "source commit");
  const moduleSum = requireString(value.moduleSum, "source module checksum");
  const root = requireString(value.root, "source root");

  if (
    module !== MEMEFISH_MODULE ||
    channel !== "main" ||
    version !== asset.version ||
    commit !== asset.commit ||
    !/^h1:[A-Za-z0-9+/]{43}=$/.test(moduleSum) ||
    (root !== "testdata/input" && root !== "testdata/inputs")
  ) {
    throw new PresetCatalogError("Preset catalog source provenance is invalid.");
  }

  return { module, channel: "main", version, commit, moduleSum, root };
}

function decodeEntry(value: unknown): PresetEntry {
  if (!isRecord(value)) {
    throw new PresetCatalogError("Preset catalog contains an invalid entry.");
  }

  const path = requireString(value.path, "entry path");
  const category = requireString(value.category, "entry category");
  const source = requireString(value.source, "entry source", true);
  if (!isSafePath(path, category)) {
    throw new PresetCatalogError("Preset catalog contains an unsafe entry path.");
  }
  if (typeof value.expectedError !== "boolean") {
    throw new PresetCatalogError("Preset catalog contains an invalid expected-error marker.");
  }
  const filename = path.slice(path.lastIndexOf("/") + 1);
  if (value.expectedError !== filename.startsWith("!bad_")) {
    throw new PresetCatalogError("Preset catalog expected-error marker does not match its path.");
  }

  let suggestedMode: ParseMode | null = null;
  if (value.suggestedMode !== undefined && value.suggestedMode !== null) {
    if (!isParseMode(value.suggestedMode)) {
      throw new PresetCatalogError("Preset catalog contains an invalid suggested parse mode.");
    }
    suggestedMode = value.suggestedMode;
  }

  return { path, category, source, expectedError: value.expectedError, suggestedMode };
}

function isSafePath(path: string, category: string): boolean {
  if (
    new TextEncoder().encode(path).byteLength > MAX_PATH_BYTES ||
    path.startsWith("/") ||
    path.includes("\\") ||
    hasControlCharacter(path)
  ) {
    return false;
  }

  const segments = path.split("/");
  const expectedCategory = segments.length > 1 ? segments[0] : "root";
  return (
    path.endsWith(".sql") &&
    expectedCategory === category &&
    segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function requireString(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new PresetCatalogError(`Preset catalog contains an invalid ${field}.`);
  }
  return value;
}

function requireBoundedInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new PresetCatalogError(`Preset catalog contains an invalid ${field}.`);
  }
  return value as number;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
