import { describe, expect, it } from "vitest";
import { decodeBridgeMessage, ProtocolError } from "./protocol";

const engine = {
  channel: "release",
  version: "v0.8.0",
  commit: "24fc9334defa75de8d8ca1afc9d7205d2c8c5bf9",
  goVersion: "go1.26.5",
};

function responseWithAst(ast: unknown): string {
  return JSON.stringify({
    protocolVersion: 1,
    id: "ast",
    ok: true,
    engine,
    results: [
      {
        nodeType: "QueryStatement",
        range: { startByte: 0, endByte: 13, from: 0, to: 13 },
        sql: "SELECT 'é'",
        ast,
      },
    ],
    diagnostics: [],
    fatal: null,
  });
}

describe("projected AST protocol", () => {
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
