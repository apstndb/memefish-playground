import { expectedEngineIdentity, type ResolvedEngine } from "./manifest";
import {
  decodeBridgeMessage,
  type EngineIdentity,
  makeParseRequest,
  type ParseMode,
  type ParseRequest,
  type ParseResponse,
  ProtocolError,
} from "./protocol";

export interface WorkerMessageEvent {
  data: unknown;
}

export interface WorkerErrorEvent {
  message?: string;
  preventDefault?(): void;
}

export interface WorkerLike {
  onmessage: ((event: WorkerMessageEvent) => void) | null;
  onerror: ((event: WorkerErrorEvent) => void) | null;
  postMessage(message: unknown): void;
  terminate(): void;
}

export type WorkerFactory = () => WorkerLike;

export interface MemefishClientEvents {
  onLoading(engine: ResolvedEngine): void;
  onReady(engine: EngineIdentity): void;
  onResponse(response: ParseResponse): void;
  onError(message: string): void;
}

const createWorker: WorkerFactory = () =>
  new Worker(new URL("./memefish.worker.ts", import.meta.url), {
    type: "module",
  }) as unknown as WorkerLike;

export class MemefishClient {
  private readonly events: MemefishClientEvents;
  private readonly workerFactory: WorkerFactory;
  private worker: WorkerLike | null = null;
  private engine: ResolvedEngine | null = null;
  private generation = 0;
  private requestSequence = 0;
  private latestRequestId: string | null = null;
  private pendingRequest: ParseRequest | null = null;
  private ready = false;

  constructor(events: MemefishClientEvents, workerFactory: WorkerFactory = createWorker) {
    this.events = events;
    this.workerFactory = workerFactory;
  }

  selectEngine(engine: ResolvedEngine): void {
    this.stopWorker();

    const generation = ++this.generation;
    const worker = this.workerFactory();
    this.worker = worker;
    this.engine = engine;
    this.ready = false;
    this.latestRequestId = null;
    this.pendingRequest = null;

    worker.onmessage = (event) => this.handleMessage(generation, event.data);
    worker.onerror = (event) => {
      event.preventDefault?.();
      if (generation === this.generation) {
        this.fail(event.message ?? "The WebAssembly worker stopped unexpectedly.");
      }
    };
    worker.postMessage({
      type: "initialize",
      wasmExecUrl: engine.wasmExecUrl,
      wasmUrl: engine.wasmUrl,
      wasmBytes: engine.bytes,
      wasmSha256: engine.sha256,
    });
    this.events.onLoading(engine);
  }

  parse(mode: ParseMode, source: string): string | null {
    if (this.worker === null || this.engine === null) {
      return null;
    }

    const id = `${this.generation}:${++this.requestSequence}`;
    const request = makeParseRequest(id, mode, source);
    this.latestRequestId = id;

    if (this.ready) {
      this.worker.postMessage(JSON.stringify(request));
    } else {
      this.pendingRequest = request;
    }
    return id;
  }

  invalidateRequests(): void {
    this.latestRequestId = null;
    this.pendingRequest = null;
  }

  dispose(): void {
    ++this.generation;
    this.stopWorker();
    this.engine = null;
  }

  private handleMessage(generation: number, data: unknown): void {
    if (generation !== this.generation || this.worker === null || this.engine === null) {
      return;
    }

    if (isWorkerError(data)) {
      this.fail(data.message);
      return;
    }

    try {
      const message = decodeBridgeMessage(data);
      if (!sameEngine(message.engine, expectedEngineIdentity(this.engine))) {
        throw new ProtocolError("The loaded engine does not match its version metadata.");
      }

      if ("type" in message) {
        this.ready = true;
        this.events.onReady(message.engine);
        if (this.pendingRequest !== null) {
          this.worker.postMessage(JSON.stringify(this.pendingRequest));
          this.pendingRequest = null;
        }
        return;
      }

      if (message.id !== this.latestRequestId) {
        return;
      }
      this.events.onResponse(message);
    } catch (error) {
      this.fail(
        error instanceof Error
          ? error.message
          : "The WebAssembly bridge returned an invalid message.",
      );
    }
  }

  private fail(message: string): void {
    this.stopWorker();
    this.events.onError(message);
  }

  private stopWorker(): void {
    if (this.worker !== null) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.terminate();
      this.worker = null;
    }
    this.ready = false;
    this.pendingRequest = null;
  }
}

function isWorkerError(value: unknown): value is { type: "worker_error"; message: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const message = value as Record<string, unknown>;
  return message.type === "worker_error" && typeof message.message === "string";
}

function sameEngine(left: EngineIdentity, right: EngineIdentity): boolean {
  return (
    left.channel === right.channel &&
    left.version === right.version &&
    left.commit === right.commit &&
    left.goVersion === right.goVersion
  );
}
