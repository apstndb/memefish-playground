export const PROTOCOL_VERSION = 1 as const;

export const PARSE_MODES = [
  "statement",
  "statements",
  "query",
  "expr",
  "type",
  "schemaType",
  "ddl",
  "ddls",
  "dml",
  "dmls",
] as const;

export type ParseMode = (typeof PARSE_MODES)[number];
export type EngineChannel = "release" | "main";

export interface ParseRequest {
  protocolVersion: typeof PROTOCOL_VERSION;
  id: string;
  mode: ParseMode;
  source: string;
}

export interface EngineIdentity {
  channel: EngineChannel;
  version: string;
  commit: string;
  goVersion: string;
}

export interface SourceRange {
  startByte: number;
  endByte: number;
  from: number;
  to: number;
}

export interface ParseResult {
  nodeType: string;
  range: SourceRange;
  sql: string;
  ast: unknown;
}

export interface ParseDiagnostic {
  message: string;
  range: SourceRange;
}

export type FatalKind = "invalid_request" | "parser_panic" | "encode_failure";

export interface FatalError {
  kind: FatalKind;
  message: string;
}

export interface ParseResponse {
  protocolVersion: typeof PROTOCOL_VERSION;
  id: string;
  ok: boolean;
  engine: EngineIdentity;
  results: ParseResult[];
  diagnostics: ParseDiagnostic[];
  fatal: FatalError | null;
}

export interface ReadyMessage {
  type: "ready";
  protocolVersion: typeof PROTOCOL_VERSION;
  engine: EngineIdentity;
}

export type BridgeMessage = ReadyMessage | ParseResponse;

export class ProtocolError extends Error {
  override name = "ProtocolError";
}

export function isParseMode(value: unknown): value is ParseMode {
  return typeof value === "string" && PARSE_MODES.some((mode) => mode === value);
}

export function makeParseRequest(id: string, mode: ParseMode, source: string): ParseRequest {
  return {
    protocolVersion: PROTOCOL_VERSION,
    id,
    mode,
    source,
  };
}

export function decodeBridgeMessage(data: unknown): BridgeMessage {
  if (typeof data !== "string") {
    throw new ProtocolError("The WebAssembly bridge returned a non-string message.");
  }

  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    throw new ProtocolError("The WebAssembly bridge returned invalid JSON.");
  }

  if (!isRecord(value)) {
    throw new ProtocolError("The WebAssembly bridge returned an invalid message.");
  }

  if (value.type === "ready") {
    return decodeReadyMessage(value);
  }
  return decodeParseResponse(value);
}

function decodeReadyMessage(value: Record<string, unknown>): ReadyMessage {
  if (value.protocolVersion !== PROTOCOL_VERSION) {
    throw new ProtocolError("The WebAssembly bridge uses an unsupported protocol version.");
  }

  return {
    type: "ready",
    protocolVersion: PROTOCOL_VERSION,
    engine: decodeEngine(value.engine),
  };
}

function decodeParseResponse(value: Record<string, unknown>): ParseResponse {
  if (value.protocolVersion !== PROTOCOL_VERSION) {
    throw new ProtocolError("The WebAssembly bridge uses an unsupported protocol version.");
  }
  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new ProtocolError("The WebAssembly bridge returned an invalid request ID.");
  }
  if (typeof value.ok !== "boolean") {
    throw new ProtocolError("The WebAssembly bridge returned an invalid success state.");
  }
  if (!Array.isArray(value.results) || !Array.isArray(value.diagnostics)) {
    throw new ProtocolError("The WebAssembly bridge returned invalid result collections.");
  }

  return {
    protocolVersion: PROTOCOL_VERSION,
    id: value.id,
    ok: value.ok,
    engine: decodeEngine(value.engine),
    results: value.results.map(decodeResult),
    diagnostics: value.diagnostics.map(decodeDiagnostic),
    fatal: decodeFatal(value.fatal),
  };
}

function decodeEngine(value: unknown): EngineIdentity {
  if (!isRecord(value)) {
    throw new ProtocolError("The WebAssembly bridge returned invalid engine metadata.");
  }
  if (value.channel !== "release" && value.channel !== "main") {
    throw new ProtocolError("The WebAssembly bridge returned an unknown engine channel.");
  }

  return {
    channel: value.channel,
    version: requireNonEmptyString(value.version, "engine version"),
    commit: requireNonEmptyString(value.commit, "engine commit"),
    goVersion: requireNonEmptyString(value.goVersion, "Go version"),
  };
}

function decodeRange(value: unknown): SourceRange {
  if (!isRecord(value)) {
    throw new ProtocolError("The WebAssembly bridge returned an invalid source range.");
  }

  const range = {
    startByte: requireOffset(value.startByte),
    endByte: requireOffset(value.endByte),
    from: requireOffset(value.from),
    to: requireOffset(value.to),
  };
  if (range.endByte < range.startByte || range.to < range.from) {
    throw new ProtocolError("The WebAssembly bridge returned a reversed source range.");
  }
  return range;
}

function decodeResult(value: unknown): ParseResult {
  if (!isRecord(value)) {
    throw new ProtocolError("The WebAssembly bridge returned an invalid parse result.");
  }

  return {
    nodeType: requireNonEmptyString(value.nodeType, "result node type"),
    range: decodeRange(value.range),
    sql: requireString(value.sql, "unparsed SQL"),
    ast: value.ast,
  };
}

function decodeDiagnostic(value: unknown): ParseDiagnostic {
  if (!isRecord(value)) {
    throw new ProtocolError("The WebAssembly bridge returned an invalid diagnostic.");
  }

  return {
    message: requireNonEmptyString(value.message, "diagnostic message"),
    range: decodeRange(value.range),
  };
}

function decodeFatal(value: unknown): FatalError | null {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    throw new ProtocolError("The WebAssembly bridge returned an invalid fatal error.");
  }
  if (
    value.kind !== "invalid_request" &&
    value.kind !== "parser_panic" &&
    value.kind !== "encode_failure"
  ) {
    throw new ProtocolError("The WebAssembly bridge returned an unknown fatal error kind.");
  }

  return {
    kind: value.kind,
    message: requireNonEmptyString(value.message, "fatal error message"),
  };
}

function requireOffset(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ProtocolError("The WebAssembly bridge returned an invalid source offset.");
  }
  return value as number;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new ProtocolError(`The WebAssembly bridge returned an invalid ${field}.`);
  }
  return value;
}

function requireNonEmptyString(value: unknown, field: string): string {
  const result = requireString(value, field);
  if (result.length === 0) {
    throw new ProtocolError(`The WebAssembly bridge returned an empty ${field}.`);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
