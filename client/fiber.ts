// NOTE: The plugin SDK cannot extend Paseo's built-in file panels or tab strips. These helpers
// read the React fibers behind their DOM (packages/app/src/file-panels: builtin.tsx,
// source/panel.tsx, source/toolbar.tsx; panels/pane-context.tsx) and find the app's zustand
// stores. App-internal: a Paseo update may break them, and callers treat a missing piece as
// "leave it alone".

interface Hook {
  memoizedState: unknown;
  next: Hook | null;
}

interface Fiber {
  return: Fiber | null;
  child?: Fiber | null;
  sibling?: Fiber | null;
  memoizedProps?: Record<string, unknown> | null;
  memoizedState?: Hook | null;
  stateNode?: { current?: Fiber } | null;
}

interface DomNode {
  parentElement?: DomNode | null;
}

export interface StoreApi<State> {
  getState(): State;
  setState(partial: Partial<State>): void;
  subscribe(listener: () => void): () => void;
}

export type TextFileView = "preview" | "source";

/** The editor buffer the Markdown panel edits: FileEditorModel (source/editor/model.ts) */
export interface EditorModel {
  subscribe(listener: () => void): () => void;
  getSnapshot(): { content: string; status: string; lineSeparator: string };
  /** Replaces the buffer, which then autosaves */
  edit(content: string): void;
  save(): Promise<void>;
}

/** The panel's file handle: PluginFile from the plugin SDK */
export interface PanelFile {
  readText(): Promise<string>;
  watch(listener: (event: { type: string }) => void): () => void;
}

export interface MarkdownPanelInfo {
  path: string;
  workspaceId: string;
  serverId: string;
  file: PanelFile;
  /** The buffer of the editable panel (web, up to 1 MiB); null for read-only panels */
  model: EditorModel | null;
}

/** Sets the toolbar's Preview|Source view: TextFileToolbar's onViewChange, a stable state setter */
export type SetView = (view: TextFileView) => void;

/** PaneContext value subset (panels/pane-context.tsx): the pane's tab, and opening linked files */
export interface PaneBridge {
  serverId: string;
  workspaceId: string;
  tabId: string;
  target: { kind: string; path?: string; agentId?: string; draftId?: string };
  openFileInWorkspace(request: {
    location: { path: string; lineStart?: number; lineEnd?: number };
    disposition: "main" | "preferred" | "side";
  }): void;
}

const FIBER_KEY_PREFIX = "__reactFiber$";
const CONTAINER_KEY_PREFIX = "__reactContainer$";
/** Fibers between the toolbar and the built-in panel view that renders it */
const MAX_PANEL_DEPTH = 40;
/** Fibers between the toolbar and the pane that hosts the panel */
const MAX_PANE_DEPTH = 400;
/** Editors such as CodeMirror build their own DOM; climb to the nearest React-owned node */
const MAX_DOM_CLIMB = 40;
const MAX_HOOKS_PER_FIBER = 200;
const MAX_ANCESTOR_DEPTH = 60;

function fiberOf(node: object, prefix = FIBER_KEY_PREFIX): Fiber | null {
  const record = node as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key.startsWith(prefix)) return record[key] as Fiber;
  }
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function* ancestors(node: object, maxDepth: number): Generator<Fiber> {
  let element: DomNode | null = node as DomNode;
  let fiber: Fiber | null = null;
  for (let climb = 0; element && climb < MAX_DOM_CLIMB && !fiber; climb++) {
    fiber = fiberOf(element);
    if (!fiber) element = element.parentElement ?? null;
  }
  for (let depth = 0; fiber && depth < maxDepth; depth++, fiber = fiber.return) yield fiber;
}

function isEditorModel(value: unknown): value is EditorModel {
  return (
    isObject(value) &&
    typeof value.subscribe === "function" &&
    typeof value.getSnapshot === "function" &&
    typeof value.edit === "function" &&
    typeof value.save === "function"
  );
}

function isPanelFile(value: unknown): value is PanelFile {
  return isObject(value) && typeof value.readText === "function" && typeof value.watch === "function";
}

/** The FileEditorModel a text file panel holds in its first useState */
function editorModelOf(fiber: Fiber): EditorModel | null {
  for (let hook = fiber.memoizedState ?? null; hook; hook = hook.next) {
    if (isEditorModel(hook.memoizedState)) return hook.memoizedState;
  }
  return null;
}

