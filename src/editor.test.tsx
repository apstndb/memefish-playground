import { EditorView } from "@codemirror/view";
import { cleanup, render } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { selectionOffset, SqlEditor } from "./editor";

afterEach(cleanup);

describe("selectionOffset", () => {
  it("uses the cursor head for an empty selection", () => {
    expect(selectionOffset({ empty: true, from: 4, head: 4 })).toBe(4);
  });

  it("uses the direction-independent start for forward and reverse selections", () => {
    expect(selectionOffset({ empty: false, from: 3, head: 9 })).toBe(3);
    expect(selectionOffset({ empty: false, from: 3, head: 3 })).toBe(3);
  });

  it("preserves CodeMirror UTF-16 offsets for astral source text", () => {
    const source = "A😀Z";
    expect(source.length).toBe(4);
    expect(selectionOffset({ empty: true, from: 3, head: 3 })).toBe(3);
  });
});

describe("SqlEditor selection synchronization", () => {
  it("applies an external range without echoing it or stealing tree focus", () => {
    const onSelectionChange = vi.fn();
    const props = {
      value: "A😀Z",
      diagnostics: [],
      selectionRequest: null,
      onChange: vi.fn(),
      onSelectionChange,
      onParse: vi.fn(),
    };
    const viewResult = render(<SqlEditor {...props} />);
    const { rerender } = viewResult;
    const editor = viewResult.getByRole("textbox");
    const view = EditorView.findFromDOM(editor);
    if (view === null) {
      throw new Error("CodeMirror view was not created");
    }
    const treeItem = document.createElement("button");
    document.body.append(treeItem);
    treeItem.focus();

    rerender(
      <SqlEditor {...props} selectionRequest={{ from: 1, to: 3, token: 1, focus: false }} />,
    );

    expect(view.state.selection.main.from).toBe(1);
    expect(view.state.selection.main.to).toBe(3);
    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(treeItem).toHaveFocus();

    view.dispatch({ selection: { anchor: 3 } });
    expect(onSelectionChange).toHaveBeenCalledWith(3);
    treeItem.remove();
  });

  it("reports the resulting cursor after replacing the document without echoing the value", () => {
    const onSelectionChange = vi.fn();
    const onChange = vi.fn();
    const props = {
      value: "SELECT 1",
      diagnostics: [],
      selectionRequest: null,
      onChange,
      onSelectionChange,
      onParse: vi.fn(),
    };
    const viewResult = render(<SqlEditor {...props} />);
    const { rerender } = viewResult;
    const view = EditorView.findFromDOM(viewResult.getByRole("textbox"));
    if (view === null) {
      throw new Error("CodeMirror view was not created");
    }
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    onSelectionChange.mockClear();

    rerender(<SqlEditor {...props} value="SELECT 12345" />);

    expect(view.state.doc.toString()).toBe("SELECT 12345");
    expect(onChange).not.toHaveBeenCalled();
    expect(onSelectionChange).toHaveBeenCalledTimes(1);
    expect(onSelectionChange).toHaveBeenCalledWith(selectionOffset(view.state.selection.main));
  });
});
