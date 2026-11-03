// Split view scroll sync: the preview follows the editor. Rendered blocks carry their first source
// line; the editor's top visible line (fractional) maps to a preview offset by interpolating
// between the blocks around it.

export interface LineAnchor {
  /** First source line of a rendered block, 1-based */
  line: number;
  /** The block's offset from the top of the preview's scroll content, in pixels */
  top: number;
}

/**
 * The anchors whose line is past every earlier kept anchor's, so lines map to offsets in order.
 * Drops blocks without a source line (0 or NaN) and blocks rendered out of source order.
 */
export function increasingAnchors(anchors: readonly LineAnchor[]): LineAnchor[] {
  const kept: LineAnchor[] = [];
  let last = 0;
  for (const anchor of anchors) {
    if (!(anchor.line > last)) continue;
    kept.push(anchor);
    last = anchor.line;
  }
  return kept;
}

/**
 * The preview scroll offset that shows source line `position` (1-based, fractional) at the top.
 * `anchors` are the rendered blocks in document order; `end` is the line after the document's last
 * line at the bottom of the preview content. Lines before the first block map from offset 0.
 */
export function previewOffsetForLine(anchors: readonly LineAnchor[], position: number, end: LineAnchor): number {
  const points = [{ line: 1, top: 0 }, ...anchors, end];
  for (let index = points.length - 2; index >= 0; index--) {
    const current = points[index];
    if (current.line > position) continue;
    const next = points[index + 1];
    if (next.line <= current.line) return current.top;
    const fraction = Math.min(1, (position - current.line) / (next.line - current.line));
    return current.top + fraction * (next.top - current.top);
  }
  return 0;
}
