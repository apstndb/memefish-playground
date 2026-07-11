import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ParseResult, ProjectedAST, ProjectedValue, SourceRange } from "./protocol";
import { AstTree, type AstTreeItem, buildAstTreeModel, findDeepestRangedAstNode } from "./ast-tree";

afterEach(cleanup);

describe("buildAstTreeModel", () => {
  it("builds deterministic paths and sorts field and map keys", () => {
    const results = [
      result("Root", range(0, 8), {
        type: "Root",
        range: range(0, 8),
        fields: {
          Zeta: 1,
          Alpha: { zebra: false, apple: true },
          Middle: null,
        },
      }),
    ];

    const first = buildAstTreeModel(results, "SELECT 1");
    const second = buildAstTreeModel(results, "SELECT 1");
    const root = first.roots[0];
    expect(root?.children.map((item) => item.context)).toEqual(["Alpha", "Middle", "Zeta"]);
    expect(root?.children[0]?.children.map((item) => item.context)).toEqual(["apple", "zebra"]);
    expect([...first.itemsById.keys()]).toEqual([...second.itemsById.keys()]);
  });

  it("preserves arrays, maps, nulls, and long scalar previews as inspectable items", () => {
    const long = `${"x".repeat(119)}😀tail`;
    const model = buildAstTreeModel(
      [
        result("BadExpr", range(0, 1), {
          type: "BadExpr",
          range: range(0, 1),
          fields: {
            Empty: [],
            Tokens: [null, { Raw: long }],
          },
        }),
      ],
      "'",
    );

    const root = model.roots[0];
    expect(root?.type).toBe("BadExpr");
    expect(root?.range).toEqual(range(0, 1));
    expect(root?.children.find((item) => item.context === "Empty")?.label).toBe("Array (0)");
    const tokens = root?.children.find((item) => item.context === "Tokens");
    expect(tokens?.children[0]?.label).toBe("null");
    const raw = tokens?.children[1]?.children[0];
    expect(raw?.label).toContain("UTF-16 units");
    expect(raw?.label).not.toContain('\ud83d"');
  });

  it("does not invent a root range when the projection intentionally omits it", () => {
    const model = buildAstTreeModel(
      [result("Root", range(0, 1), { type: "Root", fields: {} })],
      "x",
    );

    expect(model.roots[0]?.range).toBeNull();
    expect(findDeepestRangedAstNode(model, 0)).toBeNull();
  });
});

describe("findDeepestRangedAstNode", () => {
  it("uses half-open ranges, chooses the deepest node, and maps the source EOF", () => {
    const model = buildAstTreeModel(
      [
        result("Root", range(0, 2), {
          type: "Root",
          range: range(0, 2),
          fields: {
            First: node("First", range(0, 1)),
            Second: {
              type: "Second",
              range: range(1, 2),
              fields: { EOF: node("EOFNode", range(2, 2)) },
            },
          },
        }),
      ],
      "ab",
    );

    expect(findDeepestRangedAstNode(model, 0)?.type).toBe("First");
    expect(findDeepestRangedAstNode(model, 1)?.type).toBe("Second");
    expect(findDeepestRangedAstNode(model, 2)?.type).toBe("EOFNode");
    expect(findDeepestRangedAstNode(model, -1)).toBeNull();
    expect(findDeepestRangedAstNode(model, 3)).toBeNull();
    expect(findDeepestRangedAstNode(model, 0.5)).toBeNull();
  });

  it("ignores projected structs that do not carry an AST source range", () => {
    const model = buildAstTreeModel(
      [
        result("BadExpr", range(0, 1), {
          type: "BadExpr",
          range: range(0, 1),
          fields: {
            Token: { type: "Token", fields: { Raw: "'" } },
          },
        }),
      ],
      "'",
    );

    expect(findDeepestRangedAstNode(model, 0)?.type).toBe("BadExpr");
  });
});

