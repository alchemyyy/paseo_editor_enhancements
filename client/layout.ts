// NOTE: Mirrors the app's workspace layout store (packages/app/src/stores/workspace-layout-store.ts,
// workspace-layout-actions.ts) and tab identities (packages/app/src/workspace-tabs/identity.ts).
// App-internal, found through fiber.ts; may drift on a Paseo upgrade. Callers treat null as unavailable.
import { scanStores, type StoreApi } from "./fiber";

export interface TabTarget {
  kind: string;
  agentId?: string;
  draftId?: string;
  parentAgentId?: string;
  subagentId?: string;
  terminalId?: string;
  browserId?: string;
  workspaceId?: string;
  sha?: string;
  pluginId?: string;
  panelId?: string;
  context?: string;
  path?: string;
  /** A file target's line range (packages/app/src/workspace/file-open) */
  lineStart?: number;
  lineEnd?: number;
}

export interface LayoutTab {
  tabId: string;
  target: TabTarget;
}

export interface LayoutPane {
  id: string;
  focusedTabId: string | null;
  /** Present on the store's internal layout nodes */
  tabs?: LayoutTab[];
}

export type LayoutNode =
  | { kind: "pane"; pane: LayoutPane }
  | { kind: "group"; group: { children: LayoutNode[] } };

export interface WorkspaceLayout {
  root: LayoutNode;
  focusedPaneId: string | null;
}

export interface LayoutState {
  layoutByWorkspace: Record<string, WorkspaceLayout | undefined>;
  explorerSidebarPaneIdByWorkspace: Record<string, string | null | undefined>;
  openTab(input: { workspaceKey: string; target: TabTarget; intent: string }): string | null;
  closeTab(workspaceKey: string, tabId: string): void;
  reorderTabsInPane(workspaceKey: string, paneId: string, tabIds: string[]): void;
  focusTab(workspaceKey: string, tabId: string): void;
}

export function collectPanes(root: LayoutNode): LayoutPane[] {
  const panes: LayoutPane[] = [];
  const pending: LayoutNode[] = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.kind === "pane") panes.push(node.pane);
    else for (const child of node.group.children) pending.push(child);
  }
  return panes;
}

/** The suffix of the tab chip's `workspace-tab-<identity>` test id */
export function tabIdentity(tab: LayoutTab): string {
  const { target } = tab;
  switch (target.kind) {
    case "new_tab":
      return tab.tabId;
    case "draft":
      return target.draftId ?? tab.tabId;
    case "agent":
      return `agent_${target.agentId}`;
    case "provider_subagent": {
      const parent = target.parentAgentId ?? "";
      const subagent = target.subagentId ?? "";
      return `provider_subagent_${parent.length}_${parent}_${subagent.length}_${subagent}`;
    }
    case "terminal":
      return `terminal_${target.terminalId}`;
    case "browser":
      return `browser_${target.browserId}`;
    case "setup":
      return `setup_${target.workspaceId}`;
    case "commit_diff":
      return `commit_diff_${target.sha}`;
    case "working_diff":
      return "working_diff";
    case "changes_tree":
    case "files":
    case "pull_request":
      return target.kind;
    case "plugin": {
      const pluginId = target.pluginId ?? "";
      const panelId = target.panelId ?? "";
      const identity = `${pluginId.length}_${pluginId}_${panelId.length}_${panelId}`;
      if (target.context === "workspace") return `plugin_workspace_${identity}`;
      const agentId = target.agentId ?? "";
      return `plugin_agent_${identity}_${agentId.length}_${agentId}`;
    }
    default:
      return `file_${target.path}`;
  }
}

const MIN_SCAN_INTERVAL_MS = 1500;
let found: StoreApi<LayoutState> | null = null;
let lastScanAt = 0;

function isLayoutState(state: unknown): boolean {
  if (!state || typeof state !== "object") return false;
  const fields = state as Record<string, unknown>;
  return (
    typeof fields.layoutByWorkspace === "object" &&
    fields.layoutByWorkspace !== null &&
    typeof fields.openTab === "function" &&
    typeof fields.focusTab === "function" &&
    typeof fields.convertDraftToAgent === "function"
  );
}

/** The layout store, scanning for it at most every 1.5 s because a scan walks every fiber */
export function layoutStore(): StoreApi<LayoutState> | null {
  if (found) return found;
  const now = Date.now();
  if (now - lastScanAt < MIN_SCAN_INTERVAL_MS) return null;
  lastScanAt = now;
  const container = document.getElementById("root");
  if (!container) return null;
  scanStores(container, (store) => {
    if (!isLayoutState(store.getState())) return false;
    found = store as StoreApi<LayoutState>;
    return true;
  });
  return found;
}
