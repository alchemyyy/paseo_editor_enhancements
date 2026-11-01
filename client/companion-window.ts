// A tabbed companion window: a tab strip with Save, Reload, and Dock for the active tab, an info
// bar like the Source panel's toolbar (size, lines, cursor, and for Markdown and HTML the
// Preview | Split | Source controls, with Markdown's renderer and palette), and one CodeMirror
// editor per tab cloned from the file's Source editor. Tabs without a source editor, or for files
// too large to save, fall back to a read-only view with line rows. Everything runs in the main
// window's script.
import { type CompanionTheme, createCompanionGutter } from "./companion-gutter";
import { type CmView, type CompanionEditor, createCompanionEditor } from "./companion-editor";
import type { CompanionPreview, CompanionPreviewFactory } from "./companion-preview";
import type { Layout } from "./controls";
import type { FileContent, SaveResult } from "./hosts";
import { type GutterDocument, installGutterSelection } from "./gutter-select";
import { handOffLayout } from "./prefs";

// Narrow structural types for what this module touches; they shadow lib.dom's in this module.
interface Node {
  textContent: string | null;
  draggable: boolean;
  readonly parentElement: Node | null;
  readonly nextSibling: Node | null;
  readonly style: { setProperty(name: string, value: string): void };
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  getAttribute(name: string): string | null;
  appendChild(node: Node): void;
  insertBefore(node: Node, reference: Node | null): void;
  replaceChildren(...nodes: Node[]): void;
  remove(): void;
  contains(other: unknown): boolean;
  closest(selector: string): Node | null;
  getBoundingClientRect(): { left: number; width: number };
  addEventListener(type: string, listener: (event: never) => void): void;
}
interface PointerLike {
  target: Node | null;
  button: number;
  clientX: number;
  clientY: number;
  screenX: number;
  screenY: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  key: string;
  preventDefault(): void;
  stopPropagation(): void;
}
export interface PopupWindow {
  closed: boolean;
  readonly screenX: number;
  readonly screenY: number;
  readonly outerWidth: number;
  readonly outerHeight: number;
  readonly innerWidth: number;
  readonly innerHeight: number;
  document: {
    title: string;
    body: Node;
    head: Node;
    documentElement: Node;
    createElement(tag: string): Node;
    elementFromPoint(x: number, y: number): Node | null;
    addEventListener(type: string, listener: (event: never) => void): void;
  };
  addEventListener(type: string, listener: () => void): void;
  confirm(message: string): boolean;
  moveTo(x: number, y: number): void;
  resizeTo(width: number, height: number): void;
  focus(): void;
  close(): void;
}
declare const document: {
  documentElement: unknown;
  getElementById(id: string): { textContent: string | null } | null;
};
declare const window: { getComputedStyle(element: unknown): { getPropertyValue(name: string): string } };

export interface CompanionFile {
  /** Identifies the file across windows: host, workspace, and path */
  key: string;
  /** The tab's path, usually workspace-relative; line references use it */
  path: string;
  read(): Promise<FileContent>;
  write(content: string, expectedHash: string): Promise<SaveResult>;
  dock(): void;
  serverId: string;
  workspaceId: string;
}

/** What a tab needs to open; a tab moving between windows also carries its text and disk state */
export interface TabSeed {
  file: CompanionFile;
  sourceView: CmView | null;
  moved?: { content: string; savedContent: string; hash: string; size: number; truncated: boolean };
  /** A Markdown or HTML tab's Preview | Split | Source layout in the view it comes from */
  layout?: Layout | null;
}

export interface CompanionWindow {
  readonly popup: PopupWindow;
  /** Adds a tab, at the strip position under `at` (screen coordinates) when given */
  addTab(seed: TabSeed, at?: { screenX: number; screenY: number }): void;
  /**
   * Shows a placeholder tab named `label` where a tab released at this screen point would land;
   * clears with null
   */
  markDropAt(at: { screenX: number; screenY: number } | null, label?: string): void;
  hasTab(key: string): boolean;
  /** The tab's seed for moving it elsewhere; its editor keeps working until removed */
  seedOf(key: string): TabSeed | null;
  removeTab(key: string): void;
  dockTab(key: string): Promise<void>;
  containsScreenPoint(x: number, y: number): boolean;
  /** Saves every tab with unsaved edits; resolves once the saves settle */
  saveAll(): Promise<void>;
  dispose(): void;
}

