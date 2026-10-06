import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

export const PRESET_CATALOG_SCHEMA_VERSION = 1;

export const DEFAULT_PRESET_LIMITS = Object.freeze({
  maxEntries: 4_096,
  maxFileBytes: 1024 * 1024,
  maxSourceBytes: 16 * 1024 * 1024,
  maxPathBytes: 1_024,
  maxArtifactBytes: 32 * 1024 * 1024,
});

const modulePath = "github.com/cloudspannerecosystem/memefish";
const sourceRoots = ["testdata/inputs", "testdata/input"];
const suggestedModes = new Map([
  ["ddl", "ddl"],
  ["dml", "dml"],
  ["expr", "expr"],
  ["gql", "statement"],
  ["query", "query"],
  ["statement", "statement"],
]);

export function buildPresetCatalog({
  moduleDir,
  outputDir,
  channel,
  version,
  commit,
  moduleSum = "",
  limits = DEFAULT_PRESET_LIMITS,
}) {
  validateProvenance({ moduleDir, outputDir, channel, version, commit, moduleSum });
  const resolvedLimits = validateLimits(limits);
  const sourceRoot = resolveSourceRoot(moduleDir);
  const entries = collectPresetEntries(join(moduleDir, sourceRoot), resolvedLimits);
  const sourceBytes = entries.reduce((total, entry) => total + Buffer.byteLength(entry.source), 0);
  const catalog = {
    schemaVersion: PRESET_CATALOG_SCHEMA_VERSION,
    source: {
      module: modulePath,
      channel,
      version,
      commit,
      moduleSum,
      root: sourceRoot,
    },
    count: entries.length,
    sourceBytes,
    entries,
  };
  const content = Buffer.from(JSON.stringify(catalog), "utf8");
  if (content.byteLength > resolvedLimits.maxArtifactBytes) {
    throw new Error(
      `preset catalog is ${content.byteLength} bytes; limit is ${resolvedLimits.maxArtifactBytes}`,
    );
  }

  const digest = createHash("sha256").update(content).digest("hex");
  const artifact = `memefish-main-presets-${digest}.json`;
  mkdirSync(outputDir, { recursive: true });

  // Keep artifact installation atomic even inside the build's staging tree.
  const temporaryArtifact = join(outputDir, `.presets-${process.pid}.tmp`);
  writeFileSync(temporaryArtifact, content, { flag: "wx" });
  renameSync(temporaryArtifact, join(outputDir, artifact));

  return {
    schemaVersion: PRESET_CATALOG_SCHEMA_VERSION,
    channel,
    commit,
    artifact,
    sha256: digest,
    bytes: statSync(join(outputDir, artifact)).size,
    count: entries.length,
    sourceBytes,
  };
}

function resolveSourceRoot(moduleDir) {
  // Upstream renamed input to inputs in September 2026. Prefer the current
  // layout, but keep exact older snapshots buildable without guessing paths.
  for (const sourceRoot of sourceRoots) {
    if (lstatSync(join(moduleDir, sourceRoot), { throwIfNoEntry: false }) !== undefined) {
      return sourceRoot;
    }
  }
  throw new Error(`preset source directory is missing; expected ${sourceRoots.join(" or ")}`);
}

