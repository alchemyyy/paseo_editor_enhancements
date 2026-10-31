// The Markdown preferences, device-wide in localStorage: rendering engine, color palette, whether
// Markdown files open in Split, and the Split divider's position.
import type { Layout } from "./controls.ts";
import { type EngineId, isEngineId, isPaletteId, type PaletteId } from "./palettes.ts";

export interface MarkdownPrefs {
  engine: EngineId;
  /** The GitHub engine's colors; the Paseo engine always shows Paseo's theme */
  palette: PaletteId;
  /** Markdown files open side by side; set by choosing Split, cleared by choosing Preview or Source */
  openInSplit: boolean;
  /** The source editor's share of a Split, 0.2 to 0.8 */
  splitRatio: number;
}

const STORAGE_KEY = "paseo-markdown-enhancements:prefs";
export const MIN_SPLIT_RATIO = 0.2;
export const MAX_SPLIT_RATIO = 0.8;

export const DEFAULT_PREFS: MarkdownPrefs = {
  engine: "paseo",
  palette: "github",
  openInSplit: false,
  splitRatio: 0.5,
};

export function clampSplitRatio(ratio: number): number {
  return Number.isFinite(ratio) ? Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio)) : DEFAULT_PREFS.splitRatio;
}

/**
 * Engine and palette from the earlier single theme setting: the Paseo theme was Paseo's preview;
 * GitHub and Taiga Oak were the plugin's renderer in their colors, or in Paseo's with "Paseo colors"
 */
function fromTheme(theme: unknown, inheritColors: unknown): Pick<MarkdownPrefs, "engine" | "palette"> | null {
  if (theme === "paseo") return { engine: "paseo", palette: DEFAULT_PREFS.palette };
  if (theme !== "github" && theme !== "taiga-oak") return null;
  return { engine: "github", palette: inheritColors === true ? "paseo" : theme };
}

/** Stored preferences over the defaults; unknown or malformed fields fall back to the default */
export function parsePrefs(text: string | null): MarkdownPrefs {
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
    splitRatio: typeof stored.splitRatio === "number" ? clampSplitRatio(stored.splitRatio) : DEFAULT_PREFS.splitRatio,
  };
}

interface Storage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export class PrefsStore {
  private prefs: MarkdownPrefs;
  private readonly storage: Storage | null;
  private readonly listeners = new Set<() => void>();

  constructor(storage: Storage | null) {
    this.storage = storage;
    this.prefs = parsePrefs(storage?.getItem(STORAGE_KEY) ?? null);
  }

  get(): MarkdownPrefs {
    return this.prefs;
  }

  update(patch: Partial<MarkdownPrefs>): void {
    const next = { ...this.prefs, ...patch };
    next.splitRatio = clampSplitRatio(next.splitRatio);
    if (
      next.engine === this.prefs.engine &&
      next.palette === this.prefs.palette &&
      next.openInSplit === this.prefs.openInSplit &&
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
export function markdownPrefs(): PrefsStore {
  shared ??= new PrefsStore(globalThis.localStorage ?? null);
  return shared;
}

/** A handed-over layout is taken by the next view of the file within this time */
const HANDOFF_MS = 10_000;
const handoffs = new Map<string, { layout: Layout; at: number }>();

/**
 * Hands a Markdown file's layout to the view that shows it next: a tab torn out into a companion
 * window, or docked back. `key` is `serverId:workspaceId:path`.
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
