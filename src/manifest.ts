import { type EngineChannel, type EngineIdentity, isParseMode, type ParseMode } from "./protocol";

export interface ManifestChannel {
  label: string;
  version: string;
  commit: string;
  artifact: string;
  sha256: string;
  bytes: number;
  parseModes?: ParseMode[];
  ci?: EngineCIVerification;
  upstreamCI?: EngineUpstreamCI;
}

export interface EngineCIVerification {
  workflow: string;
  path: string;
  runId: number;
  url: string;
  conclusion: "success";
  completedAt: string;
}

interface EngineUpstreamCIBase {
  workflow: "Go";
  path: ".github/workflows/go.yml";
}

export interface EngineUpstreamCIPassed extends EngineUpstreamCIBase {
  status: "passed";
  runId: number;
  url: string;
  conclusion: "success";
  completedAt: string;
}

export type EngineCINonSuccessConclusion =
  | "action_required"
  | "cancelled"
  | "failure"
  | "neutral"
  | "skipped"
  | "stale"
  | "startup_failure"
  | "timed_out";

export interface EngineUpstreamCINotPassed extends EngineUpstreamCIBase {
  status: "not_passed";
  runId: number;
  url: string;
  conclusion: EngineCINonSuccessConclusion;
  completedAt: string;
}

export interface EngineUpstreamCINoRun extends EngineUpstreamCIBase {
  status: "not_recorded" | "not_checked";
}

export type EngineUpstreamCI =
  | EngineUpstreamCIPassed
  | EngineUpstreamCINotPassed
  | EngineUpstreamCINoRun;

export interface PresetManifest {
  schemaVersion: 1;
  channel: "main";
  commit: string;
  artifact: string;
  sha256: string;
  bytes: number;
  count: number;
  sourceBytes: number;
}

export interface ResolvedPresetAsset extends PresetManifest {
  catalogUrl: string;
  version: string;
}

export interface VersionsManifest {
  schemaVersion: 1;
  builtAt: string;
  goVersion: string;
  wasmExec: string;
  channels: Record<EngineChannel, ManifestChannel>;
  releases?: ManifestChannel[];
  presets?: PresetManifest;
}

export interface ResolvedEngine extends ManifestChannel {
  channel: EngineChannel;
  wasmUrl: string;
  wasmExecUrl: string;
  builtAt: string;
  goVersion: string;
}

export interface ResolvedVersionsManifest extends VersionsManifest {
  manifestUrl: string;
  wasmExecUrl: string;
  channels: Record<EngineChannel, ResolvedEngine>;
  releases?: ResolvedEngine[];
  presets?: ResolvedPresetAsset;
}

export class ManifestError extends Error {
  override name = "ManifestError";
}

export interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type ManifestFetcher = (
  input: string,
  init: { cache: "no-store" },
) => Promise<FetchResponse>;

export function manifestUrlFor(baseUrl: string, pageUrl: string): string {
  const resolvedBase = new URL(baseUrl, pageUrl);
  if (!resolvedBase.pathname.endsWith("/")) {
    resolvedBase.pathname = `${resolvedBase.pathname}/`;
  }
  return new URL("wasm/versions.json", resolvedBase).href;
}

export async function loadVersionsManifest(
  baseUrl = import.meta.env.BASE_URL,
  pageUrl = window.location.href,
  fetcher: ManifestFetcher = fetch,
): Promise<ResolvedVersionsManifest> {
  const manifestUrl = manifestUrlFor(baseUrl, pageUrl);
  const response = await fetcher(manifestUrl, { cache: "no-store" });
  if (!response.ok) {
    throw new ManifestError(`Version metadata could not be loaded (HTTP ${response.status}).`);
  }
  return resolveVersionsManifest(await response.json(), manifestUrl);
}

