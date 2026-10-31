import path from "node:path";
import { fileURLToPath } from "node:url";

export const IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
  ".apng": "image/apng",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/;

export interface ReferenceContext {
  /** The Markdown file's path as its tab names it: workspace-relative or absolute */
  markdownPath: string;
  /** The workspace folder, or null when unknown */
  workspaceRoot: string | null;
  platform: NodeJS.Platform;
  home: string;
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * The host paths a local Markdown reference may name, most likely first. Relative references
 * resolve against the Markdown file's folder; `/x` is tried against the workspace folder first, as
 * GitHub resolves it against the repository root, then as a host path; `~/` is the home folder;
 * `file:` URLs and absolute paths stand as written. A `?query` or `#fragment` is ignored.
 */
export function candidatePaths(reference: string, context: ReferenceContext): string[] {
  const flavor = context.platform === "win32" ? path.win32 : path.posix;
  const isAbsolute = (value: string) =>
    context.platform === "win32" ? WINDOWS_ABSOLUTE.test(value) : value.startsWith("/");
  const trimmed = reference.trim();
  if (/^file:/i.test(trimmed)) {
    try {
      return [fileURLToPath(trimmed, { windows: context.platform === "win32" })];
    } catch {
      return [];
    }
  }
  const text = decode(trimmed.replace(/[?#].*$/s, ""));
  if (!text) return [];
  if (/^~[\\/]/.test(text)) return [flavor.join(context.home, text.slice(2))];
  const root = context.workspaceRoot;
  // One leading slash (not a UNC `\\server` or POSIX `//` path)
  if (/^[\\/](?![\\/])/.test(text)) {
    const candidates = root ? [flavor.join(root, text)] : [];
    // On POSIX `/x` is also a host path; on Windows it is drive-relative, which is meaningless here
    if (context.platform !== "win32") candidates.push(flavor.normalize(text));
    return candidates;
  }
  if (isAbsolute(text)) return [flavor.normalize(text)];

  let markdownPath: string | null = context.markdownPath;
  if (!isAbsolute(markdownPath)) markdownPath = root ? flavor.join(root, markdownPath) : null;
  return markdownPath ? [flavor.join(flavor.dirname(markdownPath), text)] : [];
}

/** The image MIME type for a path's extension, or null when it is not an image the preview shows */
export function imageMimeType(file: string): string | null {
  return IMAGE_MIME_TYPES[path.extname(file).toLowerCase()] ?? null;
}
