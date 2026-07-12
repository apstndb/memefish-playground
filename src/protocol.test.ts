import { describe, expect, it } from "vitest";
import { decodeBridgeMessage, ProtocolError } from "./protocol";

const engine = {
  channel: "release",
  version: "v0.8.0",
  commit: "24fc9334defa75de8d8ca1afc9d7205d2c8c5bf9",
  goVersion: "go1.26.5",
};

function responseWithAst(
  ast: unknown,
  goPretty?: unknown,
  limits: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    protocolVersion: 2,
    id: "ast",
    ok: true,
    engine,
    results: [
      {
        nodeType: "QueryStatement",
        range: { startByte: 0, endByte: 13, from: 0, to: 13 },
        sql: "SELECT 'é'",
        ...(goPretty === undefined ? {} : { goPretty }),
        ...limits,
        ast,
      },
    ],
    diagnostics: [],
    fatal: null,
  });
}

describe("projected AST protocol", () => {
  it("decodes ANSI-colored Go pretty-print output", () => {
    const goPretty = "\u001b[32m&ast.QueryStatement\u001b[0m{}";
    const message = decodeBridgeMessage(
      responseWithAst({ type: "QueryStatement", fields: {} }, goPretty),
    );

    if ("type" in message) {
      throw new Error("expected parse response");
    }
    expect(message.results[0]?.goPretty).toBe(goPretty);
  });

  it("accepts results without unrequested Go pretty-print output", () => {
    const message = decodeBridgeMessage(responseWithAst({ type: "QueryStatement", fields: {} }));

    if ("type" in message) {
      throw new Error("expected parse response");
    }
    expect(message.results[0]?.goPretty).toBeUndefined();
  });

  it("decodes explicit Go pretty-print limit states", () => {
    const message = decodeBridgeMessage(
      responseWithAst({ type: "QueryStatement", fields: {} }, "bounded", {
        goPrettyDepthLimited: true,
        goPrettyTruncated: true,
      }),
    );

    if ("type" in message) {
      throw new Error("expected parse response");
    }
    expect(message.results[0]).toMatchObject({
      goPretty: "bounded",
      goPrettyDepthLimited: true,
      goPrettyTruncated: true,
    });

    const refused = decodeBridgeMessage(
      responseWithAst({ type: "QueryStatement", fields: {} }, undefined, { goPrettyRefused: true }),
    );
    if ("type" in refused) {
      throw new Error("expected parse response");
    }
    expect(refused.results[0]?.goPrettyRefused).toBe(true);
    expect(refused.results[0]?.goPretty).toBeUndefined();
  });

  it("rejects non-string Go pretty-print output", () => {
    expect(() =>
      decodeBridgeMessage(responseWithAst({ type: "QueryStatement", fields: {} }, 42)),
    ).toThrow(ProtocolError);
  });

  it.each([
    ["non-boolean limit state", "pretty", { goPrettyTruncated: "yes" }],
    ["limited state without output", undefined, { goPrettyDepthLimited: true }],
    ["refused state with output", "pretty", { goPrettyRefused: true }],
  ])("rejects %s", (_name, goPretty, limits) => {
    expect(() =>
      decodeBridgeMessage(
        responseWithAst({ type: "QueryStatement", fields: {} }, goPretty, limits),
      ),
    ).toThrow(ProtocolError);
  });

  it("decodes nested node ranges and arbitrary projected values", () => {
    const message = decodeBridgeMessage(
      responseWithAst({
        type: "QueryStatement",
        range: { startByte: 0, endByte: 11, from: 0, to: 10 },
        fields: {
          Query: {
            type: "Query",
            range: { startByte: 0, endByte: 11, from: 0, to: 10 },
            fields: {
              Values: [1, true, null, "é"],
              Metadata: { dialect: "GoogleSQL", type: "user metadata", fields: "plain value" },
            },
          },
        },
      }),
    );

    if ("type" in message) {
      throw new Error("expected parse response");
    }
    expect(message.results[0]?.ast).toMatchObject({
      type: "QueryStatement",
      range: { startByte: 0, endByte: 11, from: 0, to: 10 },
      fields: {
        Query: {
          type: "Query",
          fields: {
            Values: [1, true, null, "é"],
            Metadata: {
              dialect: "GoogleSQL",
              type: "user metadata",
              fields: "plain value",
            },
          },
        },
      },
    });
  });

  it("accepts legacy projected nodes without ranges", () => {
    const message = decodeBridgeMessage(
      responseWithAst({ type: "QueryStatement", fields: { Query: null } }),
    );

    if ("type" in message) {
      throw new Error("expected parse response");
    }
    expect(message.results[0]?.ast.range).toBeUndefined();
  });

  it.each([
    ["missing fields", { type: "QueryStatement" }],
    ["empty type", { type: "", fields: {} }],
    [
      "reversed range",
      {
        type: "QueryStatement",
        range: { startByte: 2, endByte: 1, from: 2, to: 1 },
        fields: {},
      },
    ],
    [
      "invalid nested node range",
      {
        type: "QueryStatement",
        fields: {
          Query: {
            type: "Query",
            fields: {},
            range: { startByte: 2, endByte: 1, from: 2, to: 1 },
          },
        },
      },
    ],
    ["wrong root type", { type: "Select", fields: {} }],
  ])("rejects %s", (_name, ast) => {
    expect(() => decodeBridgeMessage(responseWithAst(ast))).toThrow(ProtocolError);
  });
});
