// Local images in the preview: read once through the plugin's daemon RPC and kept as blob URLs, so
// re-rendering a document while it is edited reuses decoded images instead of reloading them.

/** Images kept per session; the oldest is released past this */
const MAX_CACHED_IMAGES = 200;

type Entry = { url: string | null; promise: Promise<string> };

const cache = new Map<string, Entry>();

export type ReadImage = (reference: string) => Promise<{ mimeType: string; base64: string }>;

function toBlobUrl({ mimeType, base64 }: { mimeType: string; base64: string }): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
}

/**
 * The blob URL of a local image, keyed by `key` (host, workspace, Markdown file, and reference).
 * Returns the URL at once when it is cached, else a promise of it.
 */
export function imageUrl(key: string, reference: string, read: ReadImage): string | Promise<string> {
  const cached = cache.get(key);
  if (cached) {
    // Refresh recency
    cache.delete(key);
    cache.set(key, cached);
    if (cached.url) return cached.url;
    return cached.promise;
  }
  const entry: Entry = { url: null, promise: Promise.resolve("") };
  entry.promise = read(reference).then(
    (image) => {
      entry.url = toBlobUrl(image);
      return entry.url;
    },
    (error: unknown) => {
      // A failed read is retried on the next render
      cache.delete(key);
      throw error;
    },
  );
  cache.set(key, entry);
  while (cache.size > MAX_CACHED_IMAGES) {
    const [oldestKey, oldest] = cache.entries().next().value as [string, Entry];
    cache.delete(oldestKey);
    if (oldest.url) URL.revokeObjectURL(oldest.url);
  }
  return entry.promise;
}

/** Releases every cached image */
export function clearImageCache(): void {
  for (const entry of cache.values()) if (entry.url) URL.revokeObjectURL(entry.url);
  cache.clear();
}