export interface CompanionWindowHooks {
  /** The last tab closed or left */
  onEmpty(window: CompanionWindow): void;
  /**
   * A tab dragged by the pointer outside this window: "move" while it travels, "end" when it is
   * released outside, "cancel" when it comes back and is released inside
   */
  onTabDrag(window: CompanionWindow, key: string, phase: "move" | "end" | "cancel", screenX: number, screenY: number): void;
  /** Preview | Split | Source and the preview for a Markdown or HTML tab, or null for other files */
  previews?: CompanionPreviewFactory;
}

const UNSAVED_MARK = "●";
const CLOSE_GLYPH = "×";
const TAB_ATTRIBUTE = "data-companion-tab";
const ACTIVE_ATTRIBUTE = "data-active";
const DROP_ATTRIBUTE = "data-drop-before";
const PLACEHOLDER_ATTRIBUTE = "data-placeholder";
/** Pointer travel before a press on a tab becomes a drag */
const TAB_DRAG_MIN_DISTANCE_PX = 6;
/** Paseo's scrollbar stylesheet (packages/app/src/styles/install-web-scrollbar-styles.web.ts) */
const SCROLLBAR_STYLE_ID = "paseo-web-scrollbar-styles";
const MIDDLE_BUTTON = 1;

function css(node: Node, style: Record<string, string>): Node {
  for (const [name, value] of Object.entries(style)) node.style.setProperty(name, value);
  return node;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1) || path;
}

/** packages/app/src/utils/format-file-size.ts */
function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** Paseo's scrollbar rules plus the theme variables they read, copied from this window */
function scrollbarStyleText(): string | null {
  const rules = document.getElementById(SCROLLBAR_STYLE_ID)?.textContent;
  if (!rules) return null;
  const rootStyle = window.getComputedStyle(document.documentElement);
  const variables = [...new Set(rules.match(/--[\w-]+/g) ?? [])]
    .map((name) => `${name}: ${rootStyle.getPropertyValue(name).trim()};`)
    .join(" ");
  return `:root { ${variables} }\n${rules}`;
}

function chromeStyleText(theme: CompanionTheme): string {
  const tint = (percent: number) => `color-mix(in srgb, ${theme.foreground} ${percent}%, transparent)`;
  return [
    `.bcd-tabs{display:flex;gap:2px;overflow-x:auto;flex:1;min-width:0;scrollbar-width:none}`,
    `.bcd-tab{display:flex;align-items:center;gap:6px;padding:4px 4px 4px 10px;border-radius:6px;cursor:pointer;white-space:nowrap;color:${theme.muted};user-select:none;flex-shrink:0}`,
    `.bcd-tab:hover{background:${tint(6)}}`,
    `.bcd-tab[${ACTIVE_ATTRIBUTE}]{background:${tint(11)};color:${theme.foreground}}`,
    `.bcd-tab[${DROP_ATTRIBUTE}]{box-shadow:inset 2px 0 0 ${theme.foreground}}`,
    `.bcd-tab[${PLACEHOLDER_ATTRIBUTE}]{opacity:0.6;outline:1px dashed ${tint(45)};outline-offset:-1px;padding-right:10px;pointer-events:none}`,
    `.bcd-tab-close{width:18px;height:18px;display:flex;align-items:center;justify-content:center;border-radius:4px;font-size:15px;line-height:1;opacity:0}`,
    `.bcd-tab:hover .bcd-tab-close,.bcd-tab[${ACTIVE_ATTRIBUTE}] .bcd-tab-close{opacity:0.75}`,
    `.bcd-tab-close:hover{background:${tint(16)};opacity:1}`,
    `.bcd-button{background:transparent;color:${theme.foreground};border:1px solid ${tint(25)};border-radius:6px;padding:3px 10px;font:inherit;cursor:pointer;flex-shrink:0}`,
    `.bcd-button:hover{background:${tint(8)}}`,
  ].join("");
}

