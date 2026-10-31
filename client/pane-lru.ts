// Per-pane "LRU" limit: a number box in a file pane's tab strip (workspace-desktop-tabs-row.tsx)
// and the bookkeeping that closes the least recently focused file tabs past it.
import { collectPanes, type LayoutState, tabIdentity } from "./layout";
import { parseLimit, selectEvictions } from "./lru";

// Narrow structural types for what this module touches; they shadow lib.dom's in this module.
interface ControlElement {
  readonly parentElement: ControlElement | null;
  readonly nextSibling: ControlElement | null;
  readonly isConnected: boolean;
  textContent: string | null;
  value: string;
  type: string;
  readonly style: { setProperty(name: string, value: string): void; color: string };
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  querySelector(selector: string): ControlElement | null;
  querySelectorAll(selector: string): ArrayLike<ControlElement>;
  insertBefore(node: ControlElement, reference: ControlElement | null): void;
  appendChild(node: ControlElement): void;
  addEventListener(
    type: string,
    listener: (event: { stopPropagation(): void }) => void,
    options?: { passive: boolean },
  ): void;
  remove(): void;
}
declare const document: {
  activeElement: ControlElement | null;
  createElement(tag: string): ControlElement;
  querySelectorAll(selector: string): ArrayLike<ControlElement>;
};
declare const window: { getComputedStyle(element: ControlElement): { color: string } };
declare const localStorage: { getItem(key: string): string | null; setItem(key: string, value: string): void };

const ROW_SELECTOR = '[data-testid="workspace-tabs-row"]';
const SCROLL_SELECTOR = '[data-testid="workspace-tabs-scroll"]';
const CHIP_PREFIX = "workspace-tab-";
const MODIFIED_PREFIX = "workspace-tab-modified-";
const LABEL_TEXT_SELECTOR = `${SCROLL_SELECTOR} [dir="auto"]`;
const CONTROL_ATTRIBUTE = "data-editor-enhancements-lru";
// Key from better-chat-management (formerly better-chat-display), kept so saved limits survive the move
const STORAGE_KEY = "better-chat-display:lru";
const MAX_LIMIT = 99;
/** A mouse notch reports about 100px; trackpads report many small deltas */
const MOUSE_NOTCH_MIN_DELTA = 50;
/** Five notches of travel per step: a fifth of the mouse's sensitivity */
const TRACKPAD_STEP_DELTA = 500;
const CONTROL_STYLE: Record<string, string> = {
  display: "flex",
  "align-items": "center",
  gap: "4px",
  margin: "0 6px",
  "font-size": "11px",
  "flex-shrink": "0",
  // Electron's titlebar drag region would otherwise swallow clicks on the box
  "-webkit-app-region": "no-drag",
};
// Sizes are the previous box's outer size (46px by about 17.5px): 25% narrower, 20% taller
const INPUT_STYLE: Record<string, string> = {
  "box-sizing": "border-box",
  width: "35px",
  height: "21px",
  padding: "0 3px",
  "font-size": "11px",
  "font-family": "inherit",
  color: "inherit",
  "text-align": "center",
  background: "transparent",
  border: "1px solid color-mix(in srgb, currentColor 30%, transparent)",
  "border-radius": "4px",
  outline: "none",
};

function applyStyle(element: ControlElement, style: Record<string, string>): void {
  for (const [name, value] of Object.entries(style)) element.style.setProperty(name, value);
}

function loadLimits(): Record<string, number> {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    const limits: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "number" && value > 0) limits[key] = value;
    }
    return limits;
  } catch {
    return {};
  }
}

export interface PaneLru {
  /** Places controls on the selected workspaces' file panes and enforces their limits */
  sync(state: LayoutState, selectedWorkspaces: readonly string[]): void;
  stop(): void;
}

