// Line rows for the companion window with the same gutter selection as the main window's
// editor (gutter-select.ts): click, Ctrl/Cmd+click, Shift+click, drag-select, and dragging the
// selection into a chat composer in the main window.
import { LINE_DRAG_MIME, setActiveLineDrag } from "./gutter-select";
import { formatLineReference, lineRange } from "./line-ref";

// Narrow structural types for what this module touches; they shadow lib.dom's in this module.
interface RowElement {
  textContent: string | null;
  draggable: boolean;
  scrollTop: number;
  readonly children: ArrayLike<RowElement>;
  readonly style: { setProperty(name: string, value: string): void };
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  getAttribute(name: string): string | null;
  appendChild(node: RowElement): void;
  replaceChildren(...nodes: RowElement[]): void;
  closest(selector: string): RowElement | null;
  getBoundingClientRect(): { top: number; bottom: number };
}
interface CompanionDocument {
  head: RowElement;
  createElement(tag: string): RowElement;
  elementFromPoint(x: number, y: number): RowElement | null;
  addEventListener(type: string, listener: (event: never) => void): void;
}
interface MouseLike {
  target: RowElement | null;
  button: number;
  clientX: number;
  clientY: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  key: string;
  preventDefault(): void;
}
interface DragLike {
  target: RowElement | null;
  dataTransfer: { effectAllowed: string; setData(type: string, data: string): void } | null;
}

export interface CompanionTheme {
  background: string;
  foreground: string;
  muted: string;
  fontFamily: string;
  fontSize: string;
  lineHeight: string;
}

const LINE_ATTRIBUTE = "data-line";
const SELECTED_ATTRIBUTE = "data-selected";
const GUTTER_CLASS = "gutter";
const CODE_CLASS = "code";
const AUTO_SCROLL_EDGE_PX = 24;
const AUTO_SCROLL_STEP_PX = 18;

export interface CompanionGutter {
  /** Replaces the rows with the file's lines, keeping the selection where lines still exist */
  render(content: string): void;
}

