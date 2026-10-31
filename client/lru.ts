export interface LruTab {
  tabId: string;
  /** Only file tabs count toward the limit and get closed */
  isFile: boolean;
  /** Last time the tab was focused (ms); older closes first */
  lastUsed: number;
}

/**
 * The file tabs to close so at most `limit` remain, least recently used first. The focused tab
 * and protected tabs (unsaved changes) are never closed, so the result can leave more than
 * `limit` when nothing else may go. A limit of 0 means off.
 */
export function selectEvictions(
  tabs: readonly LruTab[],
  limit: number,
  focusedTabId: string | null,
  protectedTabIds: ReadonlySet<string>,
): string[] {
  if (!Number.isInteger(limit) || limit <= 0) return [];
  const files = tabs.filter((tab) => tab.isFile);
  let excess = files.length - limit;
  if (excess <= 0) return [];
  const candidates = files
    .filter((tab) => tab.tabId !== focusedTabId && !protectedTabIds.has(tab.tabId))
    .sort((left, right) => left.lastUsed - right.lastUsed);
  const evicted: string[] = [];
  for (const tab of candidates) {
    if (excess <= 0) break;
    evicted.push(tab.tabId);
    excess -= 1;
  }
  return evicted;
}

/** A limit typed into the box: a whole number from 0 (off) up to `max` */
export function parseLimit(text: string, max: number): number {
  const value = Number.parseInt(text, 10);
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(value, max);
}
