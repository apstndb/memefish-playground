import type { EngineChannel, EngineIdentity } from "./protocol";

export interface ManifestChannel {
  label: string;
  version: string;
  commit: string;
  artifact: string;
  sha256: string;
  bytes: number;
}

export interface VersionsManifest {
  schemaVersion: 1;
  builtAt: string;
  goVersion: string;
  wasmExec: string;
  channels: Record<EngineChannel, ManifestChannel>;
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

  return {
    ...manifest,
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

  return {
    schemaVersion: 1,
    builtAt,
    goVersion: requireNonEmptyString(value.goVersion, "Go version"),
    wasmExec: requireNonEmptyString(value.wasmExec, "wasm_exec path"),
    channels: {
      release: decodeChannel(value.channels.release, "release"),
      main: decodeChannel(value.channels.main, "main"),
    },
  };
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
  if (!Number.isSafeInteger(value.bytes) || (value.bytes as number) < 0) {
    throw new ManifestError(`Version metadata contains an invalid ${channel} artifact size.`);
  }

  return {
    label: requireNonEmptyString(value.label, `${channel} label`),
    version: requireNonEmptyString(value.version, `${channel} version`),
    commit,
    artifact: requireNonEmptyString(value.artifact, `${channel} artifact path`),
    sha256,
    bytes: value.bytes as number,
  };
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
