import { useEffect, useRef, useState } from "preact/hooks";
import type { ParseResult, ProjectedAST, ProjectedValue, SourceRange } from "./protocol";

const INITIAL_VISIBLE_CHILDREN = 100;
const SCALAR_PREVIEW_LENGTH = 120;

export type AstTreeItemKind = "node" | "array" | "map" | "scalar";

export interface AstTreeItem {
  readonly id: string;
  readonly parentId: string | null;
  readonly ancestorIds: readonly string[];
  readonly childIndex: number;
  readonly depth: number;
  readonly context: string;
  readonly kind: AstTreeItemKind;
  readonly label: string;
  readonly type: string | null;
  readonly range: SourceRange | null;
  readonly children: readonly AstTreeItem[];
}

export interface AstTreeModel {
  readonly roots: readonly AstTreeItem[];
  readonly itemsById: ReadonlyMap<string, AstTreeItem>;
  readonly sourceLength: number;
  readonly lineStarts: readonly number[];
}

export interface AstTreeProps {
  model: AstTreeModel;
  selectedItemId?: string | null;
  onSelectNode(item: AstTreeItem): void;
  ariaLabel?: string;
}

interface BuildContext {
  readonly itemsById: Map<string, AstTreeItem>;
}

interface VisibleWindow {
  readonly start: number;
  readonly end: number;
}

interface ItemLocation {
  readonly id: string;
  readonly parentId: string | null;
  readonly ancestorIds: readonly string[];
  readonly childIndex: number;
  readonly depth: number;
  readonly context: string;
}

export function buildAstTreeModel(results: readonly ParseResult[], source: string): AstTreeModel {
  const itemsById = new Map<string, AstTreeItem>();
  const context: BuildContext = { itemsById };
  const lineStarts = findLineStarts(source);
  const roots = results.map((result, index) =>
    buildValueItem(
      result.ast,
      {
        id: `ast-result-${index}`,
        parentId: null,
        ancestorIds: [],
        childIndex: index,
        depth: 0,
        context: results.length === 1 ? "Result" : `Result ${index + 1}`,
      },
      context,
    ),
  );
  return { roots, itemsById, sourceLength: source.length, lineStarts };
}

export function findDeepestRangedAstNode(
  model: AstTreeModel,
  utf16Offset: number,
): AstTreeItem | null {
  if (!Number.isSafeInteger(utf16Offset) || utf16Offset < 0 || utf16Offset > model.sourceLength) {
    return null;
  }

  let match: AstTreeItem | null = null;
  for (const item of model.itemsById.values()) {
    if (item.kind !== "node" || item.range === null) {
      continue;
    }
    if (!rangeContainsOffset(item.range, utf16Offset, model.sourceLength)) {
      continue;
    }
    if (
      match === null ||
      item.depth > match.depth ||
      (item.depth === match.depth && rangeLength(item.range) < rangeLength(match.range))
    ) {
      match = item;
    }
  }
  return match;
}

