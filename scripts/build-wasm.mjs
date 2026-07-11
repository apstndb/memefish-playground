#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
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
import { capabilitiesForMemefishVersion } from "./memefish-capabilities.mjs";
import { buildPresetCatalog } from "./preset-catalog.mjs";
import { notCheckedCIMetadata, resolveMemefishRefs } from "./resolve-memefish-refs.mjs";

const modulePath = "github.com/cloudspannerecosystem/memefish";
const upstream = "cloudspannerecosystem/memefish";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const publicDir = resolve(root, "public");
const finalOutputDir = resolve(publicDir, "wasm");
const govulncheckPackage = "golang.org/x/vuln/cmd/govulncheck@v1.6.0";
const maxOutput = 32 * 1024 * 1024;

main().catch((error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const refs = await resolveRefs();
  const tempRoot = mkdtempSync(join(tmpdir(), "memefish-playground-"));
  mkdirSync(publicDir, { recursive: true });
  const stagingOutputDir = mkdtempSync(join(publicDir, ".wasm-stage-"));

  try {
    const goVersion = run("go", ["env", "GOVERSION"]);
    const goRoot = run("go", ["env", "GOROOT"]);
    const playgroundCommit = process.env.GITHUB_SHA ?? safeRun("git", ["rev-parse", "HEAD"]);
    const govulncheck = options.vulncheck ? installGovulncheck(tempRoot) : null;
    const builtReleases = refs.releases.map(
      (ref) =>
        buildChannel({
          channel: "release",
          buildKey: `release-${ref.label}`,
          ref,
          tempRoot,
          goVersion,
          govulncheck,
          outputDir: stagingOutputDir,
        }).metadata,
    );
    const defaultRelease = builtReleases.find(
      (metadata) =>
        metadata.version === refs.release.label && metadata.commit === refs.release.commit,
    );
    if (defaultRelease === undefined) {
      throw new Error("default published release was not built");
    }
    const releases = [
      defaultRelease,
      ...builtReleases.filter((metadata) => metadata !== defaultRelease),
    ];
    const mainResult = buildChannel({
      channel: "main",
      buildKey: "main",
      ref: refs.main,
      tempRoot,
      goVersion,
      govulncheck,
      outputDir: stagingOutputDir,
    });
    if (mainResult.presets === null) {
      throw new Error("main preset catalog was not generated");
    }
    const channels = {
      release: defaultRelease,
      main: mainResult.metadata,
    };

    const wasmExecSource = join(goRoot, "lib/wasm/wasm_exec.js");
    const wasmExecDigest = sha256File(wasmExecSource);
    const wasmExecName = `wasm_exec-${wasmExecDigest.slice(0, 16)}.js`;
    copyFileSync(wasmExecSource, join(stagingOutputDir, wasmExecName));

    const manifest = {
      schemaVersion: 1,
      builtAt: process.env.MEMEFISH_BUILD_TIME ?? new Date().toISOString(),
      playgroundCommit,
      goVersion,
      wasmExec: wasmExecName,
      channels,
      releases,
      presets: mainResult.presets,
    };

    writeFileSync(
      join(stagingOutputDir, "versions.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );

    installOutput(stagingOutputDir);

    for (const metadata of releases) {
      process.stdout.write(
        `release: ${metadata.version} @ ${metadata.commit.slice(0, 12)} ` +
          `(${formatBytes(metadata.bytes)}, sha256 ${metadata.sha256.slice(0, 16)}…)\n`,
      );
    }
    process.stdout.write(
      `main: ${channels.main.version} @ ${channels.main.commit.slice(0, 12)} ` +
        `(${formatBytes(channels.main.bytes)}, sha256 ${channels.main.sha256.slice(0, 16)}…)\n`,
    );
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
    rmSync(stagingOutputDir, { force: true, recursive: true });
  }
}

function buildChannel({ channel, buildKey, ref, tempRoot, goVersion, govulncheck, outputDir }) {
  // Resolve releases by their exact semantic-version tag so the module version
  // and checksum remain version-specific even if two tags point at one commit.
  // The Origin hash check below still pins the downloaded source to the SHA
  // independently resolved from GitHub. main has no tag, so it uses the SHA.
  const moduleQuery = channel === "release" ? ref.label : ref.commit;
  const download = JSON.parse(
    run("go", ["mod", "download", "-json", `${modulePath}@${moduleQuery}`]),
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
  if (typeof download.Dir !== "string" || download.Dir.length === 0) {
    throw new Error(`go mod download did not return a source directory for ${channel}`);
  }
  if (typeof download.Sum !== "string" || download.Sum.length === 0) {
    throw new Error(`go mod download did not return a module sum for ${channel}`);
  }
  const capabilities = capabilitiesForMemefishVersion(download.Version);

  const presets =
    channel === "main"
      ? buildPresetCatalog({
          inputDir: join(download.Dir, "testdata", "input"),
          outputDir,
          channel,
          version: download.Version,
          commit: ref.commit,
          moduleSum: download.Sum,
        })
      : null;

  const modFile = join(tempRoot, `${buildKey}.mod`);
  const sumFile = join(tempRoot, `${buildKey}.sum`);
  copyFileSync(join(root, "go.mod"), modFile);
  if (existsSync(join(root, "go.sum"))) {
    copyFileSync(join(root, "go.sum"), sumFile);
  }

  run("go", ["mod", "edit", `-modfile=${modFile}`, `-require=${modulePath}@${download.Version}`]);
  run("go", ["mod", "tidy", `-modfile=${modFile}`]);

  if (govulncheck !== null) {
    scanChannel(govulncheck, buildKey, modFile, sumFile, tempRoot, capabilities.buildTags);
  }

  const temporaryArtifact = join(outputDir, `.${buildKey}.wasm.tmp`);
  const ldflags = [
    "-s",
    "-w",
    `-X=main.channel=${channel}`,
    `-X=main.version=${channel === "release" ? ref.label : download.Version}`,
    `-X=main.commit=${ref.commit}`,
  ].join(" ");

  run(
    "go",
    [
      "build",
      ...buildTagArgs(capabilities.buildTags),
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
  const artifact = `memefish-${buildKey}-${digest.slice(0, 16)}.wasm`;
  renameSync(temporaryArtifact, join(outputDir, artifact));

  return {
    metadata: {
      label: channel === "release" ? ref.label : "main snapshot",
      version: channel === "release" ? ref.label : download.Version,
      commit: ref.commit,
      artifact,
      sha256: digest,
      bytes: statSync(join(outputDir, artifact)).size,
      moduleSum: download.Sum,
      goModSum: download.GoModSum ?? "",
      sourceTime: download.Time ?? "",
      goVersion,
      parseModes: capabilities.parseModes,
      upstreamCI: ref.upstreamCI,
    },
    presets,
  };
}

function installGovulncheck(tempRoot) {
  run("go", ["install", govulncheckPackage], { GOBIN: tempRoot });
  return join(tempRoot, process.platform === "win32" ? "govulncheck.exe" : "govulncheck");
}

function scanChannel(govulncheck, buildKey, modFile, sumFile, tempRoot, buildTags) {
  // govulncheck's package loader does not honor -modfile reliably. Give it an
  // isolated copy with the resolved channel module files instead, so it scans
  // the exact dependency graph used by the corresponding WASM build.
  const scanRoot = join(tempRoot, `${buildKey}-scan`);
  mkdirSync(scanRoot, { recursive: true });
  copyFileSync(modFile, join(scanRoot, "go.mod"));
  copyFileSync(sumFile, join(scanRoot, "go.sum"));
  cpSync(join(root, "cmd"), join(scanRoot, "cmd"), { recursive: true });
  cpSync(join(root, "internal"), join(scanRoot, "internal"), { recursive: true });

  process.stdout.write(`govulncheck: scanning ${buildKey} WASM dependency graph\n`);
  run(
    govulncheck,
    ["-C", scanRoot, "./..."],
    {
      CGO_ENABLED: "0",
      GOCACHE: process.env.GOCACHE ?? join(tmpdir(), "memefish-playground-go-build"),
      GOARCH: "wasm",
      GOOS: "js",
      GOTOOLCHAIN: "local",
      GOWORK: "off",
      ...(buildTags.length === 0 ? {} : { GOFLAGS: `-tags=${buildTags.join(",")}` }),
    },
    true,
  );
}

function buildTagArgs(buildTags) {
  return buildTags.length === 0 ? [] : [`-tags=${buildTags.join(",")}`];
}

function installOutput(stagingOutputDir) {
  const backupDir = join(publicDir, `.wasm-previous-${process.pid}-${Date.now()}`);
  const hadPreviousOutput = existsSync(finalOutputDir);

  if (hadPreviousOutput) {
    renameSync(finalOutputDir, backupDir);
  }
  try {
    renameSync(stagingOutputDir, finalOutputDir);
  } catch (error) {
    if (hadPreviousOutput) {
      renameSync(backupDir, finalOutputDir);
    }
    throw error;
  }
  if (hadPreviousOutput) {
    rmSync(backupDir, { force: true, recursive: true });
  }
}

function parseOptions(args) {
  const unknown = args.filter((argument) => argument !== "--vulncheck");
  if (unknown.length > 0) {
    throw new Error(`unknown argument: ${unknown.join(", ")}`);
  }
  return { vulncheck: args.includes("--vulncheck") };
}

async function resolveRefs() {
  const releaseTag = process.env.MEMEFISH_RELEASE_TAG;
  const releaseCommit = process.env.MEMEFISH_RELEASE_SHA;
  const mainCommit = process.env.MEMEFISH_MAIN_SHA;

  const overrides = [releaseTag, releaseCommit, mainCommit];
  if (overrides.some(Boolean) && !overrides.every(Boolean)) {
    throw new Error(
      "MEMEFISH_RELEASE_TAG, MEMEFISH_RELEASE_SHA, and MEMEFISH_MAIN_SHA must be set together",
    );
  }

  if (releaseTag && releaseCommit && mainCommit) {
    assertReleaseTag(releaseTag);
    assertCommit(releaseCommit, "release");
    assertCommit(mainCommit, "main");
    const release = {
      label: releaseTag,
      commit: releaseCommit,
      upstreamCI: notCheckedCIMetadata(),
    };
    return {
      release,
      releases: [release],
      main: {
        label: "main snapshot",
        commit: mainCommit,
        upstreamCI: notCheckedCIMetadata(),
      },
    };
  }

  // GitHub metadata lookup failures and build failures are fatal. Installation
  // is atomic, so the previously deployed site remains available instead of
  // falling back to an older release or an unverified main commit.
  return resolveMemefishRefs({ githubJSON, upstream });
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

function run(command, args, extraEnv = {}, inheritOutput = false) {
  const toolEnv =
    command === "go"
      ? {
          GOCACHE: process.env.GOCACHE ?? join(tmpdir(), "memefish-playground-go-build"),
          GOTOOLCHAIN: "local",
        }
      : {};
  const output = execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...toolEnv, ...extraEnv },
    maxBuffer: maxOutput,
    stdio: inheritOutput ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "inherit"],
  });
  return typeof output === "string" ? output.trim() : "";
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
    throw new Error(`invalid ${channel} commit: ${String(value)}`);
  }
}

function assertReleaseTag(value) {
  if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value)) {
    throw new Error(`invalid release tag: ${String(value)}`);
  }
}

function formatBytes(bytes) {
  const mebibytes = bytes / (1024 * 1024);
  return `${mebibytes.toFixed(2)} MiB`;
}
