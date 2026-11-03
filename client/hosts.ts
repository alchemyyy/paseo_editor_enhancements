// Paseo runs a plugin's client code once per connected host, but every host's file panels and
// tab strips share one window. The instances meet in a window-global registry: the first one
// augments the window, and each daemon call goes to the instance whose host owns its workspace.

export interface ReferenceRequest {
  workspaceId: string;
  markdownPath: string;
  reference: string;
}

export interface FileRequest {
  workspaceId: string;
  /** Workspace-relative or absolute */
  path: string;
}

export interface FileContent {
  absolutePath: string;
  content: string;
  size: number;
  hash: string;
  truncated: boolean;
}

export type SaveResult = { status: "saved"; size: number; hash: string } | { status: "conflict"; hash: string };

/** One plugin instance: the daemon calls of its host */
export interface HostBackend {
  /** Whether this host has the workspace */
  ownsWorkspace(workspaceId: string): Promise<boolean>;
  readImage(request: ReferenceRequest): Promise<{ mimeType: string; base64: string }>;
  /** A local file an HTML page references, relative to the page (`markdownPath`) */
  readResource(request: ReferenceRequest): Promise<{ mimeType: string; base64: string }>;
  resolveLink(request: ReferenceRequest): Promise<{ path: string | null; kind: "file" | "directory" | null }>;
  openExternal(url: string): Promise<void>;
  /** Shows a file selected in its folder in the host's file browser */
  revealFile(request: FileRequest): Promise<unknown>;
  readFile(request: FileRequest): Promise<FileContent>;
  writeFile(request: FileRequest & { content: string; expectedHash: string }): Promise<SaveResult>;
  /** Starts this instance's augmentation over the registry; returns its stop function */
  start(registry: HostRegistry): () => void;
}

export interface HostRegistry {
  readonly backends: HostBackend[];
  owner: HostBackend | null;
  stop: (() => void) | null;
  /**
   * Whether a tab is pinned, set while the augmentation runs. Cross-plugin contract: better-chat-
   * management's close-left/right/others reads it here to skip pinned tabs.
   */
  isTabPinned?: ((workspaceKey: string, identity: string) => boolean) | null;
}

const GLOBAL_KEY = "__paseoEditorEnhancements";

function registry(): HostRegistry {
  const scope = globalThis as unknown as Record<string, HostRegistry | undefined>;
  scope[GLOBAL_KEY] ??= { backends: [], owner: null, stop: null, isTabPinned: null };
  return scope[GLOBAL_KEY];
}

/** Adds a plugin instance; returns its removal. The first instance runs the augmentation. */
export function registerHost(backend: HostBackend): () => void {
  const shared = registry();
  shared.backends.push(backend);
  if (!shared.owner) {
    shared.owner = backend;
    shared.stop = backend.start(shared);
  }
  return () => {
    const index = shared.backends.indexOf(backend);
    if (index !== -1) shared.backends.splice(index, 1);
    if (shared.owner !== backend) return;
    shared.stop?.();
    // Hand the augmentation to a remaining instance, which runs its own (possibly newer) code
    shared.owner = shared.backends[0] ?? null;
    shared.stop = shared.owner ? shared.owner.start(shared) : null;
  };
}

/** The instance whose host has `workspaceId`; the only instance when there is one */
export async function backendFor(shared: HostRegistry, workspaceId: string): Promise<HostBackend | null> {
  if (shared.backends.length <= 1) return shared.backends[0] ?? null;
  for (const backend of shared.backends) {
    if (await backend.ownsWorkspace(workspaceId).catch(() => false)) return backend;
  }
  return null;
}
