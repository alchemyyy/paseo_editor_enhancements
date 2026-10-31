// Tearing a file tab out into a companion window (desktop only). Releasing a file tab's drag
// outside the main window opens a small window at the release point that edits the file.
// The main window's renderer has no window-open handler (packages/desktop/src/main.ts installs
// one only for browser webviews), so a same-origin popup opens and stays scriptable from here:
// the companion is DOM built and driven by this window, with no app bundle of its own.
import type { CompanionTheme } from "./companion-gutter";
import { type CmView, findEditorView } from "./companion-editor";
import type { CompanionMarkdownFactory } from "./companion-markdown";
import { type CompanionWindow, createCompanionWindow, type PopupWindow, type TabSeed } from "./companion-window";
import { findPaneBridge, type StoreApi } from "./fiber";
import type { FileContent, SaveResult } from "./hosts";
import { markdownLayoutOf, revealMarkdownSource } from "./markdown-panels";
import { collectPanes, type LayoutState, type LayoutTab, type TabTarget, tabIdentity } from "./layout";

// Narrow structural types for what this module touches; they shadow lib.dom's in this module.
interface Node {
  readonly parentElement: Node | null;
  readonly nextSibling: Node | null;
  innerHTML: string;
  readonly style: { setProperty(name: string, value: string): void; color: string; marginRight: string };
  getBoundingClientRect(): { left: number; right: number; width: number };
  closest(selector: string): Node | null;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  querySelector(selector: string): Node | null;
  querySelectorAll(selector: string): ArrayLike<Node>;
  insertBefore(node: Node, reference: Node | null): void;
  remove(): void;
  addEventListener(type: string, listener: () => void): void;
  setPointerCapture?(pointerId: number): void;
}
interface PointerEventLike {
  target: Node | null;
  pointerId: number;
  button: number;
  clientX: number;
  clientY: number;
  screenX: number;
  screenY: number;
}
declare const window: {
  innerWidth: number;
  innerHeight: number;
  screenX: number;
  screenY: number;
  outerWidth: number;
  outerHeight: number;
  open(url: string, name: string, features: string): PopupWindow | null;
  getComputedStyle(element: Node): Record<string, string>;
  addEventListener(type: string, listener: (event: never) => void, capture?: boolean): void;
  removeEventListener(type: string, listener: (event: never) => void, capture?: boolean): void;
};
declare const localStorage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
declare const document: {
  createElement(tag: string): Node;
  querySelector(selector: string): Node | null;
  querySelectorAll(selector: string): ArrayLike<Node>;
};

const DRAG_MIN_DISTANCE_PX = 8;
const FILE_CHIP_SELECTOR = '[data-testid^="workspace-tab-file_"]';
const CHIP_PREFIX = "workspace-tab-";
const TABS_ROW_SELECTOR = '[data-testid="workspace-tabs-row"]';
const TABS_SCROLL_SELECTOR = '[data-testid="workspace-tabs-scroll"]';
/** The undock handle: drag it out, or click it, to move a pane's files into a companion */
const HANDLE_ATTRIBUTE = "data-editor-enhancements-undock";
// Same 29px footprint as before (19px wide plus 10px of margin), with most of it now the button
const HANDLE_HEIGHT_PX = 26;
const HANDLE_WIDTH_PX = 25;
/** Space between the handle and the first visible tab */
const HANDLE_GAP_PX = 4;
/** Tab labels, whose colour the handle takes; the strip itself has none, so `inherit` is black */
const TAB_LABEL_SELECTOR = `${TABS_SCROLL_SELECTOR} [dir="auto"]`;
// Lucide "external-link"
const HANDLE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>';