/** Pinned tabs neither count toward a pane's limit nor get closed by it */
export function createPaneLru(
  onLimitChange: () => void,
  isPinned: (workspaceKey: string, identity: string) => boolean,
): PaneLru {
  const limits = loadLimits();
  /** `<workspaceKey>|<tabId>` -> last focus time */
  const lastUsed = new Map<string, number>();
  /** `<workspaceKey>|<paneId>` -> the tab focused at the last sync */
  const lastFocused = new Map<string, string | null>();

  const saveLimit = (paneKey: string, limit: number) => {
    if (limit > 0) limits[paneKey] = limit;
    else delete limits[paneKey];
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(limits));
    } catch {
      // Storage disabled: the limit lasts this session only
    }
  };

  const createControl = (paneKey: string, row: ControlElement): ControlElement => {
    const control = document.createElement("label");
    control.setAttribute(CONTROL_ATTRIBUTE, paneKey);
    applyStyle(control, CONTROL_STYLE);
    const label = document.createElement("span");
    label.textContent = "LRU";
    const input = document.createElement("input");
    // Text with a numeric keyboard rather than type="number", which draws spinner buttons
    input.type = "text";
    input.setAttribute("inputmode", "numeric");
    input.setAttribute("maxlength", String(String(MAX_LIMIT).length));
    input.setAttribute("title", "Least-recently-used tab limit for this pane (0 = off)");
    applyStyle(input, INPUT_STYLE);
    const commit = () => {
      const key = control.getAttribute(CONTROL_ATTRIBUTE) ?? paneKey;
      const limit = parseLimit(input.value, MAX_LIMIT);
      saveLimit(key, limit);
      onLimitChange();
    };
    input.addEventListener("input", commit);
    input.addEventListener("change", () => {
      commit();
      input.value = String(parseLimit(input.value, MAX_LIMIT));
    });
    // Typing digits must not reach the app's keyboard shortcuts
    input.addEventListener("keydown", (event) => event.stopPropagation());
    // The wheel steps the limit like a number field's spinner: one per mouse notch, and one per
    // five notches' worth of trackpad travel, whose many small deltas would otherwise race
    let trackpadTravel = 0;
    input.addEventListener(
      "wheel",
      (event) => {
        const wheel = event as unknown as { deltaY: number; deltaMode: number; preventDefault(): void };
        if (wheel.deltaY === 0) return;
        wheel.preventDefault();
        const isMouseNotch = wheel.deltaMode !== 0 || Math.abs(wheel.deltaY) >= MOUSE_NOTCH_MIN_DELTA;
        if (!isMouseNotch) {
          if (Math.sign(trackpadTravel) !== Math.sign(wheel.deltaY)) trackpadTravel = 0;
          trackpadTravel += wheel.deltaY;
          if (Math.abs(trackpadTravel) < TRACKPAD_STEP_DELTA) return;
          trackpadTravel = 0;
        }
        const step = wheel.deltaY < 0 ? 1 : -1;
        input.value = String(Math.min(MAX_LIMIT, Math.max(0, parseLimit(input.value, MAX_LIMIT) + step)));
        commit();
      },
      { passive: false },
    );
    control.appendChild(label);
    control.appendChild(input);
    // Match the tab labels' text colour
    const sample = row.querySelector(LABEL_TEXT_SELECTOR);
    if (sample) control.style.color = window.getComputedStyle(sample).color;
    return control;
  };

  const placeControl = (row: ControlElement, paneKey: string): ControlElement | null => {
    const scrollContainer = row.querySelector(SCROLL_SELECTOR)?.parentElement;
    if (!scrollContainer || scrollContainer.parentElement !== row) return null;
    let control = row.querySelector(`[${CONTROL_ATTRIBUTE}]`);
    if (!control) control = createControl(paneKey, row);
    control.setAttribute(CONTROL_ATTRIBUTE, paneKey);
    if (control.parentElement !== row || scrollContainer.nextSibling !== control) {
      row.insertBefore(control, scrollContainer.nextSibling);
    }
    const input = control.querySelector("input");
    // Leave the box alone while it is being edited
    if (input && document.activeElement !== input) input.value = String(limits[paneKey] ?? 0);
    return control;
  };

  return {
    sync(state, selectedWorkspaces) {
      const now = Date.now();
      // Focus bookkeeping for every pane, so a pane's history exists before its limit is set
      for (const [workspaceKey, layout] of Object.entries(state.layoutByWorkspace)) {
        if (!layout) continue;
        for (const pane of collectPanes(layout.root)) {
          const paneKey = `${workspaceKey}|${pane.id}`;
          if (lastFocused.get(paneKey) !== pane.focusedTabId) {
            lastFocused.set(paneKey, pane.focusedTabId);
            if (pane.focusedTabId) lastUsed.set(`${workspaceKey}|${pane.focusedTabId}`, now);
          }
        }
      }

      const live = new Set<ControlElement>();
      const rows = document.querySelectorAll(ROW_SELECTOR);
      for (const workspaceKey of selectedWorkspaces) {
        const layout = state.layoutByWorkspace[workspaceKey];
        if (!layout) continue;
        const explorerPaneId = state.explorerSidebarPaneIdByWorkspace[workspaceKey] ?? null;
        const panes = collectPanes(layout.root).filter((pane) => pane.id !== explorerPaneId);
        const paneByIdentity = new Map<string, (typeof panes)[number]>();
        for (const pane of panes) for (const tab of pane.tabs ?? []) paneByIdentity.set(tabIdentity(tab), pane);

        for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
          const row = rows[rowIndex];
          const chips = row.querySelectorAll(`${SCROLL_SELECTOR} [data-testid^="${CHIP_PREFIX}"]`);
          let pane: (typeof panes)[number] | undefined;
          const modified = new Set<string>();
          for (let index = 0; index < chips.length; index++) {
            const testId = chips[index].getAttribute("data-testid") ?? "";
            if (testId.startsWith(MODIFIED_PREFIX)) modified.add(testId.slice(MODIFIED_PREFIX.length));
            pane ??= paneByIdentity.get(testId.slice(CHIP_PREFIX.length));
          }
          const tabs = pane?.tabs ?? [];
          if (!pane || !tabs.some((tab) => tab.target.kind === "file")) continue;
          const paneKey = `${workspaceKey}|${pane.id}`;
          const control = placeControl(row, paneKey);
          if (control) live.add(control);

          const limit = limits[paneKey] ?? 0;
          if (limit <= 0) continue;
          const protectedTabIds = new Set(
            tabs.filter((tab) => modified.has(tabIdentity(tab))).map((tab) => tab.tabId),
          );
          const evictions = selectEvictions(
            tabs.map((tab, index) => ({
              tabId: tab.tabId,
              isFile: tab.target.kind === "file" && !isPinned(workspaceKey, tabIdentity(tab)),
              // Never-focused tabs keep strip order, oldest first
              lastUsed: lastUsed.get(`${workspaceKey}|${tab.tabId}`) ?? index - tabs.length,
            })),
            limit,
            pane.focusedTabId,
            protectedTabIds,
          );
          for (const tabId of evictions) state.closeTab(workspaceKey, tabId);
        }
      }

      const controls = document.querySelectorAll(`[${CONTROL_ATTRIBUTE}]`);
      for (let index = 0; index < controls.length; index++) {
        if (!live.has(controls[index])) controls[index].remove();
      }
    },
    stop() {
      const controls = document.querySelectorAll(`[${CONTROL_ATTRIBUTE}]`);
      for (let index = 0; index < controls.length; index++) controls[index].remove();
    },
  };
}
