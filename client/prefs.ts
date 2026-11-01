// The preferences of the files with a Preview, device-wide in localStorage: Markdown's rendering
// engine and color palette, whether Markdown files and HTML files open in Split and whether their
// Split's preview follows the editor's scroll, and the Split divider's position, which both share.
import type { Layout } from "./controls.ts";
import type { PanelKind } from "./fiber.ts";
import { type EngineId, isEngineId, isPaletteId, type PaletteId } from "./palettes.ts";

export interface PreviewPrefs {
  engine: EngineId;
  /** The GitHub engine's colors; the Paseo engine always shows Paseo's theme */
  palette: PaletteId;
  /** Markdown files open side by side; set by choosing Split, cleared by choosing Preview or Source */
  openInSplit: boolean;
  /** The same for HTML files, chosen on an HTML file */
  htmlOpenInSplit: boolean;
  /** A Markdown Split's preview follows the editor's scroll */
  syncScroll: boolean;
  /** The same for HTML; a page's own scroll stays put unless asked */
  htmlSyncScroll: boolean;
  /** HTML pages may load from the web and load the local files they reference */
  htmlResources: boolean;
  /** The source editor's share of a Split, 0.2 to 0.8 */
  splitRatio: number;
}

const STORAGE_KEY = "paseo-markdown-enhancements:prefs";
export const MIN_SPLIT_RATIO = 0.2;
export const MAX_SPLIT_RATIO = 0.8;

export const DEFAULT_PREFS: PreviewPrefs = {
  engine: "paseo",
  palette: "github",
  openInSplit: false,
  htmlOpenInSplit: false,
  syncScroll: true,
  htmlSyncScroll: false,
  htmlResources: false,
  splitRatio: 0.5,
};

/** Whether files of `kind` open in Split */
export function opensInSplit(prefs: PreviewPrefs, kind: PanelKind): boolean {
  return kind === "html" ? prefs.htmlOpenInSplit : prefs.openInSplit;
}

/** What choosing `layout` on a file of `kind` remembers: whether that kind opens in Split */
export function splitChoice(kind: PanelKind, layout: Layout): Partial<PreviewPrefs> {
  const split = layout === "split";
  return kind === "html" ? { htmlOpenInSplit: split } : { openInSplit: split };
}

/** Whether a Split of files of `kind` follows the editor's scroll */
export function syncsScroll(prefs: PreviewPrefs, kind: PanelKind): boolean {
  return kind === "html" ? prefs.htmlSyncScroll : prefs.syncScroll;
}

/** What turning scroll sync on or off for files of `kind` remembers */
export function syncChoice(kind: PanelKind, on: boolean): Partial<PreviewPrefs> {
  return kind === "html" ? { htmlSyncScroll: on } : { syncScroll: on };
}

export function clampSplitRatio(ratio: number): number {
  return Number.isFinite(ratio) ? Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio)) : DEFAULT_PREFS.splitRatio;
}

/**
 * Engine and palette from the earlier single theme setting: the Paseo theme was Paseo's preview;
 * GitHub and Taiga Oak were the plugin's renderer in their colors, or in Paseo's with "Paseo colors"
 */
function fromTheme(theme: unknown, inheritColors: unknown): Pick<PreviewPrefs, "engine" | "palette"> | null {
  if (theme === "paseo") return { engine: "paseo", palette: DEFAULT_PREFS.palette };
  if (theme !== "github" && theme !== "taiga-oak") return null;
  return { engine: "github", palette: inheritColors === true ? "paseo" : theme };
}

/** Stored preferences over the defaults; unknown or malformed fields fall back to the default */
export function parsePrefs(text: string | null): PreviewPrefs {
  let stored: Record<string, unknown> = {};
  try {
    const value: unknown = text ? JSON.parse(text) : null;
    if (value && typeof value === "object" && !Array.isArray(value)) stored = value as Record<string, unknown>;
  } catch {
    // Corrupt storage reads as defaults
  }
  const migrated = isEngineId(stored.engine) ? null : fromTheme(stored.theme, stored.inheritColors);
  return {
    engine: isEngineId(stored.engine) ? stored.engine : (migrated?.engine ?? DEFAULT_PREFS.engine),
    palette: isPaletteId(stored.palette) ? stored.palette : (migrated?.palette ?? DEFAULT_PREFS.palette),
    openInSplit: typeof stored.openInSplit === "boolean" ? stored.openInSplit : DEFAULT_PREFS.openInSplit,
    htmlOpenInSplit: typeof stored.htmlOpenInSplit === "boolean" ? stored.htmlOpenInSplit : DEFAULT_PREFS.htmlOpenInSplit,
    syncScroll: typeof stored.syncScroll === "boolean" ? stored.syncScroll : DEFAULT_PREFS.syncScroll,
    htmlSyncScroll: typeof stored.htmlSyncScroll === "boolean" ? stored.htmlSyncScroll : DEFAULT_PREFS.htmlSyncScroll,
    htmlResources: typeof stored.htmlResources === "boolean" ? stored.htmlResources : DEFAULT_PREFS.htmlResources,
    splitRatio: typeof stored.splitRatio === "number" ? clampSplitRatio(stored.splitRatio) : DEFAULT_PREFS.splitRatio,
  };
}

interface Storage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export class PrefsStore {
  private prefs: PreviewPrefs;
  private readonly storage: Storage | null;
  private readonly listeners = new Set<() => void>();

  constructor(storage: Storage | null) {
    this.storage = storage;
    this.prefs = parsePrefs(storage?.getItem(STORAGE_KEY) ?? null);
  }

  get(): PreviewPrefs {
    return this.prefs;
  }

  update(patch: Partial<PreviewPrefs>): void {
    const next = { ...this.prefs, ...patch };
    next.splitRatio = clampSplitRatio(next.splitRatio);
    if (
      next.engine === this.prefs.engine &&
      next.palette === this.prefs.palette &&
      next.openInSplit === this.prefs.openInSplit &&
      next.htmlOpenInSplit === this.prefs.htmlOpenInSplit &&
      next.syncScroll === this.prefs.syncScroll &&
      next.htmlSyncScroll === this.prefs.htmlSyncScroll &&
      next.htmlResources === this.prefs.htmlResources &&
      next.splitRatio === this.prefs.splitRatio
    ) {
      return;
    }
    this.prefs = next;
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Storage full or blocked: the change still applies for this session
    }
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

let shared: PrefsStore | null = null;

/** The one store the main window's panels and every companion window share */
export function previewPrefs(): PrefsStore {
  shared ??= new PrefsStore(globalThis.localStorage ?? null);
  return shared;
}

/** A handed-over layout is taken by the next view of the file within this time */
const HANDOFF_MS = 10_000;
const handoffs = new Map<string, { layout: Layout; at: number }>();

/**
 * Hands a Markdown or HTML file's layout to the view that shows it next: a tab torn out into a
 * companion window, or docked back. `key` is `serverId:workspaceId:path`.
 */
export function handOffLayout(key: string, layout: Layout, now = Date.now()): void {
  handoffs.set(key, { layout, at: now });
}

/** The layout handed over for `key` moments ago, at most once */
export function takeLayout(key: string, now = Date.now()): Layout | null {
  const handoff = handoffs.get(key);
  handoffs.delete(key);
  return handoff && now - handoff.at <= HANDOFF_MS ? handoff.layout : null;
}