/** Margin after the handle that leaves exactly HANDLE_GAP_PX before the first visible tab */
function fitHandleGap(handle: Node, row: Node): void {
  const chips = row.querySelectorAll(`${TABS_SCROLL_SELECTOR} [data-testid^="workspace-tab-"]`);
  for (let index = 0; index < chips.length; index++) {
    const chipRect = chips[index].getBoundingClientRect();
    // Hidden chips (chats) report no width
    if (chipRect.width === 0) continue;
    const margin = Number.parseFloat(handle.style.marginRight) || 0;
    const gap = chipRect.left - handle.getBoundingClientRect().right;
    const next = Math.round((margin + HANDLE_GAP_PX - gap) * 10) / 10;
    if (Math.abs(next - margin) >= 0.5) handle.style.setProperty("margin-right", `${next}px`);
    return;
  }
}

function createHandle(): Node {
  const handle = document.createElement("button");
  handle.setAttribute(HANDLE_ATTRIBUTE, "true");
  handle.setAttribute("title", "Undock these files into a companion window (click, or drag out)");
  handle.innerHTML = HANDLE_SVG;
  for (const [name, value] of Object.entries({
    width: `${HANDLE_WIDTH_PX}px`,
    height: `${HANDLE_HEIGHT_PX}px`,
    margin: "0 2px",
    padding: "0",
    display: "flex",
    "align-items": "center",
    "justify-content": "center",
    "flex-shrink": "0",
    background: "transparent",
    border: "none",
    "border-radius": "6px",
    opacity: "0.6",
    cursor: "grab",
    "-webkit-app-region": "no-drag",
  })) {
    handle.style.setProperty(name, value);
  }
  handle.addEventListener("pointerenter", () => {
    handle.style.setProperty("opacity", "1");
    handle.style.setProperty("background", "color-mix(in srgb, currentColor 12%, transparent)");
  });
  handle.addEventListener("pointerleave", () => {
    handle.style.setProperty("opacity", "0.6");
    handle.style.setProperty("background", "transparent");
  });
  return handle;
}
const WINDOW_WIDTH = 820;
const WINDOW_HEIGHT = 620;
/** The content size of the companion resized last; new companions open at it. Key from better-chat-management (formerly better-chat-display), kept so the size survives the move */
const SIZE_STORAGE_KEY = "better-chat-display:companion-size";
const MIN_WINDOW_SIZE = 200;
const SIZE_SAVE_DELAY_MS = 300;

function savedWindowSize(): { width: number; height: number } {
  try {
    const parsed = JSON.parse(localStorage.getItem(SIZE_STORAGE_KEY) ?? "null") as { width?: unknown; height?: unknown } | null;
    const width = typeof parsed?.width === "number" ? parsed.width : 0;
    const height = typeof parsed?.height === "number" ? parsed.height : 0;
    if (width >= MIN_WINDOW_SIZE && height >= MIN_WINDOW_SIZE) return { width, height };
  } catch {
    // Unreadable: use the default
  }
  return { width: WINDOW_WIDTH, height: WINDOW_HEIGHT };
}

/** Remembers the companion's content size whenever the user resizes it */
function trackWindowSize(popup: PopupWindow): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  popup.addEventListener("resize", () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (popup.closed || popup.innerWidth < MIN_WINDOW_SIZE || popup.innerHeight < MIN_WINDOW_SIZE) return;
      try {
        localStorage.setItem(SIZE_STORAGE_KEY, JSON.stringify({ width: popup.innerWidth, height: popup.innerHeight }));
      } catch {
        // Storage disabled: sizes last until the window closes
      }
    }, SIZE_SAVE_DELAY_MS);
  });
}
/** Puts the companion's title bar under the pointer rather than its corner */
const WINDOW_GRAB_OFFSET_X = 140;
const WINDOW_GRAB_OFFSET_Y = 14;
/** How long to wait for a just-focused tab's Source editor to mount */
const EDITOR_WAIT_MS = 1500;
const EDITOR_POLL_MS = 50;
/** About one frame; moves arriving faster are coalesced */
const GHOST_MOVE_INTERVAL_MS = 16;
const FALLBACK_THEME: CompanionTheme = {
  background: "#1e1f1e",
  foreground: "#e6e6e6",
  muted: "#8a8a8a",
  fontFamily: "ui-monospace, Consolas, monospace",
  fontSize: "13px",
  lineHeight: "20px",
};

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1) || path;
}

