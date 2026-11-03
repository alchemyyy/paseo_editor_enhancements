// Find for the plugin's copies of Paseo's Source editor (the Paseo renderer's Split and companion
// windows). Paseo's find widget is React UI bound to its own editor, and the plugin cannot import
// CodeMirror's search package (a second copy would not share CodeMirror's state types), so this
// bar matches the text itself and moves the selection with the copy's own EditorView.
// Ctrl/Cmd+F opens it (with the selected text), Enter / Shift+Enter and F3 / Shift+F3 step through
// matches, Escape closes it.
import type { CmView } from "./companion-editor";

/** Matches counted past this show as "10000+" */
const MATCH_LIMIT = 10_000;
const FINDING_ATTRIBUTE = "data-finding";
const STYLE_ATTRIBUTE = "data-editor-enhancements-find-style";

interface Match {
  from: number;
  to: number;
}

/** Where `query` occurs in `text`, ignoring case, up to the limit */
export function findMatches(text: string, query: string, limit = MATCH_LIMIT): Match[] {
  if (!query) return [];
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  const matches: Match[] = [];
  for (let index = haystack.indexOf(needle); index !== -1 && matches.length < limit; index = haystack.indexOf(needle, index + needle.length)) {
    matches.push({ from: index, to: index + needle.length });
  }
  return matches;
}

/** The match to go to from `selection`: the next one after it, or the previous one; -1 for none */
export function stepMatch(matches: readonly Match[], selection: Match, forward: boolean): number {
  if (matches.length === 0) return -1;
  if (forward) {
    const next = matches.findIndex((match) => match.from >= selection.to && !(match.from === selection.from && match.to === selection.to));
    return next === -1 ? 0 : next;
  }
  for (let index = matches.length - 1; index >= 0; index--) if (matches[index].to <= selection.from) return index;
  return matches.length - 1;
}

interface ViewWithStatics extends CmView {
  constructor: { scrollIntoView?(position: number, options?: { y?: string }): unknown };
}

/**
 * Adds the find bar over `view`, inside `host` (which the bar positions against). Keys are caught
 * on the editor's DOM, in the document the editor lives in; the bar goes with `host`.
 */