/**
 * The built-in Markdown panel above a `file-panel-bar` toolbar, or null for every other panel
 * (Source, HTML, plugin panels) and for anything unrecognizable.
 */
export function findMarkdownPanel(bar: object): MarkdownPanelInfo | null {
  let model: EditorModel | null = null;
  for (const fiber of ancestors(bar, MAX_PANEL_DEPTH)) {
    const props = fiber.memoizedProps;
    if (!props) continue;
    // TextFilePanel's editable variant: props { file, params, preview, ... } and the model in state
    if (!model && "preview" in props && isPanelFile(props.file)) model = editorModelOf(fiber);
    // BuiltinFilePanelView: props { panel: { id }, file, params, workspaceId, host }
    const panel = props.panel;
    if (!isObject(panel) || typeof panel.id !== "string") continue;
    if (panel.id !== "builtin:markdown") return null;
    const { file, params, workspaceId, host } = props;
    if (!isPanelFile(file) || !isObject(params) || typeof params.path !== "string") return null;
    if (typeof workspaceId !== "string" || !isObject(host) || typeof host.id !== "string") return null;
    return { path: params.path, workspaceId, serverId: host.id, file, model };
  }
  return null;
}

/**
 * The toolbar's view setter. Only the setter is read from the fiber: a DOM node's fiber can be the
 * stale alternate, whose props lag, but a state setter never changes. The view itself is read
 * from the Preview|Source control's DOM.
 */
export function findSetView(bar: object): SetView | null {
  for (const fiber of ancestors(bar, MAX_PANEL_DEPTH)) {
    const props = fiber.memoizedProps;
    if (props && typeof props.onViewChange === "function") return props.onViewChange as SetView;
  }
  return null;
}

/** The PaneContext value of the pane holding `node`, or null */
export function findPaneBridge(node: object): PaneBridge | null {
  for (const fiber of ancestors(node, MAX_PANE_DEPTH)) {
    const value = fiber.memoizedProps?.value;
    if (
      isObject(value) &&
      typeof value.openFileInWorkspace === "function" &&
      typeof value.tabId === "string" &&
      typeof value.workspaceId === "string" &&
      isObject(value.target)
    ) {
      return value as unknown as PaneBridge;
    }
  }
  return null;
}

/** The nearest component props above a host node that satisfy `accept`, or null */
export function findAncestorProps(
  node: object,
  accept: (props: Record<string, unknown>) => boolean,
): Record<string, unknown> | null {
  for (const fiber of ancestors(node, MAX_ANCESTOR_DEPTH)) {
    const props = fiber.memoizedProps;
    if (props && typeof props === "object" && accept(props)) return props;
  }
  return null;
}

function isStoreApi(value: unknown): value is StoreApi<unknown> {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.getState === "function" &&
    typeof candidate.setState === "function" &&
    typeof candidate.subscribe === "function"
  );
}

/**
 * Walks every fiber under a React root container and offers each zustand store held in hook
 * deps to `visit`. zustand 5 `useStore` keeps `useCallback(..., [api, selector])`, so any mounted
 * component that subscribes to a store exposes the store API there. Stop by returning true.
 */
export function scanStores(rootContainer: object, visit: (store: StoreApi<unknown>) => boolean): void {
  const containerFiber = fiberOf(rootContainer, CONTAINER_KEY_PREFIX);
  if (!containerFiber) return;
  // The container keeps the first HostRoot fiber; the FiberRoot knows the committed one
  const root = containerFiber.stateNode?.current ?? containerFiber;
  const seen = new Set<unknown>();
  const pending: Fiber[] = [root];
  while (pending.length > 0) {
    const fiber = pending.pop()!;
    if (fiber.sibling) pending.push(fiber.sibling);
    if (fiber.child) pending.push(fiber.child);
    let hook = (fiber.memoizedState ?? null) as Hook | null;
    for (let index = 0; hook && typeof hook === "object" && index < MAX_HOOKS_PER_FIBER; index++) {
      const memoized = hook.memoizedState;
      // useCallback/useMemo store [value, deps]
      if (Array.isArray(memoized) && memoized.length === 2 && Array.isArray(memoized[1])) {
        for (const dependency of memoized[1] as unknown[]) {
          if (seen.has(dependency) || !isStoreApi(dependency)) continue;
          seen.add(dependency);
          if (visit(dependency)) return;
        }
      }
      hook = hook.next ?? null;
    }
  }
}
