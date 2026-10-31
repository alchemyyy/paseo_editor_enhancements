/** `tabIds` with each pinned tab moved back to its index, clamped to the strip */
export function restorePinnedOrder(tabIds: readonly string[], pinnedIndexById: ReadonlyMap<string, number>): string[] {
  const pinned = [...pinnedIndexById.entries()]
    .filter(([tabId]) => tabIds.includes(tabId))
    .sort((left, right) => left[1] - right[1]);
  const order = tabIds.filter((tabId) => !pinnedIndexById.has(tabId));
  for (const [tabId, index] of pinned) order.splice(Math.min(Math.max(index, 0), order.length), 0, tabId);
  return order;
}