export function collectPresetEntries(inputDir, limits = DEFAULT_PRESET_LIMITS) {
  if (typeof inputDir !== "string" || inputDir.length === 0) {
    throw new TypeError("preset input directory must be a non-empty string");
  }
  const resolvedLimits = validateLimits(limits);
  const rootStat = lstatSync(inputDir);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("preset input root must be a regular directory, not a symbolic link");
  }

  const candidates = [];
  walkDirectory(inputDir, [], candidates, resolvedLimits);
  candidates.sort((left, right) => comparePaths(left.path, right.path));

  let sourceBytes = 0;
  const entries = [];
  for (const candidate of candidates) {
    const bytes = readFileSync(candidate.absolutePath);
    if (bytes.byteLength > resolvedLimits.maxFileBytes) {
      throw new Error(
        `preset ${candidate.path} is ${bytes.byteLength} bytes; per-file limit is ${resolvedLimits.maxFileBytes}`,
      );
    }
    if (!isUtf8(bytes)) {
      throw new Error(`preset ${candidate.path} is not valid UTF-8`);
    }
    sourceBytes += bytes.byteLength;
    if (sourceBytes > resolvedLimits.maxSourceBytes) {
      throw new Error(
        `preset sources total ${sourceBytes} bytes; limit is ${resolvedLimits.maxSourceBytes}`,
      );
    }

    const category = candidate.segments.length > 1 ? candidate.segments[0] : "root";
    entries.push({
      path: candidate.path,
      category,
      suggestedMode: suggestedModes.get(category) ?? null,
      expectedError: basename(candidate.path).startsWith("!bad_"),
      source: bytes.toString("utf8"),
    });
  }
  return entries;
}

function walkDirectory(directory, parentSegments, candidates, limits) {
  const entries = readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    validatePathSegment(entry.name);
    const absolutePath = join(directory, entry.name);
    const fileStat = lstatSync(absolutePath);

    if (entry.isSymbolicLink() || fileStat.isSymbolicLink()) {
      throw new Error(`symbolic links are not supported in preset input: ${entry.name}`);
    }

    const segments = [...parentSegments, entry.name];
    const path = segments.join("/");
    if (entry.isDirectory() && fileStat.isDirectory()) {
      walkDirectory(absolutePath, segments, candidates, limits);
      continue;
    }
    if (!entry.isFile() || !fileStat.isFile()) {
      throw new Error(`non-regular preset input is not supported: ${path}`);
    }
    if (!entry.name.endsWith(".sql")) {
      throw new Error(`unsupported preset input file (expected .sql): ${path}`);
    }

    const pathBytes = Buffer.byteLength(path);
    if (pathBytes > limits.maxPathBytes) {
      throw new Error(`preset path is ${pathBytes} bytes; limit is ${limits.maxPathBytes}`);
    }
    candidates.push({ absolutePath, path, segments });
    if (candidates.length > limits.maxEntries) {
      throw new Error(`preset count exceeds limit of ${limits.maxEntries}`);
    }
  }
}

function validatePathSegment(segment) {
  if (
    segment.length === 0 ||
    segment === "." ||
    segment === ".." ||
    segment.includes("/") ||
    segment.includes("\\") ||
    hasControlCharacter(segment)
  ) {
    throw new Error(`unsafe preset path segment: ${JSON.stringify(segment)}`);
  }
}

function hasControlCharacter(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function validateProvenance({ moduleDir, outputDir, channel, version, commit, moduleSum }) {
  if (typeof moduleDir !== "string" || moduleDir.length === 0) {
    throw new TypeError("preset module directory must be a non-empty string");
  }
  if (typeof outputDir !== "string" || outputDir.length === 0) {
    throw new TypeError("preset output directory must be a non-empty string");
  }
  if (channel !== "main") {
    throw new Error(`preset channel must be main, got ${JSON.stringify(channel)}`);
  }
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("preset source version must be a non-empty string");
  }
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error(`invalid preset source commit: ${String(commit)}`);
  }
  if (typeof moduleSum !== "string" || moduleSum.length === 0) {
    throw new TypeError("preset source module sum must be a non-empty string");
  }
}

function validateLimits(limits) {
  const names = [
    "maxEntries",
    "maxFileBytes",
    "maxSourceBytes",
    "maxPathBytes",
    "maxArtifactBytes",
  ];
  const resolved = { ...DEFAULT_PRESET_LIMITS, ...limits };
  for (const name of names) {
    if (!Number.isSafeInteger(resolved[name]) || resolved[name] <= 0) {
      throw new TypeError(`${name} must be a positive safe integer`);
    }
  }
  return resolved;
}

function comparePaths(left, right) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}
