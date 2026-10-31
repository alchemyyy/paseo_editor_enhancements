// Line selection in the Source panel's line-number gutter, and dragging that selection into a
// chat composer as `path:44,46,48-50`. The editor is CodeMirror 6
// (packages/app/src/file-panels/source/editor/extensions.web.ts); this works on its DOM.
import { findPaneBridge } from "./fiber";
import { formatLineReference, lineRange } from "./line-ref";

// Narrow structural types for what this module touches; they shadow lib.dom's in this module.
interface Rect {
  top: number;
  bottom: number;
}
interface GutterElement {
  readonly parentElement: GutterElement | null;
  readonly textContent: string | null;
  readonly isConnected: boolean;
  readonly style: { visibility: string };
  draggable: boolean;
  scrollTop: number;
  value: string;
  selectionStart: number | null;
  selectionEnd: number | null;
  closest(selector: string): GutterElement | null;
  querySelector(selector: string): GutterElement | null;
  querySelectorAll(selector: string): ArrayLike<GutterElement>;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  getBoundingClientRect(): Rect;
  getClientRects(): { length: number };
  remove(): void;
  focus(): void;
  setSelectionRange(start: number, end: number): void;
  setRangeText(text: string, start: number, end: number, mode: "end"): void;
  dispatchEvent(event: unknown): boolean;
}
interface PointerLikeEvent {
  target: GutterElement | null;
  button: number;
  clientY: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  key: string;
  preventDefault(): void;
  stopPropagation(): void;
}
interface DataTransferLike {
  types: ArrayLike<string>;
  effectAllowed: string;
  dropEffect: string;
  setData(type: string, data: string): void;
}
interface DragLikeEvent {
  target: GutterElement | null;
  dataTransfer: DataTransferLike | null;
  preventDefault(): void;
  stopPropagation(): void;
}
interface Observer {
  observe(target: GutterElement, options: Record<string, boolean>): void;
  disconnect(): void;
}
export interface GutterDocument {
  head: GutterElement & { appendChild(node: GutterElement): void };
  createElement(tag: string): GutterElement & { textContent: string | null };
  querySelectorAll(selector: string): ArrayLike<GutterElement>;
  addEventListener(type: string, listener: (event: never) => void, capture: boolean): void;
  removeEventListener(type: string, listener: (event: never) => void, capture: boolean): void;
  execCommand(command: string, showUi: boolean, value: string): boolean;
}
declare const document: GutterDocument;
declare const MutationObserver: new (callback: () => void) => Observer;
declare const Event: new (type: string, init: { bubbles: boolean }) => unknown;
/** A timer rather than requestAnimationFrame: a companion window repaints even while this one is hidden */
const REPAINT_DELAY_MS = 16;

const EDITOR_SELECTOR = ".cm-editor";
const CELL_SELECTOR = ".cm-lineNumbers .cm-gutterElement";
const CONTENT_SELECTOR = ".cm-content";
const LINE_SELECTOR = ".cm-content .cm-line";
const SCROLLER_SELECTOR = ".cm-scroller";
/** Composer textareas carry `data-composer-input` (packages/app/src/composer/input/input.tsx) */
const COMPOSER_SELECTOR = "[data-composer-input]";
const SELECTED_ATTRIBUTE = "data-editor-enhancements-line-selected";
export const LINE_DRAG_MIME = "application/x-paseo-editor-enhancements-lines";
const STYLE_OWNER = "editor-enhancements-gutter";
/** Rows of a wrapped or shifted line still count as the same line within this many px */
const ROW_MATCH_TOLERANCE_PX = 2;
const AUTO_SCROLL_EDGE_PX = 24;
const AUTO_SCROLL_STEP_PX = 18;
const STYLE_TEXT = [
  `${CELL_SELECTOR}{cursor:pointer;user-select:none;-webkit-user-select:none}`,
  `${CELL_SELECTOR}[${SELECTED_ATTRIBUTE}]{background-color:color-mix(in srgb, currentColor 24%, transparent) !important;font-weight:600;cursor:grab}`,
  `.cm-line[${SELECTED_ATTRIBUTE}]{background-color:color-mix(in srgb, currentColor 9%, transparent) !important}`,
].join("");

