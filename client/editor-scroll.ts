// NOTE: Reads Paseo's CodeMirror editor (file-panels/source/editor/view.web.tsx) from its DOM. The
// EditorView hangs off `.cm-content`: as `cmTile.root.view` in the @codemirror/view Paseo 0.13
// ships (6.43), as `cmView.rootView.view` in older releases. Without it, scroll sync falls back to
// scroll proportions.

interface EditorViewLike {
  documentTop: number;
  lineBlockAtHeight(height: number): { from: number; top: number; height: number };
  state: { doc: { lines: number; lineAt(position: number): { number: number } } };
}

/** Where the editor is scrolled to */
export interface EditorScrollPosition {
  /** Source line at the top of the editor, 1-based and fractional; null without an EditorView */
  line: number | null;
  /** The document's line count; null without an EditorView */
  lineCount: number | null;
  /** Scrolled share of the scrollable height, 0 to 1 */
  ratio: number;
  atTop: boolean;
  atBottom: boolean;
}

function isEditorView(value: unknown): value is EditorViewLike {
  if (!value || typeof value !== "object") return false;
  const view = value as Record<string, unknown>;
  return typeof view.lineBlockAtHeight === "function" && typeof view.documentTop === "number";
}

function editorViewOf(content: Element): EditorViewLike | null {
  const node = content as unknown as {
    cmTile?: { root?: { view?: unknown } };
    cmView?: { rootView?: { view?: unknown } };
  };
  const view = node.cmTile?.root?.view ?? node.cmView?.rootView?.view;
  return isEditorView(view) ? view : null;
}

/** The editor's scroll element inside `container`, or null when no editor is mounted there */
export function findEditorScroller(container: Element): HTMLElement | null {
  return container.querySelector<HTMLElement>(".cm-editor .cm-scroller");
}

export function editorScrollPosition(scroller: HTMLElement): EditorScrollPosition {
  const scrollable = scroller.scrollHeight - scroller.clientHeight;
  const ratio = scrollable > 0 ? scroller.scrollTop / scrollable : 0;
  const position = { ratio, atTop: scroller.scrollTop <= 1, atBottom: scrollable - scroller.scrollTop <= 2 };
  const content = scroller.querySelector(".cm-content");
  const view = content ? editorViewOf(content) : null;
  if (!view) return { ...position, line: null, lineCount: null };
  const height = Math.max(0, scroller.getBoundingClientRect().top - view.documentTop);
  const block = view.lineBlockAtHeight(height);
  const line = view.state.doc.lineAt(block.from).number;
  const fraction = block.height > 0 ? Math.min(1, Math.max(0, (height - block.top) / block.height)) : 0;
  return { ...position, line: line + fraction, lineCount: view.state.doc.lines };
}