export function resolveVersionsManifest(
  value: unknown,
  manifestUrl: string,
): ResolvedVersionsManifest {
  const manifest = decodeVersionsManifest(value);
  const wasmExecUrl = resolveAssetUrl(manifestUrl, manifest.wasmExec);
  const presets = manifest.presets
    ? resolvePresetAsset(manifest.presets, manifest.channels.main, manifestUrl)
    : null;
  const releases = manifest.releases?.map((entry) =>
    resolveEngine("release", entry, manifest, wasmExecUrl, manifestUrl),
  );

  return {
    schemaVersion: manifest.schemaVersion,
    builtAt: manifest.builtAt,
    goVersion: manifest.goVersion,
    wasmExec: manifest.wasmExec,
    manifestUrl,
    wasmExecUrl,
    channels: {
      release: resolveEngine(
        "release",
        manifest.channels.release,
        manifest,
        wasmExecUrl,
        manifestUrl,
      ),
      main: resolveEngine("main", manifest.channels.main, manifest, wasmExecUrl, manifestUrl),
    },
    ...(releases === undefined ? {} : { releases }),
    ...(presets === null ? {} : { presets }),
  };
}

export function expectedEngineIdentity(engine: ResolvedEngine): EngineIdentity {
  return {
    channel: engine.channel,
    version: engine.version,
    commit: engine.commit,
    goVersion: engine.goVersion,
  };
}

function resolveEngine(
  channel: EngineChannel,
  entry: ManifestChannel,
  manifest: VersionsManifest,
  wasmExecUrl: string,
  manifestUrl: string,
): ResolvedEngine {
  return {
    ...entry,
    channel,
    wasmUrl: resolveAssetUrl(manifestUrl, entry.artifact),
    wasmExecUrl,
    builtAt: manifest.builtAt,
    goVersion: manifest.goVersion,
  };
}

function resolvePresetAsset(
  entry: PresetManifest,
  main: ManifestChannel,
  manifestUrl: string,
): ResolvedPresetAsset {
  return {
    ...entry,
    catalogUrl: resolveAssetUrl(manifestUrl, entry.artifact),
    version: main.version,
  };
}

function resolveAssetUrl(manifestUrl: string, path: string): string {
  if (path.includes("\\")) {
    throw new ManifestError("Version metadata contains an invalid asset path.");
  }

  const base = new URL(manifestUrl);
  const resolved = new URL(path, base);
  const baseDirectory = base.pathname.slice(0, base.pathname.lastIndexOf("/") + 1);
  if (
    resolved.origin !== base.origin ||
    !resolved.pathname.startsWith(baseDirectory) ||
    resolved.search.length > 0 ||
    resolved.hash.length > 0
  ) {
    throw new ManifestError("Version metadata contains a non-relative asset path.");
  }
  return resolved.href;
}

function decodeVersionsManifest(value: unknown): VersionsManifest {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.channels)) {
    throw new ManifestError("Version metadata has an unsupported shape.");
  }

  const builtAt = requireNonEmptyString(value.builtAt, "build time");
  if (Number.isNaN(Date.parse(builtAt))) {
    throw new ManifestError("Version metadata contains an invalid build time.");
  }

  const manifest: VersionsManifest = {
    schemaVersion: 1,
    builtAt,
    goVersion: requireNonEmptyString(value.goVersion, "Go version"),
    wasmExec: requireNonEmptyString(value.wasmExec, "wasm_exec path"),
    channels: {
      release: decodeChannel(value.channels.release, "release"),
      main: decodeChannel(value.channels.main, "main"),
    },
  };

  if (value.releases !== undefined) {
    manifest.releases = decodeReleases(value.releases, manifest.channels.release);
  }

  if (value.presets !== undefined) {
    manifest.presets = decodePresetManifest(value.presets, manifest.channels.main);
  }

  return manifest;
}

function decodeReleases(value: unknown, latest: ManifestChannel): ManifestChannel[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) {
    throw new ManifestError("Version metadata contains invalid release history.");
  }

  const releases = value.map((entry) => decodeChannel(entry, "release"));
  const versions = new Set<string>();
  for (const release of releases) {
    if (!isStableReleaseVersion(release.version) || versions.has(release.version)) {
      throw new ManifestError("Version metadata contains invalid release history.");
    }
    versions.add(release.version);
  }

  const matchingLatest = releases.find((release) => release.version === latest.version);
  if (matchingLatest === undefined || !sameEngineArtifact(matchingLatest, latest)) {
    throw new ManifestError("Version metadata release history does not match the latest release.");
  }

  return [
    latest,
    ...releases
      .filter((release) => release.version !== latest.version)
      .sort((left, right) => compareStableVersions(right.version, left.version)),
  ];
}

