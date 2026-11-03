// Tab strip and Source editor features for the whole window: pinned tabs, the per-pane LRU limit,
// gutter line references, and tearing file tabs out into companion windows. Re-syncs on layout
// store changes and DOM changes, since the strips and editors render as app UI.
import { companionPreviewFactory } from "./companion-preview";
import { findAncestorProps, type StoreApi } from "./fiber";
import type { GfmEngine } from "./gfm-engine";
import { installGutterSelection } from "./gutter-select";
import { backendFor, type HostRegistry } from "./hosts";
import { layoutStore, type LayoutState, type TabTarget } from "./layout";
import { createPaneLru } from "./pane-lru";
import { installPinMenu } from "./pin-menu";
import { createPins } from "./pins";
import { installTearOut } from "./tear-out";

const SYNC_DELAY_MS = 60;
const ROW_TEST_ID_PREFIX = "sidebar-workspace-row-";
const ROW_SELECTOR = `[data-testid^="${ROW_TEST_ID_PREFIX}"]`;

/** The sidebar's workspace row for a key, preferring the project list over the pinned copy */
function findWorkspaceRow(workspaceKey: string): Element | null {
  let found: Element | null = null;
  for (const row of document.querySelectorAll(ROW_SELECTOR)) {
    if (row.getAttribute("data-testid")?.slice(ROW_TEST_ID_PREFIX.length) === workspaceKey) found = row;
  }
  return found;
}

export function startEditorTabs(registry: HostRegistry, engine: GfmEngine): () => void {
  let store: StoreApi<LayoutState> | null = null;
  let releaseStore: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  /** Workspace keys selected in the sidebar */
  let selected: readonly string[] = [];

  const schedule = () => {
    if (stopped || timer) return;
    timer = setTimeout(sync, SYNC_DELAY_MS);
  };

  const attachStore = (): StoreApi<LayoutState> | null => {
    const next = layoutStore();
    if (next && next !== store) {
      releaseStore?.();
      store = next;
      releaseStore = next.subscribe(schedule);
    }
    return store;
  };

  const readSelected = () => {
    const rows = document.querySelectorAll(ROW_SELECTOR);
    const keys = new Set<string>();
    for (const row of rows) {
      if (row.getAttribute("aria-selected") !== "true") continue;
      keys.add((row.getAttribute("data-testid") ?? "").slice(ROW_TEST_ID_PREFIX.length));
    }
    // A collapsed sidebar shows no rows; keep the workspace that was selected
    if (keys.size > 0 || rows.length > 0) selected = [...keys];
  };

  /** Shows a tab target in a workspace, pressing its sidebar row first when it is not selected */
  const openTarget = (serverId: string, workspaceId: string, target: TabTarget): boolean => {
    const current = attachStore();
    if (!current) return false;
    const workspaceKey = `${serverId}:${workspaceId}`;
    if (!selected.includes(workspaceKey)) {
      const row = findWorkspaceRow(workspaceKey);
      const testId = `${ROW_TEST_ID_PREFIX}${workspaceKey}`;
      const props = row
        ? findAncestorProps(row, (candidate) => candidate.testID === testId && typeof candidate.onPress === "function")
        : null;
      if (!props) return false;
      (props.onPress as () => void)();
    }
    const tabId = current.getState().openTab({ workspaceKey, target, intent: "reveal" });
    if (tabId) current.getState().focusTab(workspaceKey, tabId);
    schedule();
    return true;
  };

  const backend = async (workspaceId: string) => {
    const found = await backendFor(registry, workspaceId);
    if (!found) throw new Error("No connected host has this workspace");
    return found;
  };

  const pins = createPins(schedule);
  const paneLru = createPaneLru(schedule, pins.isPinned);
  const tearOut = installTearOut({
    layoutStore: attachStore,
    selectedWorkspaces: () => selected,
    openTarget,
    readFile: async (workspaceId, path) => (await backend(workspaceId)).readFile({ workspaceId, path }),
    writeFile: async (workspaceId, path, content, expectedHash) =>
      (await backend(workspaceId)).writeFile({ workspaceId, path, content, expectedHash }),
    // Links in a companion's Markdown preview open in the main window
    previews: companionPreviewFactory(registry, engine, (file, lineStart, lineEnd) =>
      openTarget(file.serverId, file.workspaceId, { kind: "file", path: file.path, lineStart, lineEnd }),
    ),
  });
  const releaseGutter = installGutterSelection();
  const releasePinMenu = installPinMenu({
    layoutStore: attachStore,
    selectedWorkspaces: () => selected,
    isPinned: pins.isPinned,
    togglePin: (workspaceKey, tabId) => {
      const current = attachStore();
      if (current) pins.toggle(current.getState(), workspaceKey, tabId);
    },
    revealFile: (workspaceKey, path) => {
      const workspaceId = workspaceKey.slice(workspaceKey.indexOf(":") + 1);
      void backend(workspaceId)
        .then((host) => host.revealFile({ workspaceId, path }))
        .catch((error: unknown) => console.warn("[editor-enhancements] Could not open the file explorer", error));
    },
  });
  registry.isTabPinned = pins.isPinned;

  function sync(): void {
    timer = null;
    if (stopped) return;
    readSelected();
    const current = attachStore();
    if (!current) return;
    const state = current.getState();
    pins.sync(state, selected);
    tearOut.sync();
    paneLru.sync(state, selected);
  }

  // Tab strips mount and change as DOM; selection shows as the rows' aria-selected
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-selected"] });
  schedule();

  return () => {
    stopped = true;
    clearTimeout(timer ?? undefined);
    observer.disconnect();
    releaseStore?.();
    if (registry.isTabPinned === pins.isPinned) registry.isTabPinned = null;
    releasePinMenu();
    releaseGutter();
    paneLru.stop();
    pins.stop();
    tearOut.stop();
  };
}