export function AstTree({
  model,
  selectedItemId,
  onSelectNode,
  ariaLabel = "Parsed AST",
}: AstTreeProps) {
  const firstRootId = model.roots[0]?.id ?? null;
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(
    () => new Set(firstRootId === null ? [] : [firstRootId]),
  );
  const [visibleWindows, setVisibleWindows] = useState<ReadonlyMap<string, VisibleWindow>>(
    () => new Map(),
  );
  const [focusedItemId, setFocusedItemId] = useState<string | null>(firstRootId);
  const [internalSelectedItemId, setInternalSelectedItemId] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const effectiveSelectedItemId =
    selectedItemId === undefined ? internalSelectedItemId : selectedItemId;

  useEffect(() => {
    const nextFirstRootId = model.roots[0]?.id ?? null;
    setExpandedIds(new Set(nextFirstRootId === null ? [] : [nextFirstRootId]));
    setVisibleWindows(new Map());
    setFocusedItemId(nextFirstRootId);
    setInternalSelectedItemId(null);
  }, [model]);

  useEffect(() => {
    if (effectiveSelectedItemId === null) {
      return;
    }
    const item = model.itemsById.get(effectiveSelectedItemId);
    if (item === undefined) {
      return;
    }

    setFocusedItemId(item.id);
    setExpandedIds((current) => {
      const next = new Set(current);
      for (const ancestorId of item.ancestorIds) {
        next.add(ancestorId);
      }
      return sameSet(current, next) ? current : next;
    });
    setVisibleWindows((current) => revealItem(model, current, item));

    scheduleAnimationFrame(() => {
      const row = document.getElementById(domId(item.id));
      row?.scrollIntoView?.({ block: "nearest" });
    });
  }, [effectiveSelectedItemId, model]);

  if (model.roots.length === 0) {
    return <p class="ast-tree-empty">No AST nodes returned.</p>;
  }

  const selectItem = (item: AstTreeItem) => {
    if (!isSelectable(item)) {
      return;
    }
    setInternalSelectedItemId(item.id);
    onSelectNode(item);
  };

  const toggleItem = (item: AstTreeItem) => {
    if (item.children.length === 0) {
      return;
    }
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(item.id)) {
        next.delete(item.id);
      } else {
        next.add(item.id);
      }
      return next;
    });
  };

  const moveFocus = (itemId: string) => {
    setFocusedItemId(itemId);
    scheduleAnimationFrame(() => document.getElementById(domId(itemId))?.focus());
  };

  const handleKeyDown = (event: KeyboardEvent, item: AstTreeItem) => {
    const visibleItems = getVisibleRows(treeRef.current);
    const currentIndex = visibleItems.findIndex((row) => row.dataset.astItemId === item.id);

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusVisibleRow(
          visibleItems,
          Math.min(currentIndex + 1, visibleItems.length - 1),
          moveFocus,
        );
        break;
      case "ArrowUp":
        event.preventDefault();
        focusVisibleRow(visibleItems, Math.max(currentIndex - 1, 0), moveFocus);
        break;
      case "Home":
        event.preventDefault();
        focusVisibleRow(visibleItems, 0, moveFocus);
        break;
      case "End":
        event.preventDefault();
        focusVisibleRow(visibleItems, visibleItems.length - 1, moveFocus);
        break;
      case "ArrowRight":
        event.preventDefault();
        if (item.children.length === 0) {
          break;
        }
        if (!expandedIds.has(item.id)) {
          toggleItem(item);
          break;
        }
        focusVisibleRow(
          visibleItems,
          Math.min(currentIndex + 1, visibleItems.length - 1),
          moveFocus,
        );
        break;
      case "ArrowLeft":
        event.preventDefault();
        if (expandedIds.has(item.id)) {
          toggleItem(item);
        } else if (item.parentId !== null) {
          moveFocus(item.parentId);
        }
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        if (isSelectable(item)) {
          selectItem(item);
        } else {
          toggleItem(item);
        }
        break;
    }
  };

  const movePage = (key: string, items: readonly AstTreeItem[], requestedStart: number) => {
    const nextWindow = windowStartingAt(items.length, requestedStart);
    setVisibleWindows((current) => {
      const next = new Map(current);
      next.set(key, nextWindow);
      return next;
    });
    const firstVisibleItem = items[nextWindow.start];
    if (firstVisibleItem !== undefined) {
      moveFocus(firstVisibleItem.id);
    }
  };

  const renderItem = (item: AstTreeItem) => {
    const expanded = expandedIds.has(item.id);
    const selectable = isSelectable(item);
    const window = visibleWindow(visibleWindows, item.id, item.children.length);
    const visibleChildren = expanded ? item.children.slice(window.start, window.end) : [];
    const hiddenBefore = window.start;
    const hiddenAfter = item.children.length - window.end;

    return (
      <li
        key={item.id}
        id={domId(item.id)}
        class="ast-tree-entry"
        role="treeitem"
        aria-expanded={item.children.length === 0 ? undefined : expanded}
        aria-selected={selectable ? effectiveSelectedItemId === item.id : undefined}
        aria-level={item.depth + 1}
        aria-posinset={item.childIndex + 1}
        aria-setsize={siblingCount(model, item)}
        aria-label={formatAccessibleLabel(item, model)}
        tabIndex={focusedItemId === item.id ? 0 : -1}
        data-ast-item-id={item.id}
        onFocus={(event) => {
          event.stopPropagation();
          setFocusedItemId(item.id);
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) {
            return;
          }
          event.stopPropagation();
          handleKeyDown(event, item);
        }}
        onClick={(event) => {
          event.stopPropagation();
          event.currentTarget.focus();
          if ((event.target as HTMLElement).closest("[data-ast-disclosure]") !== null) {
            toggleItem(item);
          } else if (selectable) {
            selectItem(item);
          } else {
            toggleItem(item);
          }
        }}
      >
        <div class={`ast-tree-row ast-tree-row-${item.kind}`}>
          <span
            class={`ast-tree-disclosure${item.children.length === 0 ? " is-leaf" : ""}`}
            data-ast-disclosure={item.children.length === 0 ? undefined : "true"}
            aria-hidden="true"
          >
            {item.children.length === 0 ? "·" : expanded ? "▾" : "▸"}
          </span>
          <span class="ast-tree-context">{item.context}</span>
          <span class="ast-tree-label">{item.label}</span>
          {item.range !== null && (
            <span class="ast-tree-range" title={formatRangeLabel(item.range, model)}>
              {formatRangePosition(item.range, model)}
            </span>
          )}
        </div>
        {expanded && (
          // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA treeview children require a group owned by their parent treeitem.
          <ul role="group" class="ast-tree-group">
            {hiddenBefore > 0 && (
              <li role="none" class="ast-tree-more">
                <button
                  type="button"
                  onKeyDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    movePage(item.id, item.children, window.start - INITIAL_VISIBLE_CHILDREN);
                  }}
                >
                  Show previous {Math.min(INITIAL_VISIBLE_CHILDREN, hiddenBefore)} {item.context}{" "}
                  items ({hiddenBefore} before)
                </button>
              </li>
            )}
            {visibleChildren.map(renderItem)}
            {hiddenAfter > 0 && (
              <li role="none" class="ast-tree-more">
                <button
                  type="button"
                  onKeyDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    movePage(item.id, item.children, window.end);
                  }}
                >
                  Show next {Math.min(INITIAL_VISIBLE_CHILDREN, hiddenAfter)} {item.context} items (
                  {hiddenAfter} remaining)
                </button>
              </li>
            )}
          </ul>
        )}
      </li>
    );
  };

  const rootWindow = visibleWindow(visibleWindows, "", model.roots.length);
  const visibleRoots = model.roots.slice(rootWindow.start, rootWindow.end);
  const hiddenRootsBefore = rootWindow.start;
  const hiddenRootsAfter = model.roots.length - rootWindow.end;

  return (
    <div ref={treeRef} class="ast-tree" role="tree" aria-label={ariaLabel}>
      <ul role="none" class="ast-tree-roots">
        {hiddenRootsBefore > 0 && (
          <li role="none" class="ast-tree-more">
            <button
              type="button"
              onKeyDown={(event) => event.stopPropagation()}
              onClick={() => movePage("", model.roots, rootWindow.start - INITIAL_VISIBLE_CHILDREN)}
            >
              Show previous {Math.min(INITIAL_VISIBLE_CHILDREN, hiddenRootsBefore)} results (
              {hiddenRootsBefore} before)
            </button>
          </li>
        )}
        {visibleRoots.map(renderItem)}
        {hiddenRootsAfter > 0 && (
          <li role="none" class="ast-tree-more">
            <button
              type="button"
              onKeyDown={(event) => event.stopPropagation()}
              onClick={() => movePage("", model.roots, rootWindow.end)}
            >
              Show next {Math.min(INITIAL_VISIBLE_CHILDREN, hiddenRootsAfter)} results (
              {hiddenRootsAfter} remaining)
            </button>
          </li>
        )}
      </ul>
    </div>
  );
}