function isStableReleaseVersion(version: string): boolean {
  return /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version);
}

function compareStableVersions(left: string, right: string): number {
  const leftParts = left.slice(1).split(".").map(Number);
  const rightParts = right.slice(1).split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function sameEngineArtifact(left: ManifestChannel, right: ManifestChannel): boolean {
  return (
    left.version === right.version &&
    left.commit === right.commit &&
    left.artifact === right.artifact &&
    left.sha256 === right.sha256 &&
    left.bytes === right.bytes
  );
}

function decodeChannel(value: unknown, channel: EngineChannel): ManifestChannel {
  if (!isRecord(value)) {
    throw new ManifestError(`Version metadata is missing the ${channel} engine.`);
  }

  const commit = requireNonEmptyString(value.commit, `${channel} commit`);
  if (!/^[0-9a-f]{7,64}$/i.test(commit)) {
    throw new ManifestError(`Version metadata contains an invalid ${channel} commit.`);
  }

  const sha256 = requireNonEmptyString(value.sha256, `${channel} digest`);
  if (!/^[0-9a-f]{64}$/i.test(sha256)) {
    throw new ManifestError(`Version metadata contains an invalid ${channel} digest.`);
  }
  if (!Number.isSafeInteger(value.bytes) || (value.bytes as number) <= 0) {
    throw new ManifestError(`Version metadata contains an invalid ${channel} artifact size.`);
  }

  const decoded: ManifestChannel = {
    label: requireNonEmptyString(value.label, `${channel} label`),
    version: requireNonEmptyString(value.version, `${channel} version`),
    commit,
    artifact: requireNonEmptyString(value.artifact, `${channel} artifact path`),
    sha256,
    bytes: value.bytes as number,
  };
  if (value.ci !== undefined) {
    decoded.ci = decodeCIVerification(value.ci, channel);
  }
  if (value.upstreamCI !== undefined) {
    decoded.upstreamCI = decodeUpstreamCI(value.upstreamCI, channel);
  }
  if (value.parseModes !== undefined) {
    decoded.parseModes = decodeParseModes(value.parseModes, channel);
  }
  return decoded;
}

function decodeParseModes(value: unknown, channel: EngineChannel): ParseMode[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isParseMode)) {
    throw new ManifestError(`Version metadata contains invalid ${channel} parse modes.`);
  }
  const modes = value as ParseMode[];
  if (new Set(modes).size !== modes.length) {
    throw new ManifestError(`Version metadata contains invalid ${channel} parse modes.`);
  }
  return [...modes];
}

function decodeCIVerification(value: unknown, channel: EngineChannel): EngineCIVerification {
  if (!isRecord(value) || value.conclusion !== "success") {
    throw new ManifestError(`Version metadata contains invalid ${channel} CI provenance.`);
  }

  const runId = value.runId;
  const completedAt = requireNonEmptyString(value.completedAt, `${channel} CI completion time`);
  const url = requireNonEmptyString(value.url, `${channel} CI URL`);
  if (
    !Number.isSafeInteger(runId) ||
    (runId as number) <= 0 ||
    !isValidCITimestamp(completedAt) ||
    !isExactGitHubRunUrl(url, runId as number)
  ) {
    throw new ManifestError(`Version metadata contains invalid ${channel} CI provenance.`);
  }

  const workflow = requireNonEmptyString(value.workflow, `${channel} CI workflow`);
  const path = requireNonEmptyString(value.path, `${channel} CI workflow path`);
  if (workflow !== "Go" || path !== ".github/workflows/go.yml") {
    throw new ManifestError(`Version metadata contains invalid ${channel} CI provenance.`);
  }

  return {
    workflow,
    path,
    runId: runId as number,
    url,
    conclusion: "success",
    completedAt,
  };
}

const NON_SUCCESS_CI_CONCLUSIONS = new Set<EngineCINonSuccessConclusion>([
  "action_required",
  "cancelled",
  "failure",
  "neutral",
  "skipped",
  "stale",
  "startup_failure",
  "timed_out",
]);