export function attachFindBar(view: CmView, host: HTMLElement): void {
  const doc = host.ownerDocument;
  const editorDom = view.dom as HTMLElement;
  const scrollIntoView = (view as ViewWithStatics).constructor.scrollIntoView;
  const editorStyle = doc.defaultView?.getComputedStyle(editorDom);
  const background = editorStyle?.backgroundColor || "#1e1e1e";
  const color = editorStyle?.color || "#ddd";

  if (doc.defaultView?.getComputedStyle(host).position === "static") host.style.position = "relative";
  // The selection marks the current match; CodeMirror dims it while the bar has focus
  if (!doc.querySelector(`style[${STYLE_ATTRIBUTE}]`)) {
    const style = doc.createElement("style");
    style.setAttribute(STYLE_ATTRIBUTE, "");
    style.textContent = `.cm-editor[${FINDING_ATTRIBUTE}] .cm-selectionBackground { background: rgba(234, 179, 8, 0.45) !important; }`;
    doc.head.appendChild(style);
  }

  const bar = doc.createElement("div");
  bar.setAttribute("data-editor-enhancements-find", "");
  bar.hidden = true;
  bar.style.cssText = [
    "position:absolute",
    "top:6px",
    "right:18px",
    "z-index:5",
    "display:flex",
    "align-items:center",
    "gap:4px",
    "padding:4px 6px",
    "border-radius:6px",
    `background:${background}`,
    `color:${color}`,
    "border:1px solid color-mix(in srgb, currentColor 25%, transparent)",
    "box-shadow:0 2px 8px rgba(0,0,0,.3)",
    "font:12px system-ui,sans-serif",
  ].join(";");
  const input = doc.createElement("input");
  input.type = "text";
  input.placeholder = "Find";
  input.setAttribute("aria-label", "Find");
  input.style.cssText =
    "width:180px;font:inherit;color:inherit;background:transparent;border:1px solid color-mix(in srgb, currentColor 30%, transparent);border-radius:4px;padding:2px 6px;outline:none;";
  const count = doc.createElement("span");
  count.style.cssText = "min-width:64px;text-align:center;opacity:.75;white-space:nowrap;";
  const button = (label: string, title: string, onClick: () => void) => {
    const element = doc.createElement("button");
    element.type = "button";
    element.textContent = label;
    element.title = title;
    element.style.cssText = "font:inherit;color:inherit;background:transparent;border:none;cursor:pointer;padding:2px 5px;border-radius:4px;";
    // Clicking keeps the focus in the field
    element.addEventListener("mousedown", (event) => event.preventDefault());
    element.addEventListener("click", onClick);
    return element;
  };

  let matches: Match[] = [];
  let current = -1;

  const selectionRange = (): Match => {
    const main = (view.state.selection as unknown as { main: { from: number; to: number } }).main;
    return { from: main.from, to: main.to };
  };

  const render = () => {
    if (!input.value) count.textContent = "";
    else if (matches.length === 0) count.textContent = "No results";
    else {
      const total = matches.length >= MATCH_LIMIT ? `${MATCH_LIMIT}+` : String(matches.length);
      count.textContent = current >= 0 ? `${current + 1} of ${total}` : total;
    }
    input.style.borderColor = input.value && matches.length === 0 ? "#e5534b" : "";
  };

  const recount = () => {
    matches = findMatches(view.state.doc.toString(), input.value);
    const { from, to } = selectionRange();
    current = matches.findIndex((match) => match.from === from && match.to === to);
    render();
  };

  const select = (index: number) => {
    const match = matches[index];
    if (!match) return;
    current = index;
    view.dispatch({
      selection: { anchor: match.from, head: match.to },
      ...(scrollIntoView ? { effects: scrollIntoView(match.from, { y: "center" }) } : {}),
    });
    render();
  };

  const show = (visible: boolean) => {
    bar.hidden = !visible;
    if (visible) editorDom.setAttribute(FINDING_ATTRIBUTE, "");
    else editorDom.removeAttribute(FINDING_ATTRIBUTE);
  };

  const step = (forward: boolean) => {
    recount();
    select(stepMatch(matches, selectionRange(), forward));
  };

  const open = () => {
    const { from, to } = selectionRange();
    const selected = view.state.doc.toString().slice(from, to);
    if (selected && !/[\r\n]/.test(selected)) input.value = selected;
    show(true);
    input.focus();
    input.select();
    recount();
  };

  const close = () => {
    show(false);
    view.focus();
  };

  bar.append(
    input,
    count,
    button("↑", "Previous match (Shift+Enter)", () => step(false)),
    button("↓", "Next match (Enter)", () => step(true)),
    button("×", "Close (Escape)", close),
  );
  host.appendChild(bar);

  input.addEventListener("input", () => {
    recount();
    // As you type, the selection moves to the first match from where the search started
    if (matches.length === 0) return;
    const { from } = selectionRange();
    const next = matches.findIndex((match) => match.from >= from);
    select(next === -1 ? 0 : next);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === "F3") {
      event.preventDefault();
      step(!event.shiftKey);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      input.select();
    }
  });

  // Capture, so the copy's own find bindings (CodeMirror's, which open Paseo's widget for Paseo's
  // editor) never see these keys
  editorDom.addEventListener(
    "keydown",
    (event) => {
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (mod && !event.altKey && !event.shiftKey && key === "f") {
        event.preventDefault();
        event.stopPropagation();
        open();
      } else if (event.key === "F3" || (mod && !event.altKey && key === "g")) {
        event.preventDefault();
        event.stopPropagation();
        if (!input.value) {
          open();
          return;
        }
        show(true);
        step(!event.shiftKey);
      } else if (event.key === "Escape" && !bar.hidden) {
        show(false);
      }
    },
    true,
  );
}
