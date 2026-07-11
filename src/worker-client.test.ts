import { describe, expect, it, vi } from "vitest";
import type { ResolvedEngine } from "./manifest";
import type { EngineChannel, EngineIdentity, ParseResponse } from "./protocol";
import {
  MemefishClient,
  type WorkerErrorEvent,
  type WorkerLike,
  type WorkerMessageEvent,
} from "./worker-client";

class FakeWorker implements WorkerLike {
  onmessage: ((event: WorkerMessageEvent) => void) | null = null;
  onerror: ((event: WorkerErrorEvent) => void) | null = null;
  readonly posted: unknown[] = [];
  terminated = false;

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(message: unknown): void {
    this.onmessage?.({ data: message });
  }
}

describe("MemefishClient", () => {
  it("queues until ready and rejects stale requests and generations", () => {
    const workers: FakeWorker[] = [];
    const onResponse = vi.fn();
    const onError = vi.fn();
    const client = new MemefishClient(
      {
        onLoading: vi.fn(),
        onReady: vi.fn(),
        onResponse,
        onError,
      },
      () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
    );

    const release = makeEngine("release");
    client.selectEngine(release);
    const releaseWorker = requireWorker(workers, 0);
    const staleGenerationHandler = releaseWorker.onmessage;
    const queuedId = client.parse("statement", "SELECT 1");
    expect(queuedId).toBe("1:1");
    expect(releaseWorker.posted).toHaveLength(1);

    releaseWorker.emit(JSON.stringify(readyMessage(release)));
    expect(JSON.parse(releaseWorker.posted[1] as string)).toMatchObject({
      id: "1:1",
      mode: "statement",
      source: "SELECT 1",
    });

    const latestId = client.parse("statement", "SELECT 2");
    expect(latestId).toBe("1:2");
    releaseWorker.emit(JSON.stringify(parseResponse(release, "1:1", "SELECT 1")));
    expect(onResponse).not.toHaveBeenCalled();
    releaseWorker.emit(JSON.stringify(parseResponse(release, "1:2", "SELECT 2")));
    expect(onResponse).toHaveBeenCalledTimes(1);

    const invalidatedId = client.parse("statement", "SELECT before edit");
    expect(invalidatedId).toBe("1:3");
    client.invalidateRequests();
    releaseWorker.emit(JSON.stringify(parseResponse(release, "1:3", "SELECT response after edit")));
    expect(onResponse).toHaveBeenCalledTimes(1);

    const main = makeEngine("main");
    client.selectEngine(main);
    expect(releaseWorker.terminated).toBe(true);
    staleGenerationHandler?.({
      data: JSON.stringify(parseResponse(release, "1:2", "SELECT stale")),
    });
    expect(onResponse).toHaveBeenCalledTimes(1);

    const mainWorker = requireWorker(workers, 1);
    expect(client.parse("query", "SELECT 3")).toBe("2:4");
    mainWorker.emit(JSON.stringify(readyMessage(main)));
    mainWorker.emit(JSON.stringify(parseResponse(main, "2:4", "SELECT 3")));
    expect(onResponse).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
  });

  it("terminates the worker when a bridge message is malformed", () => {
    const workers: FakeWorker[] = [];
    const onError = vi.fn();
    const client = new MemefishClient(
      {
        onLoading: vi.fn(),
        onReady: vi.fn(),
        onResponse: vi.fn(),
        onError,
      },
      () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
    );

    client.selectEngine(makeEngine("release"));
    const worker = requireWorker(workers, 0);
    worker.emit("not json");

    expect(worker.terminated).toBe(true);
    expect(onError).toHaveBeenCalledWith("The WebAssembly bridge returned invalid JSON.");
  });
});

function makeEngine(channel: EngineChannel): ResolvedEngine {
  const commit =
    channel === "release"
      ? "24fc9334defa75de8d8ca1afc9d7205d2c8c5bf9"
      : "fd610852d27f8b6cf3f0202398cfaa00ead90ce7";
  return {
    channel,
    label: channel === "release" ? "Latest release" : "main snapshot",
    version: channel === "release" ? "v0.8.0" : "v0.8.1-main",
    commit,
    artifact: `memefish-${channel}.wasm`,
    sha256: "a".repeat(64),
    bytes: 2_000_000,
    wasmUrl: `https://example.test/wasm/memefish-${channel}.wasm`,
    wasmExecUrl: "https://example.test/wasm/wasm_exec.js",
    builtAt: "2026-07-11T03:04:05Z",
    goVersion: "go1.26.5",
  };
}

function readyMessage(engine: ResolvedEngine) {
  return {
    type: "ready",
    protocolVersion: 1,
    engine: identity(engine),
  };
}

function parseResponse(engine: ResolvedEngine, id: string, sql: string): ParseResponse {
  return {
    protocolVersion: 1,
    id,
    ok: true,
    engine: identity(engine),
    results: [
      {
        nodeType: "QueryStatement",
        range: { startByte: 0, endByte: sql.length, from: 0, to: sql.length },
        sql,
        ast: { type: "QueryStatement", fields: {} },
      },
    ],
    diagnostics: [],
    fatal: null,
  };
}

function identity(engine: ResolvedEngine): EngineIdentity {
  return {
    channel: engine.channel,
    version: engine.version,
    commit: engine.commit,
    goVersion: engine.goVersion,
  };
}

function requireWorker(workers: FakeWorker[], index: number): FakeWorker {
  const worker = workers[index];
  if (worker === undefined) {
    throw new Error(`Worker ${index} was not created.`);
  }
  return worker;
}
