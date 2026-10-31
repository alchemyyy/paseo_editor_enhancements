// Classifies link and image targets in rendered Markdown. Shared by the vendored renderer (which
// moves local targets into data attributes before sanitizing) and the preview's click handler.

/** A URL scheme of two or more characters; a single letter is a Windows drive (`C:/...`) */
const URL_SCHEME = /^([a-z][a-z0-9+.-]+):/i;

/** Attribute holding a local image source, resolved by the plugin's daemon RPC */
export const LOCAL_IMAGE_ATTRIBUTE = "data-mde-src";
/** Attribute holding a local link target, opened as a Paseo file tab */
export const LOCAL_LINK_ATTRIBUTE = "data-mde-href";
/** First source line (1-based) of a rendered block, for scroll sync */
export const SOURCE_LINE_ATTRIBUTE = "data-source-line";

export type ReferenceKind = "fragment" | "external" | "local" | "other";

/**
 * What a link or image target names: an in-document `#fragment`, an external `http(s):`/`mailto:`
 * URL, a local file path (relative, absolute, `~/`, or `file:`), or anything else (other schemes,
 * protocol-relative URLs), which the preview leaves alone.
 */
export function classifyReference(target: string): ReferenceKind {
  const value = target.trim();
  if (!value) return "other";
  if (value.startsWith("#")) return "fragment";
  if (value.startsWith("//") || value.startsWith("\\\\")) return "other";
  const scheme = URL_SCHEME.exec(value)?.[1]?.toLowerCase();
  if (!scheme) return "local";
  if (scheme === "http" || scheme === "https" || scheme === "mailto") return "external";
  if (scheme === "file") return "local";
  return "other";
}

/** Splits a local link target into its path and the line its `#L12` / `#L12-L20` fragment names */
export function splitLocalTarget(target: string): { path: string; lineStart?: number; lineEnd?: number } {
  const hashIndex = target.indexOf("#");
  const path = hashIndex === -1 ? target : target.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? "" : target.slice(hashIndex + 1);
  const lines = /^L(\d+)(?:-L?(\d+))?$/i.exec(fragment);
  if (!lines) return { path };
  const lineStart = Number(lines[1]);
  const lineEnd = lines[2] ? Number(lines[2]) : undefined;
  return lineEnd && lineEnd >= lineStart ? { path, lineStart, lineEnd } : { path, lineStart };
}