function buildValueItem(
  value: ProjectedValue,
  location: ItemLocation,
  context: BuildContext,
): AstTreeItem {
  let item: AstTreeItem;
  if (isProjectedAST(value)) {
    const range = value.range ?? null;
    const type = value.type || "Unknown";
    item = makeContainerItem(
      location,
      "node",
      type,
      type,
      range,
      Object.keys(value.fields)
        .sort(compareStrings)
        .map((field, index) => ({ key: field, value: value.fields[field], index })),
      context,
    );
  } else if (Array.isArray(value)) {
    item = makeContainerItem(
      location,
      "array",
      `Array (${value.length})`,
      null,
      null,
      value.map((entry, index) => ({ key: `[${index}]`, value: entry, index })),
      context,
    );
  } else if (isProjectedMap(value)) {
    const keys = Object.keys(value).sort(compareStrings);
    item = makeContainerItem(
      location,
      "map",
      `Object (${keys.length})`,
      null,
      null,
      keys.map((key, index) => ({ key, value: value[key], index })),
      context,
    );
  } else {
    item = {
      ...location,
      kind: "scalar",
      label: formatScalar(value),
      type: null,
      range: null,
      children: [],
    };
  }
  context.itemsById.set(item.id, item);
  return item;
}

function makeContainerItem(
  location: ItemLocation,
  kind: Exclude<AstTreeItemKind, "scalar">,
  label: string,
  type: string | null,
  range: SourceRange | null,
  entries: readonly { key: string; value: ProjectedValue | undefined; index: number }[],
  context: BuildContext,
): AstTreeItem {
  const children = entries.map((entry) => {
    const childId = `${location.id}-${pathSegment(entry.key)}`;
    return buildValueItem(
      entry.value ?? null,
      {
        id: childId,
        parentId: location.id,
        ancestorIds: [...location.ancestorIds, location.id],
        childIndex: entry.index,
        depth: location.depth + 1,
        context: entry.key,
      },
      context,
    );
  });
  return { ...location, kind, label, type, range, children };
}