describe("AstTree", () => {
  it("renders an accessible lazy tree with field context and source positions", () => {
    const model = buildAstTreeModel(
      [result("Root", range(7, 8), node("Root", range(7, 8), { Value: "x" }))],
      "SELECT\nx",
    );

    render(<AstTree model={model} onSelectNode={vi.fn()} />);

    const tree = screen.getByRole("tree", { name: "Parsed AST" });
    expect(tree).toBeInTheDocument();
    const root = screen.getByRole("treeitem", { name: /Result: Root/ });
    expect(root).toHaveAttribute("aria-expanded", "true");
    expect(root).toHaveAttribute("aria-selected", "false");
    expect(root).toHaveTextContent("L2:1–2");
    expect(root.querySelector(".ast-tree-range")).toHaveAttribute(
      "title",
      "L2:1–2 · UTF-16 7–8 · bytes 7–8",
    );
    expect(screen.getByRole("treeitem", { name: /Value: "x"/ })).not.toHaveAttribute(
      "aria-selected",
    );
  });

  it("selects only ranged AST node rows and keeps the tree row focused", () => {
    const onSelectNode = vi.fn<(item: AstTreeItem) => void>();
    const model = buildAstTreeModel(
      [
        result(
          "Root",
          range(0, 1),
          node("Root", range(0, 1), {
            Child: node("Child", range(0, 1)),
            Scalar: 42,
          }),
        ),
      ],
      "x",
    );
    render(<AstTree model={model} onSelectNode={onSelectNode} />);

    const scalar = screen.getByRole("treeitem", { name: /Scalar: 42/ });
    fireEvent.click(scalar);
    expect(onSelectNode).not.toHaveBeenCalled();

    const child = screen.getByRole("treeitem", { name: /Child: Child/ });
    fireEvent.click(child);
    expect(onSelectNode).toHaveBeenCalledTimes(1);
    expect(onSelectNode.mock.calls[0]?.[0].type).toBe("Child");
    expect(child).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(child);
  });

  it("supports roving tree focus, expansion, parent navigation, and activation", async () => {
    const onSelectNode = vi.fn<(item: AstTreeItem) => void>();
    const model = buildAstTreeModel(
      [
        result(
          "Root",
          range(0, 2),
          node("Root", range(0, 2), {
            Child: node("Child", range(0, 2), {
              Leaf: node("Leaf", range(1, 2)),
            }),
            Tail: true,
          }),
        ),
      ],
      "ab",
    );
    render(<AstTree model={model} onSelectNode={onSelectNode} />);

    const root = screen.getByRole("treeitem", { name: /Result: Root/ });
    root.focus();
    fireEvent.keyDown(root, { key: "ArrowRight" });
    const child = screen.getByRole("treeitem", { name: /Child: Child/ });
    await waitFor(() => expect(document.activeElement).toBe(child));

    fireEvent.keyDown(child, { key: "ArrowRight" });
    expect(child).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(child, { key: "ArrowRight" });
    const leaf = screen.getByRole("treeitem", { name: /Leaf: Leaf/ });
    await waitFor(() => expect(document.activeElement).toBe(leaf));

    fireEvent.keyDown(leaf, { key: "Enter" });
    expect(onSelectNode.mock.calls.at(-1)?.[0].type).toBe("Leaf");
    expect(document.activeElement).toBe(leaf);

    fireEvent.keyDown(leaf, { key: "ArrowLeft" });
    await waitFor(() => expect(document.activeElement).toBe(child));
    fireEvent.keyDown(child, { key: "ArrowLeft" });
    expect(child).toHaveAttribute("aria-expanded", "false");

    fireEvent.keyDown(child, { key: "End" });
    const tail = screen.getByRole("treeitem", { name: /Tail: true/ });
    await waitFor(() => expect(document.activeElement).toBe(tail));
    fireEvent.keyDown(tail, { key: "Home" });
    await waitFor(() => expect(document.activeElement).toBe(root));
  });

  it("auto-expands and reveals a selected descendant without moving DOM focus", async () => {
    const values: ProjectedValue[] = Array.from({ length: 151 }, (_, index) =>
      index === 150 ? node("Deep", range(0, 1)) : index,
    );
    const model = buildAstTreeModel(
      [result("Root", range(0, 1), node("Root", range(0, 1), { Values: values }))],
      "x",
    );
    const deep = [...model.itemsById.values()].find((item) => item.type === "Deep");
    if (deep === undefined) {
      throw new Error("Deep node was not built");
    }

    const { rerender } = render(
      <AstTree model={model} selectedItemId={null} onSelectNode={vi.fn()} />,
    );
    const root = screen.getByRole("treeitem", { name: /Result: Root/ });
    root.focus();

    rerender(<AstTree model={model} selectedItemId={deep.id} onSelectNode={vi.fn()} />);

    const selected = await screen.findByRole("treeitem", { name: /\[150\]: Deep/ });
    expect(selected).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("treeitem", { name: /^\[0\]: 0$/ })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(root);
  });

  it("renders large arrays in bounded chunks that remain inspectable", async () => {
    const model = buildAstTreeModel(
      [
        result(
          "Root",
          range(0, 1),
          node("Root", range(0, 1), {
            Values: Array.from({ length: 205 }, (_, index) => index),
          }),
        ),
      ],
      "x",
    );
    render(<AstTree model={model} onSelectNode={vi.fn()} />);

    const values = screen.getByRole("treeitem", { name: /Values: Array \(205\)/ });
    const disclosure = values.querySelector("[data-ast-disclosure]");
    if (!(disclosure instanceof HTMLElement)) {
      throw new Error("Values disclosure was not rendered");
    }
    fireEvent.click(disclosure);

    expect(screen.getByRole("treeitem", { name: /^\[99\]: 99$/ })).toBeInTheDocument();
    expect(screen.queryByRole("treeitem", { name: /^\[100\]: 100$/ })).not.toBeInTheDocument();

    const nextPage = screen.getByRole("button", {
      name: "Show next 100 Values items (105 remaining)",
    });
    fireEvent.keyDown(nextPage, { key: " " });
    expect(values).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(nextPage);

    expect(screen.queryByRole("treeitem", { name: /^\[99\]: 99$/ })).not.toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: /^\[100\]: 100$/ })).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: /^\[150\]: 150$/ })).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: /^\[199\]: 199$/ })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show previous 100 Values items (100 before)" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show next 5 Values items (5 remaining)" }),
    ).toBeInTheDocument();

    values.focus();
    fireEvent.keyDown(values, { key: "ArrowRight" });
    const firstVisibleChild = screen.getByRole("treeitem", { name: /^\[100\]: 100$/ });
    await waitFor(() => expect(document.activeElement).toBe(firstVisibleChild));
    expect(document.querySelectorAll("[role='treeitem'][tabindex='0']")).toHaveLength(1);
  });

  it("restores roving focus when paging root results", async () => {
    const results = Array.from({ length: 101 }, (_, index) =>
      result(`Root${index}`, range(0, 1), node(`Root${index}`, range(0, 1))),
    );
    render(<AstTree model={buildAstTreeModel(results, "x")} onSelectNode={vi.fn()} />);

    const nextRoots = screen.getByRole("button", {
      name: "Show next 1 results (1 remaining)",
    });
    nextRoots.focus();
    fireEvent.click(nextRoots);

    const lastRoot = await screen.findByRole("treeitem", { name: /Result 101: Root100/ });
    await waitFor(() => expect(document.activeElement).toBe(lastRoot));
    expect(screen.queryByRole("treeitem", { name: /Result 1: Root0/ })).not.toBeInTheDocument();
    expect(document.querySelectorAll("[role='treeitem'][tabindex='0']")).toHaveLength(1);

    const previousRoots = screen.getByRole("button", {
      name: "Show previous 100 results (100 before)",
    });
    previousRoots.focus();
    fireEvent.click(previousRoots);

    const firstRoot = await screen.findByRole("treeitem", { name: /Result 1: Root0/ });
    await waitFor(() => expect(document.activeElement).toBe(firstRoot));
    expect(document.querySelectorAll("[role='treeitem'][tabindex='0']")).toHaveLength(1);
  });

  it("renders an explicit empty state", () => {
    render(<AstTree model={buildAstTreeModel([], "")} onSelectNode={vi.fn()} />);

    expect(screen.getByText("No AST nodes returned.")).toBeInTheDocument();
    expect(screen.queryByRole("tree")).not.toBeInTheDocument();
  });
});

function result(nodeType: string, resultRange: SourceRange, ast: ProjectedAST): ParseResult {
  return { nodeType, range: resultRange, sql: "", ast };
}

function node(
  type: string,
  nodeRange: SourceRange,
  fields: Record<string, ProjectedValue> = {},
): ProjectedAST {
  return { type, range: nodeRange, fields };
}

function range(from: number, to: number): SourceRange {
  return { startByte: from, endByte: to, from, to };
}