interface EditorSelection {
  lines: Set<number>;
  anchor: number | null;
  observer: Observer | null;
}

interface DragSelect {
  editor: GutterElement;
  start: number;
  /** Lines kept while dragging with Ctrl, which adds the dragged range to them */
  base: Set<number> | null;
}

function lineOfCell(cell: GutterElement): number | null {
  // The gutter keeps a hidden spacer cell sized for the widest number
  if (cell.style.visibility === "hidden") return null;
  const line = Number.parseInt(cell.textContent ?? "", 10);
  return Number.isInteger(line) && line > 0 ? line : null;
}

function visibleCells(editor: GutterElement): { cell: GutterElement; line: number; rect: Rect }[] {
  const cells: { cell: GutterElement; line: number; rect: Rect }[] = [];
  const elements = editor.querySelectorAll(CELL_SELECTOR);
  for (let index = 0; index < elements.length; index++) {
    const line = lineOfCell(elements[index]);
    if (line !== null) cells.push({ cell: elements[index], line, rect: elements[index].getBoundingClientRect() });
  }
  return cells;
}

/** The line whose gutter row spans `y`, clamped to the visible rows */
function lineAtY(editor: GutterElement, y: number): number | null {
  const cells = visibleCells(editor);
  if (cells.length === 0) return null;
  for (const entry of cells) {
    if (y >= entry.rect.top && y < entry.rect.bottom) return entry.line;
  }
  return y < cells[0].rect.top ? cells[0].line : cells[cells.length - 1].line;
}

function isVisible(node: GutterElement): boolean {
  return node.getClientRects().length > 0;
}

/** The composer inside the chat pane holding `target` */
function findPaneComposer(target: GutterElement, paneTabId: string): GutterElement | null {
  for (let ancestor: GutterElement | null = target; ancestor; ancestor = ancestor.parentElement) {
    const candidates = ancestor.querySelectorAll(COMPOSER_SELECTOR);
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index];
      if (isVisible(candidate) && findPaneBridge(candidate)?.tabId === paneTabId) return candidate;
    }
  }
  return null;
}

/**
 * The line reference being dragged, from any window this plugin drives. Companion windows run
 * in this window's script realm, so a drag that starts there is visible to the drop handlers here.
 */
let activeDrag: string | null = null;

export function setActiveLineDrag(reference: string | null): void {
  activeDrag = reference;
}

/** How a dragged reference reads in the message box */
function composerText(reference: string): string {
  return `\`${reference}\``;
}

