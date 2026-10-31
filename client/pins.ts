// Pinned file tabs: a fixed position in their pane's strip, a pin glyph on the chip, and no part
// in the pane's LRU limit. Pins are keyed by workspace and tab identity, which survives a tab
// moving between panes.
import { collectPanes, type LayoutState, tabIdentity } from "./layout";
import { restorePinnedOrder } from "./pin-order";

// Key from better-chat-management (formerly better-chat-display), kept so saved pins survive the move
const STORAGE_KEY = "better-chat-display:pins";
const SCROLL_SELECTOR = '[data-testid="workspace-tabs-scroll"]';
const CHIP_PREFIX = "workspace-tab-";
/** The chip label's text node (workspace-desktop-tabs-row.tsx TabHandleContent) */
const LABEL_SELECTOR = '[dir="auto"]';
const GLYPH_ATTRIBUTE = "data-editor-enhancements-pin-glyph";
const GLYPH_SIZE = 12;
// Lucide "pin"
const PIN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="${GLYPH_SIZE}" height="${GLYPH_SIZE}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>`;

export interface Pins {
  isPinned(workspaceKey: string, identity: string): boolean;
  /** Pins at the tab's current index in its pane, or unpins */
  toggle(state: LayoutState, workspaceKey: string, tabId: string): void;
  /** Restores pinned positions and draws glyphs on the selected workspaces' strips */
  sync(state: LayoutState, selectedWorkspaces: readonly string[]): void;
  stop(): void;
}

function pinKey(workspaceKey: string, identity: string): string {
  return `${workspaceKey}|${identity}`;
}

export function createPins(onChange: () => void): Pins {
  let pins: Record<string, number> = {};
  try {
    pins = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, number>;
  } catch {
    pins = {};
  }
  const save = () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(pins));
    } catch {
      // Storage disabled: pins last this session only
    }
  };

  const removeGlyphs = () => {
    const glyphs = document.querySelectorAll(`[${GLYPH_ATTRIBUTE}]`);
    for (let index = 0; index < glyphs.length; index++) glyphs[index].remove();
  };

  return {
    isPinned: (workspaceKey, identity) => pinKey(workspaceKey, identity) in pins,
    toggle(state, workspaceKey, tabId) {
      const layout = state.layoutByWorkspace[workspaceKey];
      if (!layout) return;
      for (const pane of collectPanes(layout.root)) {
        const tabs = pane.tabs ?? [];
        const index = tabs.findIndex((tab) => tab.tabId === tabId);
        if (index < 0) continue;
        const key = pinKey(workspaceKey, tabIdentity(tabs[index]));
        if (key in pins) delete pins[key];
        else pins[key] = index;
        save();
        onChange();
        return;
      }
    },
    sync(state, selectedWorkspaces) {
      const glyphIdentities = new Set<string>();
      for (const [workspaceKey, layout] of Object.entries(state.layoutByWorkspace)) {
        if (!layout) continue;
        for (const pane of collectPanes(layout.root)) {
          const tabs = pane.tabs ?? [];
          const pinnedIndexById = new Map<string, number>();
          for (const tab of tabs) {
            const index = pins[pinKey(workspaceKey, tabIdentity(tab))];
            if (index !== undefined) pinnedIndexById.set(tab.tabId, index);
          }
          if (pinnedIndexById.size === 0) continue;
          if (selectedWorkspaces.includes(workspaceKey)) {
            for (const tab of tabs) if (pinnedIndexById.has(tab.tabId)) glyphIdentities.add(tabIdentity(tab));
          }
          const current = tabs.map((tab) => tab.tabId);
          const restored = restorePinnedOrder(current, pinnedIndexById);
          if (restored.some((tabId, index) => tabId !== current[index])) {
            state.reorderTabsInPane(workspaceKey, pane.id, restored);
          }
        }
      }

      // Glyphs on the visible strips; the chip's first child is its icon-and-label row
      const chips = document.querySelectorAll(`${SCROLL_SELECTOR} [data-testid^="${CHIP_PREFIX}"]`);
      for (let index = 0; index < chips.length; index++) {
        const chip = chips[index];
        const identity = (chip.getAttribute("data-testid") ?? "").slice(CHIP_PREFIX.length);
        // The chip's first child is its handle row: icon, label, modified dot
        const handle = chip.firstElementChild;
        const icon = handle?.firstElementChild;
        if (!handle || !icon) continue;
        let glyph = handle.querySelector<HTMLElement>(`[${GLYPH_ATTRIBUTE}]`);
        if (!glyphIdentities.has(identity)) {
          glyph?.remove();
          continue;
        }
        if (!glyph) {
          glyph = document.createElement("span");
          glyph.setAttribute(GLYPH_ATTRIBUTE, "true");
          glyph.style.setProperty("display", "flex");
          glyph.style.setProperty("flex-shrink", "0");
          glyph.innerHTML = PIN_SVG;
        }
        // Beside the icon, so neither a truncated label nor the hover close button covers it
        if (icon.nextElementSibling !== glyph) icon.after(glyph);
        // The handle row sets no colour, so `currentColor` would be black; follow the label's,
        // which changes with the tab's highlight
        const label = handle.querySelector(LABEL_SELECTOR);
        const color = label ? getComputedStyle(label).color : "";
        if (color && glyph.style.color !== color) glyph.style.color = color;
      }
    },
    stop: removeGlyphs,
  };
}