export function createCompanionGutter(
  doc: CompanionDocument,
  scroller: RowElement,
  rows: RowElement,
  theme: CompanionTheme,
  path: string,
): CompanionGutter {
  let selected = new Set<number>();
  let anchor: number | null = null;
  let dragSelect: { start: number; base: Set<number> | null } | null = null;
  let pendingCollapse: number | null = null;
  let rowByLine: RowElement[] = [];

  const style = doc.createElement("style");
  style.textContent = [
    `.${GUTTER_CLASS}{color:${theme.muted};text-align:right;padding:0 12px;user-select:none;cursor:pointer;flex-shrink:0;position:sticky;left:0;background:${theme.background}}`,
    `.${CODE_CLASS}{white-space:pre;padding-right:16px}`,
    `[${SELECTED_ATTRIBUTE}] .${GUTTER_CLASS}{background:color-mix(in srgb, ${theme.muted} 35%, ${theme.background});color:${theme.foreground};font-weight:600;cursor:grab}`,
    `[${SELECTED_ATTRIBUTE}] .${CODE_CLASS}{background:color-mix(in srgb, ${theme.foreground} 9%, transparent)}`,
  ].join("");
  doc.head.appendChild(style);

  const paint = () => {
    for (let line = 1; line < rowByLine.length; line++) {
      const row = rowByLine[line];
      const isSelected = selected.has(line);
      if (isSelected) row.setAttribute(SELECTED_ATTRIBUTE, "true");
      else if (row.getAttribute(SELECTED_ATTRIBUTE) !== null) row.removeAttribute(SELECTED_ATTRIBUTE);
      const gutter = row.children[0];
      // Only selected rows drag; the rest start a drag-select instead
      if (gutter && gutter.draggable !== isSelected) gutter.draggable = isSelected;
    }
  };

  const setSelection = (lines: Set<number>, nextAnchor: number | null) => {
    selected = lines;
    anchor = nextAnchor;
    paint();
  };

  const lineOf = (element: RowElement | null): number | null => {
    const row = element?.closest(`[${LINE_ATTRIBUTE}]`);
    const line = Number.parseInt(row?.getAttribute(LINE_ATTRIBUTE) ?? "", 10);
    return Number.isInteger(line) ? line : null;
  };

  doc.addEventListener("mousedown", (event: MouseLike) => {
    if (event.button !== 0 || !event.target) return;
    const gutter = event.target.closest(`.${GUTTER_CLASS}`);
    if (!gutter) {
      if (event.target.closest(`.${CODE_CLASS}`)) setSelection(new Set(), null);
      return;
    }
    const line = lineOf(gutter);
    if (line === null) return;
    const additive = event.ctrlKey || event.metaKey;
    if (!additive && !event.shiftKey && selected.has(line)) {
      // Leave the default so the browser can start a native drag of this row
      pendingCollapse = line;
      return;
    }
    event.preventDefault();
    const current = new Set(selected);
    if (event.shiftKey) {
      const from = anchor ?? line;
      const range = lineRange(from, line);
      setSelection(additive ? new Set([...current, ...range]) : new Set(range), from);
      dragSelect = { start: from, base: additive ? current : null };
      return;
    }
    if (additive) {
      if (current.has(line)) current.delete(line);
      else current.add(line);
      setSelection(current, line);
      dragSelect = { start: line, base: new Set(current) };
      return;
    }
    setSelection(new Set([line]), line);
    dragSelect = { start: line, base: null };
  });

  doc.addEventListener("mousemove", (event: MouseLike) => {
    if (!dragSelect) return;
    const bounds = scroller.getBoundingClientRect();
    if (event.clientY < bounds.top + AUTO_SCROLL_EDGE_PX) scroller.scrollTop -= AUTO_SCROLL_STEP_PX;
    else if (event.clientY > bounds.bottom - AUTO_SCROLL_EDGE_PX) scroller.scrollTop += AUTO_SCROLL_STEP_PX;
    const line = lineOf(doc.elementFromPoint(event.clientX, event.clientY));
    if (line === null) return;
    const range = lineRange(dragSelect.start, line);
    setSelection(dragSelect.base ? new Set([...dragSelect.base, ...range]) : new Set(range), anchor);
  });

  doc.addEventListener("mouseup", () => {
    dragSelect = null;
    if (pendingCollapse !== null) {
      const line = pendingCollapse;
      pendingCollapse = null;
      setSelection(new Set([line]), line);
    }
  });

  doc.addEventListener("keydown", (event: MouseLike) => {
    if (event.key === "Escape") setSelection(new Set(), null);
  });

  doc.addEventListener("dragstart", (event: DragLike) => {
    if (!event.target?.closest(`.${GUTTER_CLASS}`) || selected.size === 0 || !event.dataTransfer) return;
    pendingCollapse = null;
    const reference = formatLineReference(path, selected);
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData(LINE_DRAG_MIME, "1");
    event.dataTransfer.setData("text/plain", reference);
    // The main window's drop handlers read this; the drag itself crosses windows natively
    setActiveLineDrag(reference);
  });

  doc.addEventListener("dragend", () => {
    pendingCollapse = null;
    setActiveLineDrag(null);
  });

  return {
    render(content) {
      const lines = content.split(/\r?\n/);
      const nextRows: RowElement[] = [];
      rowByLine = [];
      for (let index = 0; index < lines.length; index++) {
        const row = doc.createElement("div");
        row.setAttribute(LINE_ATTRIBUTE, String(index + 1));
        row.style.setProperty("display", "flex");
        const gutter = doc.createElement("div");
        gutter.setAttribute("class", GUTTER_CLASS);
        gutter.textContent = String(index + 1);
        const code = doc.createElement("div");
        code.setAttribute("class", CODE_CLASS);
        // An empty line still needs its height
        code.textContent = lines[index] || " ";
        row.appendChild(gutter);
        row.appendChild(code);
        nextRows.push(row);
        rowByLine[index + 1] = row;
      }
      rows.replaceChildren(...nextRows);
      selected = new Set([...selected].filter((line) => line <= lines.length));
      paint();
    },
  };
}