/** Inserts at the caret, keeping native undo and the input event the composer listens to */
function insertIntoComposer(element: GutterElement, text: string): void {
  element.focus();
  const start = element.selectionStart ?? element.value.length;
  const end = element.selectionEnd ?? start;
  const before = element.value.slice(0, start);
  const insertion = `${before.length > 0 && !/\s$/.test(before) ? " " : ""}${text} `;
  if (document.execCommand("insertText", false, insertion)) return;
  element.setRangeText(insertion, start, end, "end");
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * Installs gutter line selection on every Source editor in `doc` (this window's document by
 * default); returns the teardown. `resolvePath` names the file an editor shows, for editors
 * outside a Paseo pane such as a companion window's.
 */
export function installGutterSelection(
  options: { doc?: GutterDocument; resolvePath?: (editor: GutterElement) => string | null } = {},
): () => void {
  const root = options.doc ?? document;
  const resolvePath =
    options.resolvePath ??
    ((editor: GutterElement) => {
      const target = findPaneBridge(editor)?.target;
      return target?.kind === "file" && target.path ? target.path : null;
    });
  const selections = new Map<GutterElement, EditorSelection>();
  let dragSelect: DragSelect | null = null;
  /** A plain press on a selected line: a drag carries the selection, a click narrows to it */
  let pendingCollapse: { editor: GutterElement; line: number } | null = null;

  const style = root.createElement("style");
  style.setAttribute("data-owner", STYLE_OWNER);
  style.textContent = STYLE_TEXT;
  root.head.appendChild(style);

  const paint = (editor: GutterElement) => {
    const selection = selections.get(editor);
    const lines = selection?.lines ?? new Set<number>();
    const rowTops: { top: number; line: number }[] = [];
    for (const { cell, line, rect } of visibleCells(editor)) {
      const selected = lines.has(line);
      if (selected) cell.setAttribute(SELECTED_ATTRIBUTE, "true");
      else if (cell.getAttribute(SELECTED_ATTRIBUTE) !== null) cell.removeAttribute(SELECTED_ATTRIBUTE);
      // Only selected rows drag; the rest start a drag-select instead
      if (cell.draggable !== selected) cell.draggable = selected;
      rowTops.push({ top: rect.top, line });
    }
    const contentLines = editor.querySelectorAll(LINE_SELECTOR);
    for (let index = 0; index < contentLines.length; index++) {
      const element = contentLines[index];
      const top = element.getBoundingClientRect().top;
      const match = rowTops.find((row) => Math.abs(row.top - top) <= ROW_MATCH_TOLERANCE_PX);
      const selected = match !== undefined && lines.has(match.line);
      if (selected) element.setAttribute(SELECTED_ATTRIBUTE, "true");
      else if (element.getAttribute(SELECTED_ATTRIBUTE) !== null) element.removeAttribute(SELECTED_ATTRIBUTE);
    }
  };

  const setLines = (editor: GutterElement, lines: Set<number>, anchor: number | null) => {
    let selection = selections.get(editor);
    if (!selection) {
      selection = { lines, anchor, observer: null };
      selections.set(editor, selection);
    }
    selection.lines = lines;
    selection.anchor = anchor;
    if (lines.size > 0 && !selection.observer) {
      // CodeMirror redraws rows as it scrolls; repaint the marks onto whatever rows it drew
      let queued = false;
      const observer = new MutationObserver(() => {
        if (queued) return;
        queued = true;
        setTimeout(() => {
          queued = false;
          if (editor.isConnected) paint(editor);
          else forget(editor);
        }, REPAINT_DELAY_MS);
      });
      observer.observe(editor, { childList: true, subtree: true, characterData: true });
      selection.observer = observer;
    }
    paint(editor);
    if (lines.size === 0) forget(editor);
  };

  const forget = (editor: GutterElement) => {
    selections.get(editor)?.observer?.disconnect();
    selections.delete(editor);
  };

  const clear = (editor: GutterElement) => {
    if (!selections.has(editor)) return;
    setLines(editor, new Set(), null);
  };

  const onMouseDown = (event: PointerLikeEvent) => {
    if (event.button !== 0 || !event.target) return;
    const cell = event.target.closest(CELL_SELECTOR);
    const editor = event.target.closest(EDITOR_SELECTOR);
    if (!editor) return;
    if (!cell) {
      // A press in the text returns the editor to ordinary text selection
      if (event.target.closest(CONTENT_SELECTOR)) clear(editor);
      return;
    }
    const line = lineOfCell(cell);
    if (line === null) return;
    // Keep CodeMirror from turning the press into a text selection
    event.stopPropagation();
    const selection = selections.get(editor);
    const current = new Set(selection?.lines ?? []);
    const additive = event.ctrlKey || event.metaKey;

    if (!additive && !event.shiftKey && current.has(line)) {
      // Leave the default in place so the browser can start a native drag of this row
      pendingCollapse = { editor, line };
      return;
    }
    event.preventDefault();
    if (event.shiftKey) {
      const anchor = selection?.anchor ?? line;
      const range = lineRange(anchor, line);
      const lines = additive ? new Set([...current, ...range]) : new Set(range);
      setLines(editor, lines, anchor);
      dragSelect = { editor, start: anchor, base: additive ? current : null };
      return;
    }
    if (additive) {
      if (current.has(line)) current.delete(line);
      else current.add(line);
      setLines(editor, current, line);
      dragSelect = { editor, start: line, base: new Set(current) };
      return;
    }
    setLines(editor, new Set([line]), line);
    dragSelect = { editor, start: line, base: null };
  };

  const onMouseMove = (event: PointerLikeEvent) => {
    if (!dragSelect) return;
    const { editor, start, base } = dragSelect;
    if (!editor.isConnected) {
      dragSelect = null;
      return;
    }
    const scroller = editor.querySelector(SCROLLER_SELECTOR);
    if (scroller) {
      const bounds = scroller.getBoundingClientRect();
      if (event.clientY < bounds.top + AUTO_SCROLL_EDGE_PX) scroller.scrollTop -= AUTO_SCROLL_STEP_PX;
      else if (event.clientY > bounds.bottom - AUTO_SCROLL_EDGE_PX) scroller.scrollTop += AUTO_SCROLL_STEP_PX;
    }
    const line = lineAtY(editor, event.clientY);
    if (line === null) return;
    const range = lineRange(start, line);
    setLines(editor, base ? new Set([...base, ...range]) : new Set(range), selections.get(editor)?.anchor ?? start);
  };

  const onMouseUp = () => {
    dragSelect = null;
    if (pendingCollapse) {
      const { editor, line } = pendingCollapse;
      pendingCollapse = null;
      setLines(editor, new Set([line]), line);
    }
  };

  const onKeyDown = (event: PointerLikeEvent) => {
    if (event.key !== "Escape") return;
    for (const editor of [...selections.keys()]) clear(editor);
  };

  const onDragStart = (event: DragLikeEvent) => {
    const cell = event.target?.closest(CELL_SELECTOR);
    const editor = event.target?.closest(EDITOR_SELECTOR);
    const selection = editor ? selections.get(editor) : undefined;
    if (!cell || !editor || !selection || selection.lines.size === 0 || !event.dataTransfer) return;
    pendingCollapse = null;
    const path = resolvePath(editor);
    if (!path) return;
    activeDrag = formatLineReference(path, selection.lines);
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData(LINE_DRAG_MIME, "1");
    event.dataTransfer.setData("text/plain", activeDrag);
  };

  /** Where a line drag may land: a composer, or anywhere in a chat pane */
  const dropComposer = (target: GutterElement | null): GutterElement | null => {
    if (!target) return null;
    const direct = target.closest(COMPOSER_SELECTOR);
    if (direct) return direct;
    const bridge = findPaneBridge(target);
    if (bridge?.target.kind !== "agent" && bridge?.target.kind !== "draft") return null;
    return findPaneComposer(target, bridge.tabId);
  };

  // Chat panes wrap the composer in Paseo's FileDropZone, which stops propagation and rejects
  // unknown drag types. Capture-phase document listeners run first and claim line drags.
  const onDragOver = (event: DragLikeEvent) => {
    if (!activeDrag || !event.dataTransfer) return;
    event.stopPropagation();
    if (dropComposer(event.target)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    } else {
      event.dataTransfer.dropEffect = "none";
    }
  };

  const onDrop = (event: DragLikeEvent) => {
    if (!activeDrag) return;
    const reference = activeDrag;
    activeDrag = null;
    const composer = dropComposer(event.target);
    if (!composer) return;
    event.preventDefault();
    event.stopPropagation();
    insertIntoComposer(composer, composerText(reference));
  };

  // Keeps FileDropZone's enter/leave counter balanced for drags it never sees dropped
  const onDragEnterOrLeave = (event: DragLikeEvent) => {
    if (activeDrag) event.stopPropagation();
  };

  const onDragEnd = () => {
    activeDrag = null;
    pendingCollapse = null;
  };

  const listeners: [string, (event: never) => void][] = [
    ["mousedown", onMouseDown],
    ["mousemove", onMouseMove],
    ["mouseup", onMouseUp],
    ["keydown", onKeyDown],
    ["dragstart", onDragStart],
    ["dragover", onDragOver],
    ["drop", onDrop],
    ["dragenter", onDragEnterOrLeave],
    ["dragleave", onDragEnterOrLeave],
    ["dragend", onDragEnd],
  ];
  for (const [type, listener] of listeners) root.addEventListener(type, listener, true);

  return () => {
    for (const [type, listener] of listeners) root.removeEventListener(type, listener, true);
    for (const editor of [...selections.keys()]) clear(editor);
    const marked = root.querySelectorAll(`[${SELECTED_ATTRIBUTE}]`);
    for (let index = 0; index < marked.length; index++) marked[index].removeAttribute(SELECTED_ATTRIBUTE);
    style.remove();
  };
}
