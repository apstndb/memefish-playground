#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const modulePath = "github.com/cloudspannerecosystem/memefish";
const upstream = "cloudspannerecosystem/memefish";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outputDir = resolve(root, "public/wasm");
const maxOutput = 32 * 1024 * 1024;

const selectedChannels = ["release", "main"];

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

async function main() {
  const refs = await resolveRefs();
  const tempRoot = mkdtempSync(join(tmpdir(), "memefish-playground-"));

  rmSync(outputDir, { force: true, recursive: true });
  mkdirSync(outputDir, { recursive: true });

  try {
    const goVersion = run("go", ["env", "GOVERSION"]);
    const goRoot = run("go", ["env", "GOROOT"]);
    const playgroundCommit = process.env.GITHUB_SHA ?? safeRun("git", ["rev-parse", "HEAD"]);
    const channels = {};

    for (const channel of selectedChannels) {
      const ref = refs[channel];
      channels[channel] = buildChannel({
        channel,
        ref,
        tempRoot,
        goVersion,
      });
    }

    const wasmExecSource = join(goRoot, "lib/wasm/wasm_exec.js");
    const wasmExecDigest = sha256File(wasmExecSource);
    const wasmExecName = `wasm_exec-${wasmExecDigest.slice(0, 16)}.js`;
    copyFileSync(wasmExecSource, join(outputDir, wasmExecName));

    const manifest = {
      schemaVersion: 1,
      builtAt: process.env.MEMEFISH_BUILD_TIME ?? new Date().toISOString(),
      playgroundCommit,
      goVersion,
      wasmExec: wasmExecName,
      channels,
    };

    writeFileSync(
      join(outputDir, "versions.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );

    for (const [channel, metadata] of Object.entries(channels)) {
      process.stdout.write(
        `${channel}: ${metadata.version} @ ${metadata.commit.slice(0, 12)} ` +
          `(${formatBytes(metadata.bytes)}, sha256 ${metadata.sha256.slice(0, 16)}…)\n`,
      );
    }
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
}

function buildChannel({ channel, ref, tempRoot, goVersion }) {
  const download = JSON.parse(
    run("go", ["mod", "download", "-json", `${modulePath}@${ref.commit}`]),
  );

  const originCommit = download.Origin?.Hash;
  if (originCommit !== ref.commit) {
    throw new Error(
      `resolved ${channel} origin ${originCommit ?? "<missing>"}; expected ${ref.commit}`,
    );
  }
  if (typeof download.Version !== "string" || download.Version.length === 0) {
    throw new Error(`go mod download did not return a version for ${channel}`);
  }

  const modFile = join(tempRoot, `${channel}.mod`);
  const sumFile = join(tempRoot, `${channel}.sum`);
  copyFileSync(join(root, "go.mod"), modFile);
  if (existsSync(join(root, "go.sum"))) {
    copyFileSync(join(root, "go.sum"), sumFile);
  }

  run("go", [
    "mod",
    "edit",
    `-modfile=${modFile}`,
    `-require=${modulePath}@${download.Version}`,
  ]);
  run("go", ["mod", "tidy", `-modfile=${modFile}`]);

  const temporaryArtifact = join(tempRoot, `${channel}.wasm`);
  const ldflags = [
    "-s",
    "-w",
    `-X=main.buildChannel=${channel}`,
    `-X=main.buildVersion=${channel === "release" ? ref.label : download.Version}`,
    `-X=main.buildCommit=${ref.commit}`,
  ].join(" ");

  run(
    "go",
    [
      "build",
      `-modfile=${modFile}`,
      "-mod=readonly",
      "-trimpath",
      "-buildvcs=false",
      `-ldflags=${ldflags}`,
      "-o",
      temporaryArtifact,
      "./cmd/wasm",
    ],
    {
      CGO_ENABLED: "0",
      GOARCH: "wasm",
      GOOS: "js",
      GOTOOLCHAIN: "local",
    },
  );

  const digest = sha256File(temporaryArtifact);
  const artifact = `memefish-${channel}-${digest.slice(0, 16)}.wasm`;
  renameSync(temporaryArtifact, join(outputDir, artifact));

  return {
    label: channel === "release" ? "Latest release" : "main snapshot",
    version: channel === "release" ? ref.label : download.Version,
    commit: ref.commit,
    artifact,
    sha256: digest,
    bytes: statSync(join(outputDir, artifact)).size,
    moduleSum: download.Sum ?? "",
    goModSum: download.GoModSum ?? "",
    sourceTime: download.Time ?? "",
    goVersion,
  };
}

async function resolveRefs() {
  const releaseTag =
    process.env.MEMEFISH_RELEASE_TAG ??
    (await githubJSON(`/repos/${upstream}/releases/latest`)).tag_name;
  if (typeof releaseTag !== "string" || releaseTag.length === 0) {
    throw new Error("GitHub latest release response did not contain tag_name");
  }

  const releaseCommit =
    process.env.MEMEFISH_RELEASE_SHA ??
    (await githubJSON(`/repos/${upstream}/commits/${encodeURIComponent(releaseTag)}`)).sha;
  const mainCommit =
    process.env.MEMEFISH_MAIN_SHA ??
    (await githubJSON(`/repos/${upstream}/commits/main`)).sha;

  assertCommit(releaseCommit, "release");
  assertCommit(mainCommit, "main");

  return {
    release: { label: releaseTag, commit: releaseCommit },
    main: { label: "main snapshot", commit: mainCommit },
  };
}

async function githubJSON(path) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "memefish-playground-build",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`https://api.github.com${path}`, { headers });
  if (!response.ok) {
    throw new Error(`GitHub API ${path} failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

function run(command, args, extraEnv = {}) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
    maxBuffer: maxOutput,
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

function safeRun(command, args) {
  try {
    return run(command, args);
  } catch {
    return "unknown";
  }
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assertCommit(value, channel) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`invalid ${channel} commit from GitHub: ${String(value)}`);
  }
}

function formatBytes(bytes) {
  const mebibytes = bytes / (1024 * 1024);
  return `${mebibytes.toFixed(2)} MiB`;
}