function decodeUpstreamCI(value: unknown, channel: EngineChannel): EngineUpstreamCI {
  if (!isRecord(value)) {
    throw new ManifestError(`Version metadata contains invalid ${channel} upstream CI status.`);
  }

  const workflow = requireNonEmptyString(value.workflow, `${channel} upstream CI workflow`);
  const path = requireNonEmptyString(value.path, `${channel} upstream CI workflow path`);
  if (workflow !== "Go" || path !== ".github/workflows/go.yml") {
    throw new ManifestError(`Version metadata contains invalid ${channel} upstream CI status.`);
  }

  if (value.status === "not_recorded" || value.status === "not_checked") {
    if (
      value.runId !== undefined ||
      value.url !== undefined ||
      value.conclusion !== undefined ||
      value.completedAt !== undefined
    ) {
      throw new ManifestError(`Version metadata contains invalid ${channel} upstream CI status.`);
    }
    return { status: value.status, workflow, path };
  }

  if (value.status !== "passed" && value.status !== "not_passed") {
    throw new ManifestError(`Version metadata contains invalid ${channel} upstream CI status.`);
  }

  const runId = value.runId;
  const url = requireNonEmptyString(value.url, `${channel} upstream CI URL`);
  const completedAt = requireNonEmptyString(
    value.completedAt,
    `${channel} upstream CI completion time`,
  );
  const conclusion = value.conclusion;
  const validConclusion =
    value.status === "passed"
      ? conclusion === "success"
      : NON_SUCCESS_CI_CONCLUSIONS.has(conclusion as EngineCINonSuccessConclusion);
  if (
    !Number.isSafeInteger(runId) ||
    (runId as number) <= 0 ||
    !isExactGitHubRunUrl(url, runId as number) ||
    !isValidCITimestamp(completedAt) ||
    !validConclusion
  ) {
    throw new ManifestError(`Version metadata contains invalid ${channel} upstream CI status.`);
  }

  if (value.status === "passed") {
    return {
      status: "passed",
      workflow,
      path,
      runId: runId as number,
      url,
      conclusion: "success",
      completedAt,
    };
  }
  return {
    status: "not_passed",
    workflow,
    path,
    runId: runId as number,
    url,
    conclusion: conclusion as EngineCINonSuccessConclusion,
    completedAt,
  };
}

function isExactGitHubRunUrl(url: string, runId: number): boolean {
  return url === `https://github.com/cloudspannerecosystem/memefish/actions/runs/${String(runId)}`;
}

function isValidCITimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/.exec(value);
  if (match === null) {
    return false;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return false;
  }
  const normalized = match[7] === undefined ? value.replace(/Z$/, ".000Z") : value;
  return date.toISOString() === normalized;
}

function decodePresetManifest(value: unknown, main: ManifestChannel): PresetManifest {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.channel !== "main") {
    throw new ManifestError("Version metadata contains invalid preset metadata.");
  }

  const commit = requireNonEmptyString(value.commit, "preset commit");
  if (commit !== main.commit) {
    throw new ManifestError("Version metadata preset commit does not match the main engine.");
  }

  const sha256 = requireNonEmptyString(value.sha256, "preset digest");
  if (!/^[0-9a-f]{64}$/i.test(sha256)) {
    throw new ManifestError("Version metadata contains an invalid preset digest.");
  }

  const artifact = requireNonEmptyString(value.artifact, "preset artifact path");
  const artifactName = artifact.slice(artifact.lastIndexOf("/") + 1).toLowerCase();
  if (!artifactName.includes(sha256.toLowerCase())) {
    throw new ManifestError("Version metadata preset artifact is not content-addressed.");
  }

  return {
    schemaVersion: 1,
    channel: "main",
    commit,
    artifact,
    sha256,
    bytes: requireBoundedInteger(value.bytes, "preset artifact size", 1, 32 * 1024 * 1024),
    count: requireBoundedInteger(value.count, "preset count", 1, 4_096),
    sourceBytes: requireBoundedInteger(
      value.sourceBytes,
      "preset source size",
      1,
      16 * 1024 * 1024,
    ),
  };
}

function requireBoundedInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ManifestError(`Version metadata contains an invalid ${field}.`);
  }
  return value as number;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ManifestError(`Version metadata contains an invalid ${field}.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