interface Tab {
  file: CompanionFile;
  sourceView: CmView | null;
  chip: Node;
  label: Node;
  container: Node;
  editor: CompanionEditor | null;
  rows: ReturnType<typeof createCompanionGutter> | null;
  hash: string;
  size: number;
  truncated: boolean;
  conflictHash: string | null;
  dirty: boolean;
  lines: number;
  cursor: { line: number; column: number } | null;
  message: string;
  reading: boolean;
  location: string;
  /** The latest text read, for tabs shown as read-only rows */
  content: string;
  preview: CompanionPreview | null;
  /** The layout the tab arrived with, for its preview controls once its view is built */
  arrivedLayout: Layout | null;
}

/** Turns a fresh popup into a tabbed companion window */
export function createCompanionWindow(
  popup: PopupWindow,
  theme: CompanionTheme,
  hooks: CompanionWindowHooks,
): CompanionWindow {
  const doc = popup.document;
  const make = (tag: string, style: Record<string, string> = {}) => css(doc.createElement(tag), style);
  const border = `1px solid color-mix(in srgb, ${theme.foreground} 12%, transparent)`;
  const tabs: Tab[] = [];
  let active: Tab | null = null;
  /** A drag from another window previews its tab here (see markDropAt) */
  let placeholder: Node | null = null;
  let disposed = false;

  for (const text of [scrollbarStyleText(), chromeStyleText(theme)]) {
    if (!text) continue;
    const style = doc.createElement("style");
    style.textContent = text;
    doc.head.appendChild(style);
  }
  css(doc.documentElement, { height: "100%" });
  css(doc.body, {
    margin: "0",
    height: "100%",
    display: "flex",
    "flex-direction": "column",
    // The drag preview centred its message; the editors need the full width and height
    "align-items": "stretch",
    "justify-content": "flex-start",
    background: theme.background,
    color: theme.foreground,
    "font-family": "system-ui, sans-serif",
    "font-size": "13px",
  });

  const bar = make("div", { display: "flex", "align-items": "center", gap: "8px", padding: "6px 10px", "border-bottom": border, "flex-shrink": "0" });
  const strip = make("div");
  strip.setAttribute("class", "bcd-tabs");
  const button = (label: string, onClick: () => void) => {
    const element = make("button");
    element.setAttribute("class", "bcd-button");
    element.textContent = label;
    element.addEventListener("click", onClick);
    return element;
  };
  const info = make("div", { display: "flex", "align-items": "center", gap: "12px", padding: "6px 12px", color: theme.muted, "font-size": "12px", "border-bottom": border, "flex-shrink": "0" });
  const sizeLabel = make("span");
  const linesLabel = make("span");
  const message = make("span", { flex: "1", "min-width": "0", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap", "text-align": "center" });
  const cursorLabel = make("span");
  // The active Markdown or HTML tab's controls; the slot shrinks before the labels do
  const controlsSlot = make("div", { display: "flex", "align-items": "center", "min-width": "0", "flex-shrink": "1" });
  info.replaceChildren(sizeLabel, linesLabel, message, cursorLabel, controlsSlot);
  const body = make("div", { flex: "1", "min-height": "0", display: "flex", "flex-direction": "column" });

  // One gutter selection install serves every tab's editor in this document
  const releaseGutter = installGutterSelection({
    doc: doc as unknown as GutterDocument,
    resolvePath: (editorElement) => tabs.find((tab) => tab.container.contains(editorElement))?.file.path ?? null,
  });

  const renderInfo = () => {
    if (!active) return;
    sizeLabel.textContent = formatFileSize(active.size);
    linesLabel.textContent = `${active.lines} ${active.lines === 1 ? "line" : "lines"}`;
    cursorLabel.textContent = active.cursor ? `Ln ${active.cursor.line}, Col ${active.cursor.column}` : "";
    message.textContent = active.message || active.location;
    message.style.setProperty("color", active.message ? theme.foreground : theme.muted);
    const controls = (active.preview?.controls ?? null) as unknown as Node | null;
    if (controls && controls.parentElement !== controlsSlot) controlsSlot.replaceChildren(controls);
    else if (!controls) controlsSlot.replaceChildren();
    active.preview?.fit(info as unknown as HTMLElement);
  };

  const renderChip = (tab: Tab) => {
    tab.label.textContent = `${tab.dirty ? `${UNSAVED_MARK} ` : ""}${basename(tab.file.path)}`;
    tab.chip.setAttribute("title", tab.location);
    if (tab === active) {
      tab.chip.setAttribute(ACTIVE_ATTRIBUTE, "true");
      doc.title = tab.label.textContent ?? "";
    } else {
      tab.chip.removeAttribute(ACTIVE_ATTRIBUTE);
    }
  };

  const setMessage = (tab: Tab, text: string) => {
    tab.message = text;
    if (tab === active) renderInfo();
  };

  const save = async (tab: Tab): Promise<boolean> => {
    if (!tab.editor || tab.truncated) return !tab.dirty;
    setMessage(tab, "Saving...");
    try {
      const result = await tab.file.write(tab.editor.text(), tab.conflictHash ?? tab.hash);
      if (result.status === "conflict") {
        tab.conflictHash = result.hash;
        setMessage(tab, "Changed on disk. Reload to see it, or Save again to overwrite.");
        return false;
      }
      tab.conflictHash = null;
      tab.hash = result.hash;
      tab.size = result.size;
      tab.editor.markSaved();
      setMessage(tab, "");
      return true;
    } catch (error) {
      setMessage(tab, error instanceof Error ? error.message : "Could not save");
      return false;
    }
  };

  /** Builds the tab's view from its first content, then its preview controls */
  const build = (tab: Tab, content: string, savedContent?: string) => {
    tab.content = content;
    buildView(tab, content, savedContent);
    tab.preview ??=
      hooks.previews?.({
        file: { serverId: tab.file.serverId, workspaceId: tab.file.workspaceId, path: tab.file.path },
        container: tab.container as unknown as HTMLElement,
        text: () => (tab.editor ? tab.editor.text() : tab.content),
        layout: tab.arrivedLayout,
      }) ?? null;
    if (tab === active) renderInfo();
  };

  /** The tab's view: an editor when possible, else line rows */
  const buildView = (tab: Tab, content: string, savedContent?: string) => {
    if (tab.sourceView && !tab.truncated) {
      const parent = make("div", { flex: "1", "min-height": "0", display: "flex", "flex-direction": "column" });
      tab.container.replaceChildren(parent);
      tab.editor = createCompanionEditor({
        sourceView: tab.sourceView,
        content,
        savedContent,
        parent,
        root: doc,
        onSave: () => void save(tab),
        onChange: (state) => {
          tab.dirty = state.dirty;
          tab.lines = state.lines;
          tab.cursor = { line: state.line, column: state.column };
          renderChip(tab);
          if (tab === active) renderInfo();
          if (state.docChanged) tab.preview?.textChanged();
        },
      });
      if (tab.editor) return;
    }
    const scroller = make("div", { flex: "1", overflow: "auto" });
    const lineRows = make("div", {
      display: "inline-block",
      "min-width": "100%",
      padding: "8px 0",
      "font-family": theme.fontFamily,
      "font-size": theme.fontSize,
      "line-height": theme.lineHeight,
    });
    scroller.appendChild(lineRows);
    tab.container.replaceChildren(scroller);
    tab.rows = createCompanionGutter(
      doc as unknown as Parameters<typeof createCompanionGutter>[0],
      scroller as unknown as Parameters<typeof createCompanionGutter>[1],
      lineRows as unknown as Parameters<typeof createCompanionGutter>[2],
      theme,
      tab.file.path,
    );
    tab.rows.render(content);
    tab.lines = content.split(/\r?\n/).length;
  };

  const show = (tab: Tab, content: FileContent) => {
    tab.hash = content.hash;
    tab.size = content.size;
    tab.truncated = content.truncated;
    tab.conflictHash = null;
    tab.location = content.absolutePath;
    tab.message = tab.truncated ? "Showing the first 4 MB; this file opens read-only here" : "";
    if (tab.editor) tab.editor.load(content.content);
    else if (tab.rows) {
      tab.rows.render(content.content);
      tab.lines = content.content.split(/\r?\n/).length;
    } else build(tab, content.content);
    tab.content = content.content;
    tab.preview?.textChanged();
    renderChip(tab);
    if (tab === active) renderInfo();
  };

  const refresh = (tab: Tab, force: boolean) => {
    if (tab.reading || popup.closed) return;
    tab.reading = true;
    tab.file
      .read()
      .then((content) => {
        if (!tab.editor && !tab.rows) return show(tab, content);
        if (content.hash && content.hash === tab.hash && !force) return;
        // Edits made here win until saved; say the disk moved instead of discarding them
        if (tab.editor?.isDirty() && !force) {
          tab.conflictHash = content.hash;
          setMessage(tab, "Changed on disk. Reload to see it, or Save to overwrite.");
          return;
        }
        show(tab, content);
      })
      .catch((error: unknown) => setMessage(tab, error instanceof Error ? error.message : "Could not read this file"))
      .finally(() => {
        tab.reading = false;
      });
  };

  const activate = (tab: Tab) => {
    active = tab;
    for (const candidate of tabs) {
      candidate.container.style.setProperty("display", candidate === tab ? "flex" : "none");
      renderChip(candidate);
    }
    renderInfo();
    tab.editor?.view.focus();
    refresh(tab, false);
  };

  const remove = (tab: Tab) => {
    const index = tabs.indexOf(tab);
    if (index < 0) return;
    tabs.splice(index, 1);
    tab.chip.remove();
    tab.container.remove();
    tab.preview?.dispose();
    tab.editor?.view.destroy();
    if (tabs.length === 0) {
      active = null;
      hooks.onEmpty(handle);
      return;
    }
    if (active === tab) activate(tabs[Math.min(index, tabs.length - 1)]);
  };

  /** Closing a tab with unsaved edits saves them first; a failed save keeps it open */
  const close = async (tab: Tab) => {
    if (tab.editor?.isDirty() && !(await save(tab))) return;
    remove(tab);
  };

  const dock = async (tab: Tab) => {
    if (tab.editor?.isDirty() && !(await save(tab))) return;
    // The main window's Markdown or HTML panel opens in the layout the tab had here
    if (tab.preview) handOffLayout(tab.file.key, tab.preview.layout);
    tab.file.dock();
    remove(tab);
  };

  const tabOf = (node: Node | null): Tab | null => {
    const chip = node?.closest(`[${TAB_ATTRIBUTE}]`) ?? null;
    return tabs.find((tab) => tab.chip === chip) ?? null;
  };

  const clearDropMarks = () => {
    for (const tab of tabs) tab.chip.removeAttribute(DROP_ATTRIBUTE);
  };

  /**
   * Where a drop at a point inside this window lands in the strip: before a tab, at the end
   * (`before` null), or nowhere when the point is off the strip
   */
  const stripTargetAt = (clientX: number, clientY: number): { before: Tab | null } | null => {
    const element = doc.elementFromPoint(clientX, clientY);
    if (!element || !strip.contains(element)) return null;
    const over = tabOf(element);
    if (!over) return { before: null };
    const rect = over.chip.getBoundingClientRect();
    return { before: clientX < rect.left + rect.width / 2 ? over : (tabs[tabs.indexOf(over) + 1] ?? null) };
  };

  /**
   * A screen point in this window's page coordinates. Drags from other windows only report
   * screen positions; the frame offsets come from the outer and inner sizes.
   */
  const screenToClient = (screenX: number, screenY: number) => {
    const side = Math.max(0, (popup.outerWidth - popup.innerWidth) / 2);
    const top = Math.max(0, popup.outerHeight - popup.innerHeight - side);
    return { x: screenX - popup.screenX - side, y: screenY - popup.screenY - top };
  };

  const reorder = (moving: Tab, before: Tab | null) => {
    if (moving === before) return;
    tabs.splice(tabs.indexOf(moving), 1);
    tabs.splice(before ? tabs.indexOf(before) : tabs.length, 0, moving);
    strip.insertBefore(moving.chip, before?.chip ?? null);
  };

  const addTab = (seed: TabSeed, at?: { screenX: number; screenY: number }) => {
    clearDropMarks();
    // Measure the drop position without the placeholder, which shifts the tabs after it
    placeholder?.remove();
    const existing = tabs.find((tab) => tab.file.key === seed.file.key);
    if (existing) {
      activate(existing);
      return;
    }
    const point = at ? screenToClient(at.screenX, at.screenY) : null;
    const target = point ? stripTargetAt(point.x, point.y) : null;
    const chip = make("div");
    chip.setAttribute("class", "bcd-tab");
    chip.setAttribute(TAB_ATTRIBUTE, "true");
    const label = make("span");
    const closeButton = make("span");
    closeButton.setAttribute("class", "bcd-tab-close");
    closeButton.textContent = CLOSE_GLYPH;
    chip.replaceChildren(label, closeButton);
    const container = make("div", { flex: "1", "min-height": "0", "flex-direction": "column", display: "none" });
    const tab: Tab = {
      file: seed.file,
      sourceView: seed.sourceView,
      chip,
      label,
      container,
      editor: null,
      rows: null,
      hash: seed.moved?.hash ?? "",
      size: seed.moved?.size ?? 0,
      truncated: seed.moved?.truncated ?? false,
      conflictHash: null,
      dirty: false,
      lines: 0,
      cursor: null,
      message: "",
      reading: false,
      location: seed.file.path,
      content: "",
      preview: null,
      arrivedLayout: seed.layout ?? null,
    };
    chip.addEventListener("mousedown", (event: PointerLike) => {
      if (event.button === MIDDLE_BUTTON) {
        event.preventDefault();
        void close(tab);
        return;
      }
      if (event.button !== 0 || closeButton.contains(event.target)) return;
      // Pointer tracking rather than native drag and drop, which shows a no-entry cursor
      event.preventDefault();
      tabDrag = { tab, x: event.screenX, y: event.screenY, dragging: false };
    });
    chip.addEventListener("click", (event: PointerLike) => {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      if (closeButton.contains(event.target)) void close(tab);
      else activate(tab);
    });
    tabs.push(tab);
    strip.appendChild(chip);
    body.appendChild(container);
    if (target) reorder(tab, target.before);
    if (seed.moved) build(tab, seed.moved.content, seed.moved.savedContent);
    activate(tab);
  };

  // Tab drags follow the pointer, which keeps reporting after it leaves this window
  let tabDrag: { tab: Tab; x: number; y: number; dragging: boolean } | null = null;
  let suppressClick = false;
  const insideWindow = (event: PointerLike) =>
    event.clientX >= 0 && event.clientY >= 0 && event.clientX < popup.innerWidth && event.clientY < popup.innerHeight;

  doc.addEventListener("mousemove", (event: PointerLike) => {
    const drag = tabDrag;
    if (!drag) return;
    if (!drag.dragging) {
      if (Math.hypot(event.screenX - drag.x, event.screenY - drag.y) < TAB_DRAG_MIN_DISTANCE_PX) return;
      drag.dragging = true;
      doc.body.style.setProperty("cursor", "grabbing");
    }
    clearDropMarks();
    if (insideWindow(event)) {
      stripTargetAt(event.clientX, event.clientY)?.before?.chip.setAttribute(DROP_ATTRIBUTE, "true");
      hooks.onTabDrag(handle, drag.tab.file.key, "cancel", event.screenX, event.screenY);
      return;
    }
    hooks.onTabDrag(handle, drag.tab.file.key, "move", event.screenX, event.screenY);
  });

  doc.addEventListener("mouseup", (event: PointerLike) => {
    const drag = tabDrag;
    tabDrag = null;
    if (!drag?.dragging) return;
    doc.body.style.setProperty("cursor", "");
    clearDropMarks();
    // The click that follows a drag released over a tab is not a tab switch
    suppressClick = true;
    setTimeout(() => {
      suppressClick = false;
    }, 0);
    if (insideWindow(event)) {
      const target = stripTargetAt(event.clientX, event.clientY);
      if (target) reorder(drag.tab, target.before);
      hooks.onTabDrag(handle, drag.tab.file.key, "cancel", event.screenX, event.screenY);
      return;
    }
    hooks.onTabDrag(handle, drag.tab.file.key, "end", event.screenX, event.screenY);
  });

  doc.addEventListener("keydown", (event: PointerLike) => {
    if (!active || !(event.ctrlKey || event.metaKey)) return;
    if (event.key === "w" || event.key === "W") {
      event.preventDefault();
      void close(active);
    } else if (event.key === "Tab" && tabs.length > 1) {
      event.preventDefault();
      const step = event.shiftKey ? -1 : 1;
      activate(tabs[(tabs.indexOf(active) + step + tabs.length) % tabs.length]);
    }
  });

  bar.replaceChildren(
    strip,
    button("Save", () => active && void save(active)),
    button("Reload", () => {
      if (!active) return;
      if (active.editor?.isDirty() && !popup.confirm("Discard unsaved changes and reload from disk?")) return;
      refresh(active, true);
    }),
    button("Dock", () => active && void dock(active)),
  );
  doc.body.replaceChildren(bar, info, body);

  const saveAll = async () => {
    await Promise.all(tabs.filter((tab) => tab.editor?.isDirty()).map((tab) => save(tab)));
  };

  // Coming back to the window picks up changes made elsewhere
  popup.addEventListener("focus", () => active && refresh(active, false));
  // The preview controls drop parts that no longer fit
  popup.addEventListener("resize", renderInfo);
  // Closing with unsaved edits saves them; the requests run from the main window
  popup.addEventListener("beforeunload", () => void saveAll());

  const handle: CompanionWindow = {
    popup,
    addTab,
    markDropAt(at, label) {
      if (!at) {
        placeholder?.remove();
        return;
      }
      if (!placeholder) {
        placeholder = make("div");
        placeholder.setAttribute("class", "bcd-tab");
        placeholder.setAttribute(PLACEHOLDER_ATTRIBUTE, "true");
      }
      placeholder.textContent = label ?? "";
      const point = screenToClient(at.screenX, at.screenY);
      // Off the strip, a drop adds the tab at the end, so the placeholder shows there
      const before = stripTargetAt(point.x, point.y)?.before ?? null;
      const reference = before?.chip ?? null;
      if (placeholder.parentElement !== strip || placeholder.nextSibling !== reference) {
        strip.insertBefore(placeholder, reference);
      }
    },
    hasTab: (key) => tabs.some((tab) => tab.file.key === key),
    seedOf(key) {
      const tab = tabs.find((candidate) => candidate.file.key === key);
      if (!tab) return null;
      return {
        file: tab.file,
        // The tab's own editor carries the source editor's setup on to the next window
        sourceView: tab.editor?.view ?? tab.sourceView,
        layout: tab.preview?.layout ?? tab.arrivedLayout,
        moved: tab.editor
          ? {
              content: tab.editor.text(),
              savedContent: tab.editor.savedText(),
              hash: tab.hash,
              size: tab.size,
              truncated: tab.truncated,
            }
          : undefined,
      };
    },
    removeTab(key) {
      const tab = tabs.find((candidate) => candidate.file.key === key);
      if (tab) remove(tab);
    },
    async dockTab(key) {
      const tab = tabs.find((candidate) => candidate.file.key === key);
      if (tab) await dock(tab);
    },
    containsScreenPoint(x, y) {
      if (popup.closed) return false;
      return x >= popup.screenX && x < popup.screenX + popup.outerWidth && y >= popup.screenY && y < popup.screenY + popup.outerHeight;
    },
    saveAll,
    dispose() {
      if (disposed) return;
      disposed = true;
      releaseGutter();
      for (const tab of tabs) {
        tab.preview?.dispose();
        tab.editor?.view.destroy();
      }
      tabs.length = 0;
    },
  };
  popup.focus();
  return handle;
}
