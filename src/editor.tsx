import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { sql } from "@codemirror/lang-sql";
import { type Diagnostic, setDiagnostics } from "@codemirror/lint";
import { Annotation, EditorState, type SelectionRange } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { useLayoutEffect, useRef } from "preact/hooks";
import type { ParseDiagnostic } from "./protocol";

export interface SelectionRequest {
  from: number;
  to: number;
  token: number;
  focus?: boolean;
}

export interface SqlEditorProps {
  value: string;
  diagnostics: ParseDiagnostic[];
  selectionRequest: SelectionRequest | null;
  onChange(value: string): void;
  onSelectionChange(offset: number): void;
  onParse(): void;
}

const externalEditorUpdate = Annotation.define<boolean>();

export function SqlEditor({
  value,
  diagnostics,
  selectionRequest,
  onChange,
  onSelectionChange,
  onParse,
}: SqlEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const onParseRef = useRef(onParse);

  onChangeRef.current = onChange;
  onSelectionChangeRef.current = onSelectionChange;
  onParseRef.current = onParse;

  useLayoutEffect(() => {
    if (containerRef.current === null) {
      return;
    }

    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightSpecialChars(),
        drawSelection(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        sql(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({
          "aria-label": "SQL or GQL source",
          "aria-describedby": "editor-shortcut",
          spellcheck: "false",
        }),
        keymap.of([
          {
            key: "Mod-Enter",
            run: () => {
              onParseRef.current();
              return true;
            },
          },
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        EditorView.updateListener.of((update) => {
          const isExternalUpdate = update.transactions.some(
            (transaction) => transaction.annotation(externalEditorUpdate) === true,
          );
          if (update.docChanged && !isExternalUpdate) {
            onChangeRef.current(update.state.doc.toString());
          }
          if (update.selectionSet && !isExternalUpdate) {
            onSelectionChangeRef.current(selectionOffset(update.state.selection.main));
          }
        }),
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (view === null || view.state.doc.toString() === value) {
      return;
    }
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      annotations: externalEditorUpdate.of(true),
    });
    onSelectionChangeRef.current(selectionOffset(view.state.selection.main));
  }, [value]);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (view === null) {
      return;
    }

    const documentLength = view.state.doc.length;
    const editorDiagnostics: Diagnostic[] = diagnostics.map((diagnostic) => ({
      from: clamp(diagnostic.range.from, documentLength),
      to: clamp(diagnostic.range.to, documentLength),
      severity: "error",
      message: diagnostic.message,
    }));
    view.dispatch(setDiagnostics(view.state, editorDiagnostics));
  }, [diagnostics]);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (view === null || selectionRequest === null) {
      return;
    }

    const documentLength = view.state.doc.length;
    const from = clamp(selectionRequest.from, documentLength);
    const to = Math.max(from, clamp(selectionRequest.to, documentLength));
    view.dispatch({
      selection: { anchor: from, head: to },
      effects: EditorView.scrollIntoView(from, { y: "center" }),
      annotations: externalEditorUpdate.of(true),
    });
    if (selectionRequest.focus !== false) {
      view.focus();
    }
  }, [selectionRequest]);

  return <div class="editor-host" ref={containerRef} />;
}

function clamp(value: number, maximum: number): number {
  return Math.max(0, Math.min(value, maximum));
}

export function selectionOffset(
  selection: Pick<SelectionRange, "empty" | "from" | "head">,
): number {
  return selection.empty ? selection.head : selection.from;
}
