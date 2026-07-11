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

const modulePath = "github.com/cloudspannerecosystem/memefish";
const upstream = "cloudspannerecosystem/memefish";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const publicDir = resolve(root, "public");
const finalOutputDir = resolve(publicDir, "wasm");
const govulncheckPackage = "golang.org/x/vuln/cmd/govulncheck@v1.6.0";
const maxOutput = 32 * 1024 * 1024;

const selectedChannels = ["release", "main"];

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
    const channels = {};

    for (const channel of selectedChannels) {
      const ref = refs[channel];
      channels[channel] = buildChannel({
        channel,
        ref,
        tempRoot,
        goVersion,
        govulncheck,
        outputDir: stagingOutputDir,
      });
    }

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
    };

    writeFileSync(
      join(stagingOutputDir, "versions.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );

    installOutput(stagingOutputDir);

    for (const [channel, metadata] of Object.entries(channels)) {
      process.stdout.write(
        `${channel}: ${metadata.version} @ ${metadata.commit.slice(0, 12)} ` +
          `(${formatBytes(metadata.bytes)}, sha256 ${metadata.sha256.slice(0, 16)}…)\n`,
      );
    }
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
    rmSync(stagingOutputDir, { force: true, recursive: true });
  }
}

function buildChannel({ channel, ref, tempRoot, goVersion, govulncheck, outputDir }) {
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

  run("go", ["mod", "edit", `-modfile=${modFile}`, `-require=${modulePath}@${download.Version}`]);
  run("go", ["mod", "tidy", `-modfile=${modFile}`]);

  if (govulncheck !== null) {
    scanChannel(govulncheck, channel, modFile, sumFile, tempRoot);
  }

  const temporaryArtifact = join(outputDir, `.${channel}.wasm.tmp`);
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

function installGovulncheck(tempRoot) {
  run("go", ["install", govulncheckPackage], { GOBIN: tempRoot });
  return join(tempRoot, process.platform === "win32" ? "govulncheck.exe" : "govulncheck");
}

function scanChannel(govulncheck, channel, modFile, sumFile, tempRoot) {
  // govulncheck's package loader does not honor -modfile reliably. Give it an
  // isolated copy with the resolved channel module files instead, so it scans
  // the exact dependency graph used by the corresponding WASM build.
  const scanRoot = join(tempRoot, `${channel}-scan`);
  mkdirSync(scanRoot, { recursive: true });
  copyFileSync(modFile, join(scanRoot, "go.mod"));
  copyFileSync(sumFile, join(scanRoot, "go.sum"));
  cpSync(join(root, "cmd"), join(scanRoot, "cmd"), { recursive: true });
  cpSync(join(root, "internal"), join(scanRoot, "internal"), { recursive: true });

  process.stdout.write(`govulncheck: scanning ${channel} WASM dependency graph\n`);
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
    },
    true,
  );
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

  if (releaseTag && releaseCommit && mainCommit) {
    assertCommit(releaseCommit, "release");
    assertCommit(mainCommit, "main");
    return {
      release: { label: releaseTag, commit: releaseCommit },
      main: { label: "main snapshot", commit: mainCommit },
    };
  }

  try {
    return await resolveRefsFromGitHub();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `GitHub ref resolution failed (${message}); falling back to Go module queries.\n`,
    );
    return resolveRefsFromGo();
  }
}

async function resolveRefsFromGitHub() {
  const releaseTag = (await githubJSON(`/repos/${upstream}/releases/latest`)).tag_name;
  if (typeof releaseTag !== "string" || releaseTag.length === 0) {
    throw new Error("GitHub latest release response did not contain tag_name");
  }

  const releaseCommit = (
    await githubJSON(`/repos/${upstream}/commits/${encodeURIComponent(releaseTag)}`)
  ).sha;
  const mainCommit = (await githubJSON(`/repos/${upstream}/commits/main`)).sha;

  assertCommit(releaseCommit, "release");
  assertCommit(mainCommit, "main");

  return {
    release: { label: releaseTag, commit: releaseCommit },
    main: { label: "main snapshot", commit: mainCommit },
  };
}

function resolveRefsFromGo() {
  const release = goModuleQuery("latest");
  const main = goModuleQuery("main");
  return {
    release: { label: release.Version, commit: release.Origin.Hash },
    main: { label: "main snapshot", commit: main.Origin.Hash },
  };
}

function goModuleQuery(query) {
  const metadata = JSON.parse(
    run("go", ["list", "-m", "-json", `${modulePath}@${query}`], {
      GOPROXY: "direct",
    }),
  );
  if (typeof metadata.Version !== "string" || metadata.Version.length === 0) {
    throw new Error(`Go module query @${query} did not return a version`);
  }
  assertCommit(metadata.Origin?.Hash, query);
  return metadata;
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

function formatBytes(bytes) {
  const mebibytes = bytes / (1024 * 1024);
  return `${mebibytes.toFixed(2)} MiB`;
}
