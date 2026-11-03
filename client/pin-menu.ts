// "Pin tab" / "Unpin tab" and "Open in file explorer" in a file tab's context menu. The menu is app
// UI (packages/app/src/screens/workspace/workspace-tab-menu.ts), so the entries are clones of its
// own "Copy file path" item, which keeps the menu's typography and spacing exactly.
import type { StoreApi } from "./fiber";
import { collectPanes, type LayoutState, tabIdentity } from "./layout";

/** Menu content carries `workspace-tab-context-<tabId>`; only file tabs offer "Copy file path" */
const MENU_PREFIX = "workspace-tab-context-";
const MENU_SELECTOR = `[data-testid^="${MENU_PREFIX}"]`;
const TEMPLATE_SELECTOR = '[data-testid$="-copy-file-path"]';
const ADDED_ATTRIBUTE = "data-editor-enhancements-pin-added";
const ITEM_ATTRIBUTE = "data-editor-enhancements-menu-item";
/** better-chat-management's split entries, which also follow the template; the pin goes after them */
const SPLIT_ITEM_ATTRIBUTE = "data-better-chat-menu-item";
const STYLE_OWNER = "editor-enhancements-pin-menu";
const STYLE_TEXT = [
  `[${ITEM_ATTRIBUTE}]{cursor:pointer}`,
  `[${ITEM_ATTRIBUTE}]:hover{background-color:color-mix(in srgb, currentColor 10%, transparent)}`,
].join("");
// Lucide "pin"
const PIN_ICON =
  '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>';
// Lucide "folder-open"
const FOLDER_ICON =
  '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>';

/** The deepest element holding the item's visible text */
function findLabel(item: Element): Element | null {
  let found: Element | null = null;
  const pending: Element[] = [item];
  while (pending.length > 0) {
    const element = pending.pop()!;
    if (element.querySelector("svg") === null && element.children.length === 0 && (element.textContent ?? "").trim()) {
      found = element;
    }
    for (const child of element.children) pending.push(child);
  }
  return found;
}

/** Where a tab lives and its identity, preferring the selected workspaces when tab ids repeat */
function locateTab(
  state: LayoutState,
  tabId: string,
  preferredWorkspaces: readonly string[],
): { workspaceKey: string; identity: string; path: string | null } | null {
  const keys = Object.keys(state.layoutByWorkspace).sort(
    (left, right) => Number(preferredWorkspaces.includes(right)) - Number(preferredWorkspaces.includes(left)),
  );
  for (const workspaceKey of keys) {
    const layout = state.layoutByWorkspace[workspaceKey];
    if (!layout) continue;
    for (const pane of collectPanes(layout.root)) {
      const tab = (pane.tabs ?? []).find((candidate) => candidate.tabId === tabId);
      if (tab) return { workspaceKey, identity: tabIdentity(tab), path: tab.target.path ?? null };
    }
  }
  return null;
}

/** Watches for file tab menus and adds the pin entry to each; returns the teardown */
export function installPinMenu(input: {
  layoutStore(): StoreApi<LayoutState> | null;
  selectedWorkspaces(): readonly string[];
  isPinned(workspaceKey: string, identity: string): boolean;
  togglePin(workspaceKey: string, tabId: string): void;
  /** Shows the file selected in its folder in the host's file browser */
  revealFile(workspaceKey: string, path: string): void;
}): () => void {
  const style = document.createElement("style");
  style.setAttribute("data-owner", STYLE_OWNER);
  style.textContent = STYLE_TEXT;
  document.head.appendChild(style);

  const decorate = (menu: Element, template: Element) => {
    if (!template.parentElement) return;
    menu.setAttribute(ADDED_ATTRIBUTE, "true");
    const tabId = (menu.getAttribute("data-testid") ?? "").slice(MENU_PREFIX.length);
    const store = input.layoutStore();
    const location = store ? locateTab(store.getState(), tabId, input.selectedWorkspaces()) : null;
    if (!location) return;
    const entry = (name: string, text: string, iconPaths: string, run: () => void) => {
      const item = template.cloneNode(true) as Element;
      item.removeAttribute("data-testid");
      item.setAttribute(ITEM_ATTRIBUTE, name);
      const label = findLabel(item);
      if (label) label.textContent = text;
      const icon = item.querySelector("svg");
      if (icon) icon.innerHTML = iconPaths;
      item.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        run();
      });
      return item;
    };
    const pinned = input.isPinned(location.workspaceKey, location.identity);
    const items = [entry("pin", pinned ? "Unpin tab" : "Pin tab", PIN_ICON, () => input.togglePin(location.workspaceKey, tabId))];
    const { path } = location;
    if (path) items.push(entry("reveal", "Open in file explorer", FOLDER_ICON, () => input.revealFile(location.workspaceKey, path)));
    // Splits added later are inserted right after the template, so they stay before these
    let anchor = template;
    while (anchor.nextElementSibling?.hasAttribute(SPLIT_ITEM_ATTRIBUTE)) anchor = anchor.nextElementSibling;
    anchor.after(...items);
  };

  const scan = () => {
    for (const menu of document.querySelectorAll(`${MENU_SELECTOR}:not([${ADDED_ATTRIBUTE}])`)) {
      // Non-file tab menus have no template and are skipped; items still rendering retry later
      const template = menu.querySelector(TEMPLATE_SELECTOR);
      if (template) decorate(menu, template);
    }
  };

  const observer = new MutationObserver(scan);
  observer.observe(document.body, { childList: true, subtree: true });
  scan();

  return () => {
    observer.disconnect();
    for (const item of document.querySelectorAll(`[${ITEM_ATTRIBUTE}]`)) item.remove();
    style.remove();
  };
}
