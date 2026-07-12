import { describe, expect, it } from "vitest";
import { ANSI_COLORS, paginateAnsiTokens, tokenizeAnsi } from "./ansi";

describe("tokenizeAnsi", () => {
  it("returns plain and empty input without synthetic tokens", () => {
    expect(tokenizeAnsi("plain text")).toEqual([{ text: "plain text", style: { bold: false } }]);
    expect(tokenizeAnsi("")).toEqual([]);
  });

  it("tokenizes pp-like color and bold combinations", () => {
    const input =
      "\u001b[32m\u001b[1m&ast.QueryStatement\u001b[0m{\n  \u001b[33mField\u001b[0m: \u001b[34m\u001b[1m1\u001b[0m\n}";

    expect(tokenizeAnsi(input)).toEqual([
      {
        text: "&ast.QueryStatement",
        style: { bold: true, foreground: "green" },
      },
      { text: "{\n  ", style: { bold: false } },
      { text: "Field", style: { bold: false, foreground: "yellow" } },
      { text: ": ", style: { bold: false } },
      { text: "1", style: { bold: true, foreground: "blue" } },
      { text: "\n}", style: { bold: false } },
    ]);
  });

  it("applies selective resets for bold, foreground, and background", () => {
    const tokens = tokenizeAnsi("\u001b[1;31;44mA\u001b[22;39mB\u001b[49mC\u001b[1;32mD\u001b[0mE");

    expect(tokens).toEqual([
      {
        text: "A",
        style: { bold: true, foreground: "red", background: "blue" },
      },
      { text: "B", style: { bold: false, background: "blue" } },
      { text: "C", style: { bold: false } },
      { text: "D", style: { bold: true, foreground: "green" } },
      { text: "E", style: { bold: false } },
    ]);
  });

  it("maps all supported foreground and background colors", () => {
    const input = ANSI_COLORS.map(
      (_color, index) => `\u001b[${30 + index};${40 + index}m${index}`,
    ).join("");

    expect(tokenizeAnsi(input)).toEqual(
      ANSI_COLORS.map((color, index) => ({
        text: String(index),
        style: { bold: false, foreground: color, background: color },
      })),
    );
  });

  it("strips unknown codes without changing the current style", () => {
    expect(tokenizeAnsi("\u001b[31mred\u001b[999m remains red\u001b[m plain")).toEqual([
      { text: "red", style: { bold: false, foreground: "red" } },
      {
        text: " remains red",
        style: { bold: false, foreground: "red" },
      },
      { text: " plain", style: { bold: false } },
    ]);
  });

  it("does not emit empty text for consecutive style changes", () => {
    const tokens = tokenizeAnsi("A\u001b[31m\u001b[1mB\u001b[22m\u001b[39mC");

    expect(tokens).toEqual([
      { text: "A", style: { bold: false } },
      { text: "B", style: { bold: true, foreground: "red" } },
      { text: "C", style: { bold: false } },
    ]);
    expect(tokens[0]?.style).not.toBe(tokens[1]?.style);
  });

  it("treats omitted parameters within a sequence as reset", () => {
    expect(tokenizeAnsi("\u001b[31;1mred\u001b[;34mblue")).toEqual([
      { text: "red", style: { bold: true, foreground: "red" } },
      { text: "blue", style: { bold: false, foreground: "blue" } },
    ]);
  });
});

describe("paginateAnsiTokens", () => {
  const plain = { bold: false } as const;
  const highlighted = { bold: true, foreground: "green" } as const;

  it("bounds pages by token runs without changing their order", () => {
    const tokens = [
      { text: "a", style: plain },
      { text: "b", style: highlighted },
      { text: "c", style: plain },
      { text: "d", style: highlighted },
      { text: "e", style: plain },
    ] as const;

    const pages = paginateAnsiTokens(tokens, { maxTokens: 2, maxLineBreaks: 10 });

    expect(pages).toEqual([[tokens[0], tokens[1]], [tokens[2], tokens[3]], [tokens[4]]]);
    expect(
      pages
        .flat()
        .map(({ text }) => text)
        .join(""),
    ).toBe("abcde");
  });

  it("splits one token with many newlines only after newline characters", () => {
    const pages = paginateAnsiTokens([{ text: "a\nb\nc\nd", style: plain }], {
      maxTokens: 5,
      maxLineBreaks: 1,
    });

    expect(pages).toEqual([
      [{ text: "a\n", style: plain }],
      [{ text: "b\n", style: plain }],
      [{ text: "c\nd", style: plain }],
    ]);
    expect(
      pages
        .flat()
        .map(({ text }) => text)
        .join(""),
    ).toBe("a\nb\nc\nd");
  });

  it("preserves style snapshots when splitting a token", () => {
    const pages = paginateAnsiTokens([{ text: "first\nsecond\nthird", style: highlighted }], {
      maxTokens: 2,
      maxLineBreaks: 1,
    });

    expect(pages.flat().map(({ text }) => text)).toEqual(["first\n", "second\nthird"]);
    for (const token of pages.flat()) {
      expect(token.style).toBe(highlighted);
    }
  });

  it("enforces both limits when token and line boundaries interact", () => {
    const tokens = [
      { text: "prefix", style: plain },
      { text: "first\nsecond\n", style: highlighted },
      { text: "suffix", style: plain },
    ] as const;

    const pages = paginateAnsiTokens(tokens, { maxTokens: 2, maxLineBreaks: 1 });

    expect(pages).toEqual([
      [tokens[0], { text: "first\n", style: highlighted }],
      [{ text: "second\n", style: highlighted }, tokens[2]],
    ]);
    for (const page of pages) {
      expect(page.length).toBeLessThanOrEqual(2);
      expect(page.flatMap(({ text }) => [...text.matchAll(/\n/g)]).length).toBeLessThanOrEqual(1);
    }
    expect(
      pages
        .flat()
        .map(({ text }) => text)
        .join(""),
    ).toBe(tokens.map(({ text }) => text).join(""));
  });

  it("keeps an arbitrarily long no-newline run whole", () => {
    const text = "x".repeat(10_000);

    expect(
      paginateAnsiTokens([{ text, style: plain }], { maxTokens: 1, maxLineBreaks: 1 }),
    ).toEqual([[{ text, style: plain }]]);
  });

  it("returns no pages for empty input", () => {
    expect(paginateAnsiTokens([], { maxTokens: 1, maxLineBreaks: 1 })).toEqual([]);
  });

  it.each([
    ["maxTokens", 0],
    ["maxTokens", -1],
    ["maxTokens", 1.5],
    ["maxTokens", Number.POSITIVE_INFINITY],
    ["maxLineBreaks", 0],
    ["maxLineBreaks", -1],
    ["maxLineBreaks", 1.5],
    ["maxLineBreaks", Number.NaN],
  ] as const)("rejects invalid %s value %s", (name, value) => {
    const options = { maxTokens: 1, maxLineBreaks: 1, [name]: value };

    expect(() => paginateAnsiTokens([], options)).toThrow(
      new RangeError(`${name} must be a positive integer.`),
    );
  });
});