function isDesktop(): boolean {
  return Boolean((globalThis as unknown as { paseoDesktop?: unknown }).paseoDesktop);
}

/** Colours and type from the Source editor on screen, so the companion's chrome matches it */
function sampleTheme(): CompanionTheme {
  const editor = document.querySelector(".cm-editor");
  const content = document.querySelector(".cm-content");
  const gutter = document.querySelector(".cm-gutters");
  if (!editor || !content) return FALLBACK_THEME;
  const editorStyle = window.getComputedStyle(editor);
  const contentStyle = window.getComputedStyle(content);
  const background = editorStyle.backgroundColor;
  return {
    background: background && background !== "rgba(0, 0, 0, 0)" ? background : FALLBACK_THEME.background,
    foreground: contentStyle.color || FALLBACK_THEME.foreground,
    muted: (gutter && window.getComputedStyle(gutter).color) || FALLBACK_THEME.muted,
    fontFamily: contentStyle.fontFamily || FALLBACK_THEME.fontFamily,
    fontSize: contentStyle.fontSize || FALLBACK_THEME.fontSize,
    lineHeight:
      contentStyle.lineHeight && contentStyle.lineHeight !== "normal" ? contentStyle.lineHeight : FALLBACK_THEME.lineHeight,
  };
}

/** The Source editor showing `path` in a pane of this window, or null */
function findSourceView(path: string): CmView | null {
  const editors = document.querySelectorAll(".cm-editor");
  for (let index = 0; index < editors.length; index++) {
    const target = findPaneBridge(editors[index])?.target;
    if (target?.kind === "file" && target.path === path) {
      const view = findEditorView(editors[index]);
      if (view) return view;
    }
  }
  return null;
}

/** Polls for a file's Source editor; `reveal` runs first on each poll, to mount one if it can */
async function waitForSourceView(path: string, reveal: () => void): Promise<CmView | null> {
  const deadline = Date.now() + EDITOR_WAIT_MS;
  for (;;) {
    reveal();
    const view = findSourceView(path);
    if (view || Date.now() > deadline) return view;
    await new Promise((resolve) => setTimeout(resolve, EDITOR_POLL_MS));
  }
}

