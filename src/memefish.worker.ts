interface InitializeWorkerMessage {
  type: "initialize";
  wasmExecUrl: string;
  wasmUrl: string;
}

interface GoRuntime {
  importObject: WebAssembly.Imports;
  run(instance: WebAssembly.Instance): Promise<void>;
}

interface WorkerGlobals {
  Go?: new () => GoRuntime;
  __memefishParse?: (requestJSON: string) => string;
  postMessage(message: unknown): void;
}

const workerGlobals = globalThis as unknown as WorkerGlobals;
let initialized = false;

globalThis.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (typeof event.data === "string") {
    invokeParser(event.data);
    return;
  }
  if (!isInitializeMessage(event.data) || initialized) {
    return;
  }
  initialized = true;
  void initialize(event.data).catch(reportWorkerFailure);
});

async function initialize(message: InitializeWorkerMessage): Promise<void> {
  await import(/* @vite-ignore */ message.wasmExecUrl);

  const Go = workerGlobals.Go;
  if (Go === undefined) {
    throw new Error("wasm_exec.js did not install the Go runtime.");
  }

  const go = new Go();
  const { instance } = await instantiateGo(message.wasmUrl, go.importObject);
  void go.run(instance).catch(reportWorkerFailure);
}

function invokeParser(requestJSON: string): void {
  const parse = workerGlobals.__memefishParse;
  if (parse === undefined) {
    reportWorkerFailure(new Error("The WebAssembly parser is not ready."));
    return;
  }

  try {
    const responseJSON = parse(requestJSON);
    if (typeof responseJSON !== "string") {
      throw new Error("The WebAssembly parser returned a non-string response.");
    }
    workerGlobals.postMessage(responseJSON);
  } catch (error) {
    reportWorkerFailure(error);
  }
}

async function instantiateGo(
  wasmUrl: string,
  importObject: WebAssembly.Imports,
): Promise<WebAssembly.WebAssemblyInstantiatedSource> {
  const response = await fetch(wasmUrl);
  if (!response.ok) {
    throw new Error(`WebAssembly could not be loaded (HTTP ${response.status}).`);
  }

  const fallbackResponse = response.clone();
  try {
    return await WebAssembly.instantiateStreaming(response, importObject);
  } catch {
    return WebAssembly.instantiate(await fallbackResponse.arrayBuffer(), importObject);
  }
}

function isInitializeMessage(value: unknown): value is InitializeWorkerMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const message = value as Record<string, unknown>;
  return (
    message.type === "initialize" &&
    typeof message.wasmExecUrl === "string" &&
    typeof message.wasmUrl === "string"
  );
}

function reportWorkerFailure(error: unknown): void {
  workerGlobals.postMessage({
    type: "worker_error",
    message:
      error instanceof Error ? error.message : "The WebAssembly worker stopped unexpectedly.",
  });
}

export {};
