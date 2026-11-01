// Local files an HTML page references, for a page allowed to load resources. The page runs in an
// opaque-origin frame of its own document, which cannot reach the daemon's files, so every local
// reference (relative, `/` from the workspace root, absolute, `~/`, or `file:`) is read through the
// plugin's daemon RPC and written into the page as a `data:` URL before it loads: images, media,
// fonts, scripts, and stylesheets, with a stylesheet's own `url()`s and `@import`s resolved against
// the stylesheet. Web URLs stay as written; the page's policy decides whether they load.
import { classifyReference } from "./references.ts";

export type ReadResource = (reference: string) => Promise<{ mimeType: string; base64: string }>;

/** Elements whose attribute names a file the page loads */
const RESOURCE_SELECTORS: readonly [selector: string, attribute: string][] = [
  ["img[src]", "src"],
  ["source[src]", "src"],
  ["video[src]", "src"],
  ["video[poster]", "poster"],
  ["audio[src]", "src"],
  ["track[src]", "src"],
  ["input[type=image][src]", "src"],
  ["script[src]", "src"],
  ["link[href]", "href"],
  ["image[href]", "href"],
];
/** Link relations that load the linked file */
const LOADED_LINKS = /\b(stylesheet|icon|apple-touch-icon|preload|modulepreload)\b/i;
const CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
const CSS_IMPORT = /@import\s+(['"])([^'"]+)\1/gi;
/** How deep stylesheets importing stylesheets are followed */
const MAX_CSS_DEPTH = 4;
/** How long a file read stays in use: a typing burst reuses it, a file changed on disk shows soon */
const CACHE_MS = 5000;

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

/** `reference` as written in a stylesheet at `base`: relative to the stylesheet's folder */
export function resolveAgainst(base: string, reference: string): string {
  const value = reference.trim();
  if (classifyReference(value) !== "local" || /^([\\/~]|[a-z]:[\\/]|file:)/i.test(value)) return value;
  const slash = Math.max(base.lastIndexOf("/"), base.lastIndexOf("\\"));
  return slash === -1 ? value : `${base.slice(0, slash + 1)}${value}`;
}

/**
 * Returns a function that writes an HTML page's local resources into it as `data:` URLs. Files are
 * read through `read`, relative to the page, and kept for a few seconds. A page without local
 * references comes back as written; one with them comes back re-serialized.
 */
export function createResourceInliner(read: ReadResource): (html: string) => Promise<string> {
  const cache = new Map<string, { at: number; file: Promise<{ mimeType: string; base64: string } | null> }>();

  const readCached = (reference: string) => {
    const now = Date.now();
    const cached = cache.get(reference);
    if (cached && now - cached.at < CACHE_MS) return cached.file;
    const file = read(reference).catch(() => null);
    cache.set(reference, { at: now, file });
    return file;
  };

  /** A stylesheet's text with its local references resolved against `base` and inlined */
  const inlineCss = async (css: string, base: string | null, depth: number): Promise<string> => {
    const replacements = new Map<string, string>();
    const references = [...css.matchAll(CSS_URL), ...css.matchAll(CSS_IMPORT)].map((match) => match[2]);
    await Promise.all(
      references.map(async (reference) => {
        if (classifyReference(reference) !== "local" || replacements.has(reference)) return;
        replacements.set(reference, reference);
        const resolved = base ? resolveAgainst(base, reference) : reference;
        const url = await dataUrl(resolved, depth + 1);
        if (url) replacements.set(reference, url);
      }),
    );
    if (replacements.size === 0) return css;
    return css
      .replace(CSS_URL, (whole, quote: string, reference: string) => {
        const url = replacements.get(reference);
        return url && url !== reference ? `url("${url}")` : whole;
      })
      .replace(CSS_IMPORT, (whole, quote: string, reference: string) => {
        const url = replacements.get(reference);
        return url && url !== reference ? `@import "${url}"` : whole;
      });
  };

  /** A local file as a `data:` URL, stylesheets with their own references inlined; null when unreadable */
  const dataUrl = async (reference: string, depth: number): Promise<string | null> => {
    const file = await readCached(reference);
    if (!file) return null;
    if (file.mimeType !== "text/css" || depth > MAX_CSS_DEPTH) return `data:${file.mimeType};base64,${file.base64}`;
    const css = new TextDecoder().decode(decodeBase64(file.base64));
    return `data:text/css;base64,${encodeBase64(await inlineCss(css, reference, depth))}`;
  };

  return async (html) => {
    const doc = new DOMParser().parseFromString(html, "text/html");
    let changed = false;
    const jobs: Promise<void>[] = [];
    for (const [selector, attribute] of RESOURCE_SELECTORS) {
      for (const element of Array.from(doc.querySelectorAll(selector))) {
        if (element.localName === "link" && !LOADED_LINKS.test(element.getAttribute("rel") ?? "")) continue;
        const reference = element.getAttribute(attribute) ?? "";
        if (classifyReference(reference) !== "local") continue;
        jobs.push(
          dataUrl(reference, 0).then((url) => {
            if (!url) return;
            element.setAttribute(attribute, url);
            changed = true;
          }),
        );
      }
    }
    for (const style of Array.from(doc.querySelectorAll("style"))) {
      const css = style.textContent ?? "";
      jobs.push(
        inlineCss(css, null, 0).then((next) => {
          if (next === css) return;
          style.textContent = next;
          changed = true;
        }),
      );
    }
    for (const element of Array.from(doc.querySelectorAll("[style]"))) {
      const css = element.getAttribute("style") ?? "";
      jobs.push(
        inlineCss(css, null, 0).then((next) => {
          if (next === css) return;
          element.setAttribute("style", next);
          changed = true;
        }),
      );
    }
    await Promise.all(jobs);
    return changed ? `<!DOCTYPE html>${doc.documentElement.outerHTML}` : html;
  };
}