function isProjectedAST(value: ProjectedValue): value is ProjectedAST {
  return (
    isProjectedMap(value) &&
    typeof value.type === "string" &&
    isProjectedMap(value.fields) &&
    (value.range === undefined || isSourceRange(value.range))
  );
}

function isProjectedMap(value: unknown): value is Record<string, ProjectedValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSourceRange(value: unknown): value is SourceRange {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const range = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(range.startByte) &&
    Number.isSafeInteger(range.endByte) &&
    Number.isSafeInteger(range.from) &&
    Number.isSafeInteger(range.to)
  );
}

function formatScalar(value: ProjectedValue): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    const preview = safeStringPrefix(value, SCALAR_PREVIEW_LENGTH);
    return value.length > preview.length
      ? `${JSON.stringify(preview)}… (${value.length} UTF-16 units)`
      : JSON.stringify(value);
  }
  if (typeof value === "number" && Object.is(value, -0)) {
    return "-0";
  }
  return String(value);
}

function safeStringPrefix(value: string, maximum: number): string {
  let preview = value.slice(0, maximum);
  const lastCodeUnit = preview.charCodeAt(preview.length - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
    preview = preview.slice(0, -1);
  }
  return preview;
}

function pathSegment(value: string): string {
  const encoded = encodeURIComponent(value);
  return `${encoded.length}-${encoded}`;
}

function findLineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") {
      starts.push(index + 1);
    }
  }
  return starts;
}

function formatRangeLabel(range: SourceRange, model: AstTreeModel): string {
  return `${formatRangePosition(range, model)} · UTF-16 ${range.from}–${range.to} · bytes ${range.startByte}–${range.endByte}`;
}

function formatRangePosition(range: SourceRange, model: AstTreeModel): string {
  const start = lineColumnAt(range.from, model.lineStarts);
  const end = lineColumnAt(range.to, model.lineStarts);
  const endLabel = start.line === end.line ? `${end.column}` : `L${end.line}:${end.column}`;
  return `L${start.line}:${start.column}–${endLabel}`;
}

function formatAccessibleLabel(item: AstTreeItem, model: AstTreeModel): string {
  const label = `${item.context}: ${item.label}`;
  return item.range === null ? label : `${label}, ${formatRangeLabel(item.range, model)}`;
}