export function installTearOut(input: {
  layoutStore(): StoreApi<LayoutState> | null;
  selectedWorkspaces(): readonly string[];
  openTarget(serverId: string, workspaceId: string, target: TabTarget): boolean;
  readFile(workspaceId: string, path: string): Promise<FileContent>;
  writeFile(workspaceId: string, path: string, content: string, expectedHash: string): Promise<SaveResult>;
  /** Markdown controls and preview for companion tabs */
  markdown?: CompanionMarkdownFactory;
}): { stop(): void; sync(): void } {
  if (!isDesktop()) return { stop: () => {}, sync: () => {} };
  const companions = new Map<CompanionWindow, CompanionTheme>();
  /** A press on a file tab, or on a strip's undock handle, which carries all of its pane's files */
  let press: { identities: string[]; label: string; x: number; y: number; handle: boolean } | null = null;

  /** Where the companion's top-left goes so the pointer sits on its title bar */
  const windowOrigin = (screenX: number, screenY: number) => ({
    left: Math.max(0, Math.round(screenX - WINDOW_GRAB_OFFSET_X)),
    top: Math.max(0, Math.round(screenY - WINDOW_GRAB_OFFSET_Y)),
  });

  const openWindow = (screenX: number, screenY: number): PopupWindow | null => {
    const { left, top } = windowOrigin(screenX, screenY);
    const { width, height } = savedWindowSize();
    const popup = window.open(
      "",
      `editor-companion-${Date.now()}`,
      `popup=yes,width=${width},height=${height},left=${left},top=${top},autoHideMenuBar=yes`,
    );
    if (popup) trackWindowSize(popup);
    return popup;
  };

  /** The companion window under a screen point, other than `except` */
  const companionAt = (x: number, y: number, except?: CompanionWindow): CompanionWindow | null => {
    for (const companion of companions.keys()) {
      if (companion !== except && companion.containsScreenPoint(x, y)) return companion;
    }
    return null;
  };

  /** The companion showing a drop mark, so moving elsewhere can clear it */
  let marked: CompanionWindow | null = null;
  const markDrop = (target: CompanionWindow | null, x: number, y: number, label?: string) => {
    if (marked && marked !== target) marked.markDropAt(null);
    marked = target;
    target?.markDropAt({ screenX: x, screenY: y }, label);
  };

  const insideMainWindow = (x: number, y: number) =>
    x >= window.screenX && x < window.screenX + window.outerWidth && y >= window.screenY && y < window.screenY + window.outerHeight;

  const forget = (companion: CompanionWindow) => {
    companion.dispose();
    companions.delete(companion);
  };

  const createCompanion = (popup: PopupWindow, theme: CompanionTheme): CompanionWindow => {
    const companion = createCompanionWindow(popup, theme, {
      markdown: input.markdown,
      onEmpty: (empty) => {
        forget(empty);
        if (!empty.popup.closed) empty.popup.close();
      },
      onTabDrag: (from, key, phase, x, y) => {
        if (phase === "cancel") {
          dropGhost();
          markDrop(null, x, y);
          return;
        }
        if (phase === "move") {
          const over = companionAt(x, y, from);
          markDrop(over, x, y, basename(from.seedOf(key)?.file.path ?? ""));
          // The preview shows only where a release would open a new window
          if (insideMainWindow(x, y) || over || from.containsScreenPoint(x, y)) {
            dropGhost();
            return;
          }
          if (ghost) {
            moveGhost(x, y);
            return;
          }
          const name = basename(from.seedOf(key)?.file.path ?? "");
          showGhost(name, x, y, (dropX, dropY, popup) => dropCompanionTab(from, key, dropX, dropY, popup));
          return;
        }
        markDrop(null, x, y);
        const preview = takeGhost();
        dropCompanionTab(from, key, x, y, preview);
      },
    });
    companions.set(companion, theme);
    popup.addEventListener("unload", () => forget(companion));
    return companion;
  };

  /**
   * Lands a companion tab released outside its window: in the companion under the point, back
   * in the main window, or in `opened` (the drag preview) or a new window
   */
  const dropCompanionTab = (from: CompanionWindow, key: string, x: number, y: number, opened: PopupWindow | null) => {
    const seed = from.seedOf(key);
    if (!seed) {
      opened?.close();
      return;
    }
    if (!opened) {
      const target = companionAt(x, y, from);
      if (target) {
        target.addTab(seed, { screenX: x, screenY: y });
        from.removeTab(key);
        target.popup.focus();
        return;
      }
      if (insideMainWindow(x, y)) {
        void from.dockTab(key);
        return;
      }
    }
    const popup = opened ?? openWindow(x, y);
    if (!popup) return;
    createCompanion(popup, companions.get(from) ?? sampleTheme()).addTab(seed);
    from.removeTab(key);
  };

  /** Turns a main-window file tab into a companion tab seed, closing the main tab */
  const seedFor = async (store: StoreApi<LayoutState>, workspaceKey: string, tab: LayoutTab): Promise<TabSeed> => {
    const separator = workspaceKey.indexOf(":");
    const serverId = workspaceKey.slice(0, separator);
    const workspaceId = workspaceKey.slice(separator + 1);
    const { target } = tab;
    const path = target.path ?? "";
    const key = `${workspaceKey}:${path}`;
    // A Markdown tab keeps its Preview | Split | Source layout in the companion
    const layout = markdownLayoutOf(key);
    // The companion copies the file's own editor, which only exists while its tab shows Source:
    // a Markdown tab on Preview switches to Source for the moment before it closes
    let sourceView = findSourceView(path);
    if (!sourceView) {
      store.getState().focusTab(workspaceKey, tab.tabId);
      sourceView = await waitForSourceView(path, () => revealMarkdownSource(key));
    }
    store.getState().closeTab(workspaceKey, tab.tabId);
    return {
      file: {
        key,
        path,
        serverId,
        workspaceId,
        read: () => input.readFile(workspaceId, path),
        write: (content, expectedHash) => input.writeFile(workspaceId, path, content, expectedHash),
        dock: () => input.openTarget(serverId, workspaceId, target),
      },
      sourceView,
      layout,
    };
  };

  /** Main-window file tabs by identity, in the order given, skipping ones with unsaved changes */
  const findTabs = (state: LayoutState, identities: readonly string[]): { workspaceKey: string; tab: LayoutTab }[] => {
    const found: { workspaceKey: string; tab: LayoutTab }[] = [];
    for (const identity of identities) {
      // A tab with unsaved changes stays put; closing it here would discard them
      if (document.querySelector(`[data-testid="${CHIP_PREFIX}modified-${identity}"]`)) continue;
      search: for (const workspaceKey of input.selectedWorkspaces()) {
        const layout = state.layoutByWorkspace[workspaceKey];
        if (!layout) continue;
        for (const pane of collectPanes(layout.root)) {
          const tab = (pane.tabs ?? []).find((candidate) => tabIdentity(candidate) === identity);
          if (tab?.target.kind === "file" && tab.target.path) {
            found.push({ workspaceKey, tab });
            break search;
          }
        }
      }
    }
    return found;
  };

  /**
   * Moves main-window file tabs into a companion: the one under the drop point, else `opened`
   * (the drag preview), else a new window at the drop point
   */
  const tearOut = async (identities: readonly string[], screenX: number, screenY: number, opened: PopupWindow | null) => {
    const store = input.layoutStore();
    const tabs = store ? findTabs(store.getState(), identities) : [];
    if (!store || tabs.length === 0) {
      opened?.close();
      return;
    }
    const theme = sampleTheme();
    const existing = opened ? null : companionAt(screenX, screenY);
    const popup = existing ? null : (opened ?? openWindow(screenX, screenY));
    if (!existing && !popup) return;
    // One at a time: a tab that is not showing has to be focused for its editor to exist
    const seeds: TabSeed[] = [];
    for (const { workspaceKey, tab } of tabs) seeds.push(await seedFor(store, workspaceKey, tab));
    const companion = existing ?? (popup && !popup.closed ? createCompanion(popup, theme) : null);
    if (!companion) return;
    // Each lands just before the tab the drop point is before, so they keep their order
    for (const seed of seeds) companion.addTab(seed, existing ? { screenX, screenY } : undefined);
    companion.popup.focus();
  };

  /**
   * The companion follows the pointer while a file tab is dragged outside this window, as a
   * preview of where it will open. Dragging back inside cancels it.
   */
  let ghost: {
    popup: PopupWindow;
    /** Finishes the drop into this window */
    onDrop(screenX: number, screenY: number, popup: PopupWindow): void;
    /** Outer size at open; each move restores it (see moveGhost) */
    width: number;
    height: number;
    pending: { left: number; top: number } | null;
    timer: ReturnType<typeof setTimeout> | null;
  } | null = null;

  /**
   * Moves at most once a frame, then restores the size. On Windows with display scaling,
   * every programmatic move rounds the window's size up, so a stream of moves grows it.
   */
  const moveGhost = (screenX: number, screenY: number) => {
    const current = ghost;
    if (!current) return;
    current.pending = windowOrigin(screenX, screenY);
    if (current.timer) return;
    current.timer = setTimeout(() => {
      current.timer = null;
      const target = current.pending;
      current.pending = null;
      if (!target || current.popup.closed) return;
      current.popup.moveTo(target.left, target.top);
      if (current.popup.outerWidth !== current.width || current.popup.outerHeight !== current.height) {
        current.popup.resizeTo(current.width, current.height);
      }
    }, GHOST_MOVE_INTERVAL_MS);
  };

  const showGhost = (
    name: string,
    screenX: number,
    screenY: number,
    onDrop: (screenX: number, screenY: number, popup: PopupWindow) => void,
  ) => {
    const popup = openWindow(screenX, screenY);
    if (!popup) return;
    const theme = sampleTheme();
    const doc = popup.document as unknown as {
      title: string;
      body: { textContent: string | null; style: { setProperty(name: string, value: string): void } };
      addEventListener(type: string, listener: (event: { screenX: number; screenY: number; buttons: number }) => void): void;
    };
    doc.title = name;
    doc.body.textContent = `Release to open ${name}`;
    for (const [property, value] of Object.entries({
      margin: "0",
      height: "100vh",
      display: "flex",
      "align-items": "center",
      "justify-content": "center",
      background: theme.background,
      color: theme.muted,
      "font-family": "system-ui, sans-serif",
      "font-size": "14px",
    })) {
      doc.body.style.setProperty(property, value);
    }
    // If the new window takes the pointer from this one, it carries itself and finishes the drop
    doc.addEventListener("mousemove", (event) => {
      if (event.buttons !== 1 || ghost?.popup !== popup) return;
      moveGhost(event.screenX, event.screenY);
    });
    doc.addEventListener("mouseup", (event) => {
      if (ghost?.popup !== popup) return;
      takeGhost();
      press = null;
      onDrop(event.screenX, event.screenY, popup);
    });
    // A just-opened window can report no size yet; fall back to the requested one
    const requested = savedWindowSize();
    const width = popup.outerWidth > 0 ? popup.outerWidth : requested.width;
    const height = popup.outerHeight > 0 ? popup.outerHeight : requested.height;
    ghost = { popup, onDrop, width, height, pending: null, timer: null };
  };

  /** Ends the preview's following and hands its window over for the drop */
  const takeGhost = (): PopupWindow | null => {
    const current = ghost;
    if (!current) return null;
    if (current.timer) clearTimeout(current.timer);
    ghost = null;
    return current.popup.closed ? null : current.popup;
  };

  const dropGhost = () => {
    if (ghost?.timer) clearTimeout(ghost.timer);
    if (ghost && !ghost.popup.closed) ghost.popup.close();
    ghost = null;
  };

  const onPointerMove = (event: PointerEventLike) => {
    if (!press) return;
    const outside =
      event.clientX < 0 || event.clientY < 0 || event.clientX > window.innerWidth || event.clientY > window.innerHeight;
    // Over the main window cancels; over a companion, the drop adds a tab there instead
    const over = outside ? companionAt(event.screenX, event.screenY) : null;
    markDrop(over, event.screenX, event.screenY, press.label);
    if (!outside || over) {
      dropGhost();
      return;
    }
    if (!ghost) {
      const { identities, label } = press;
      showGhost(label, event.screenX, event.screenY, (x, y, popup) => void tearOut(identities, x, y, popup));
      return;
    }
    moveGhost(event.screenX, event.screenY);
  };

  /** The file tabs of the pane whose strip holds `row`, in strip order */
  const paneFileIdentities = (row: Node): string[] => {
    const store = input.layoutStore();
    if (!store) return [];
    const chips = row.querySelectorAll(`[data-testid^="${CHIP_PREFIX}"]`);
    const shown = new Set<string>();
    for (let index = 0; index < chips.length; index++) {
      shown.add((chips[index].getAttribute("data-testid") ?? "").slice(CHIP_PREFIX.length));
    }
    const state = store.getState();
    for (const workspaceKey of input.selectedWorkspaces()) {
      const layout = state.layoutByWorkspace[workspaceKey];
      if (!layout) continue;
      for (const pane of collectPanes(layout.root)) {
        const tabs = pane.tabs ?? [];
        if (!tabs.some((tab) => shown.has(tabIdentity(tab)))) continue;
        return tabs.filter((tab) => tab.target.kind === "file").map(tabIdentity);
      }
    }
    return [];
  };

  const onPointerDown = (event: PointerEventLike) => {
    press = null;
    if (event.button !== 0 || !event.target) return;
    const chip = event.target.closest(FILE_CHIP_SELECTOR);
    const testId = chip?.getAttribute("data-testid");
    if (testId) {
      const identity = testId.slice(CHIP_PREFIX.length);
      press = {
        identities: [identity],
        label: basename(identity.replace(/^file_/, "")),
        x: event.clientX,
        y: event.clientY,
        handle: false,
      };
      return;
    }
    const handle = event.target.closest(`[${HANDLE_ATTRIBUTE}]`);
    const row = handle?.closest(TABS_ROW_SELECTOR);
    if (!handle || !row) return;
    const identities = paneFileIdentities(row);
    if (identities.length === 0) return;
    const label = identities.length === 1 ? basename(identities[0].replace(/^file_/, "")) : `${identities.length} files`;
    press = { identities, label, x: event.clientX, y: event.clientY, handle: true };
    // Nothing else drags the handle, so keep receiving the pointer after it leaves the window
    handle.setPointerCapture?.(event.pointerId);
  };

  /** One undock handle at the left of each visible strip whose pane holds files */
  const syncHandles = () => {
    const rows = document.querySelectorAll(TABS_ROW_SELECTOR);
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      const scrollContainer = row.querySelector(TABS_SCROLL_SELECTOR)?.parentElement;
      let handle = row.querySelector(`[${HANDLE_ATTRIBUTE}]`);
      if (!scrollContainer || scrollContainer.parentElement !== row || paneFileIdentities(row).length === 0) {
        handle?.remove();
        continue;
      }
      if (!handle) handle = createHandle();
      if (handle.nextSibling !== scrollContainer) row.insertBefore(handle, scrollContainer);
      fitHandleGap(handle, row);
      const sample = row.querySelector(TAB_LABEL_SELECTOR);
      const color = sample ? window.getComputedStyle(sample).color : "";
      if (color && handle.style.color !== color) handle.style.setProperty("color", color);
    }
  };

  // The tab strip's drag keeps receiving pointer events after the pointer leaves the window
  const onPointerUp = (event: PointerEventLike) => {
    const current = press;
    press = null;
    markDrop(null, event.screenX, event.screenY);
    if (!current) return;
    if (ghost) {
      const { onDrop } = ghost;
      const popup = takeGhost();
      if (popup) onDrop(event.screenX, event.screenY, popup);
      return;
    }
    const moved = Math.hypot(event.clientX - current.x, event.clientY - current.y) >= DRAG_MIN_DISTANCE_PX;
    const outside =
      event.clientX < 0 || event.clientY < 0 || event.clientX > window.innerWidth || event.clientY > window.innerHeight;
    if (moved && outside) void tearOut(current.identities, event.screenX, event.screenY, null);
    // A click on the handle undocks the pane's files into a new window beside the pointer
    else if (!moved && current.handle) void tearOut(current.identities, event.screenX, event.screenY, null);
  };

  // Companions belong to this window: they close with it
  const closeCompanions = () => {
    for (const companion of [...companions.keys()]) {
      void companion.saveAll();
      forget(companion);
      if (!companion.popup.closed) companion.popup.close();
    }
  };

  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("pointermove", onPointerMove, true);
  window.addEventListener("pointerup", onPointerUp, true);
  window.addEventListener("beforeunload", closeCompanions);

  const stop = () => {
    window.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("pointermove", onPointerMove, true);
    window.removeEventListener("pointerup", onPointerUp, true);
    dropGhost();
    window.removeEventListener("beforeunload", closeCompanions);
    closeCompanions();
    const handles = document.querySelectorAll(`[${HANDLE_ATTRIBUTE}]`);
    for (let index = 0; index < handles.length; index++) handles[index].remove();
  };
  return { stop, sync: syncHandles };
}