function lineColumnAt(offset: number, starts: readonly number[]): { line: number; column: number } {
  let low = 0;
  let high = starts.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    const start = starts[middle] ?? 0;
    if (start <= offset) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return { line: low + 1, column: offset - (starts[low] ?? 0) + 1 };
}

function rangeContainsOffset(range: SourceRange, offset: number, sourceLength: number): boolean {
  if (range.from === range.to) {
    return offset === range.from;
  }
  return (
    (offset >= range.from && offset < range.to) ||
    (offset === sourceLength && range.to === sourceLength)
  );
}

function rangeLength(range: SourceRange | null): number {
  return range === null ? Number.POSITIVE_INFINITY : range.to - range.from;
}

function isSelectable(item: AstTreeItem): boolean {
  return item.kind === "node" && item.range !== null;
}

function siblingCount(model: AstTreeModel, item: AstTreeItem): number {
  if (item.parentId === null) {
    return model.roots.length;
  }
  return model.itemsById.get(item.parentId)?.children.length ?? 1;
}

function revealItem(
  model: AstTreeModel,
  current: ReadonlyMap<string, VisibleWindow>,
  item: AstTreeItem,
): ReadonlyMap<string, VisibleWindow> {
  const next = new Map(current);
  const lineage = [...item.ancestorIds, item.id];
  for (const itemId of lineage) {
    const descendant = model.itemsById.get(itemId);
    if (descendant === undefined) {
      continue;
    }
    const key = descendant.parentId ?? "";
    const siblingCount =
      descendant.parentId === null
        ? model.roots.length
        : (model.itemsById.get(descendant.parentId)?.children.length ?? 0);
    const window = visibleWindow(next, key, siblingCount);
    if (descendant.childIndex < window.start || descendant.childIndex >= window.end) {
      next.set(key, pageContaining(descendant.childIndex, siblingCount));
    }
  }
  return sameWindowMap(current, next) ? current : next;
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function visibleWindow(
  windows: ReadonlyMap<string, VisibleWindow>,
  key: string,
  itemCount: number,
): VisibleWindow {
  return windows.get(key) ?? { start: 0, end: Math.min(INITIAL_VISIBLE_CHILDREN, itemCount) };
}

function pageContaining(index: number, itemCount: number): VisibleWindow {
  const start = Math.floor(index / INITIAL_VISIBLE_CHILDREN) * INITIAL_VISIBLE_CHILDREN;
  return { start, end: Math.min(start + INITIAL_VISIBLE_CHILDREN, itemCount) };
}

function windowStartingAt(itemCount: number, requestedStart: number): VisibleWindow {
  const lastPageStart =
    itemCount === 0
      ? 0
      : Math.floor((itemCount - 1) / INITIAL_VISIBLE_CHILDREN) * INITIAL_VISIBLE_CHILDREN;
  const start = Math.max(0, Math.min(requestedStart, lastPageStart));
  return { start, end: Math.min(start + INITIAL_VISIBLE_CHILDREN, itemCount) };
}

function sameWindowMap(
  left: ReadonlyMap<string, VisibleWindow>,
  right: ReadonlyMap<string, VisibleWindow>,
): boolean {
  return (
    left.size === right.size &&
    [...left].every(([key, value]) => {
      const other = right.get(key);
      return other?.start === value.start && other.end === value.end;
    })
  );
}

function getVisibleRows(tree: HTMLDivElement | null): HTMLElement[] {
  return tree === null
    ? []
    : Array.from(tree.querySelectorAll<HTMLElement>("[role='treeitem'][data-ast-item-id]"));
}

function focusVisibleRow(
  rows: readonly HTMLElement[],
  index: number,
  moveFocus: (itemId: string) => void,
): void {
  const itemId = rows[index]?.dataset.astItemId;
  if (itemId !== undefined) {
    moveFocus(itemId);
  }
}

function scheduleAnimationFrame(callback: () => void): void {
  if (typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(callback);
  } else {
    callback();
  }
}

function domId(itemId: string): string {
  return `ast-tree-row-${itemId}`;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
