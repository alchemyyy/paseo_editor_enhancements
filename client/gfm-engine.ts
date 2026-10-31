// The GitHub engine: gh-gfm-preview's renderer (Go, built for WebAssembly by scripts/vendor.mjs)
// running in a worker, so rendering never stalls typing; and the Mermaid, MathJax, and Leaflet
// code gh-gfm-preview's page runs over its HTML. Everything comes from the plugin's own server and
// renders offline. One engine serves every preview in this window and its companion windows.
import type { EngineAssetName } from "../shared/contracts";
import { sanitizeHtml, splitFrontMatter } from "./vendor/markdown";

/** Fetches one engine file from the plugin server: gzipped, base64-encoded */
export type LoadEngineAsset = (name: EngineAssetName) => Promise<string>;

export interface Mermaid {
  initialize(config: { startOnLoad: boolean; theme: string }): void;
  /** Renders in a scratch element of the page's own document, which its d3 selections search */
  render(id: string, text: string): Promise<{ svg: string; bindFunctions?: (element: Element) => void }>;
}

export interface MathJax {
  startup: { promise: Promise<void> };
  typesetPromise(elements: Node[]): Promise<void>;
  typesetClear(elements: Node[]): void;
  svgStylesheet(): HTMLStyleElement;
}

/** The part of Leaflet gh-gfm-preview's maps use */
export interface Leaflet {
  map(container: HTMLElement, options: object): LeafletMap;
  geoJSON(data: object, options: object): { addTo(map: LeafletMap): { getBounds(): { isValid(): boolean } } };
  circleMarker(latlng: unknown, options: object): unknown;
}

export interface LeafletMap {
  fitBounds(bounds: object, options: object): void;
  setView(center: [number, number], zoom: number): void;
  remove(): void;
}

export interface TopoJson {
  feature(topology: object, object: object): { type: string; features?: object[] };
}

/** Runs in the worker, after Go's wasm_exec.js has defined Go */
const WORKER_MAIN = `
"use strict";
let ready = null;
self.onmessage = (event) => {
  const message = event.data;
  if (message.type === "start") {
    const go = new Go();
    ready = WebAssembly.instantiate(message.module, go.importObject).then((instance) => {
      go.run(instance);
    });
    return;
  }
  ready.then(
    () => {
      try {
        const result = self.paseoGfmRender(message.markdown, message.lineOffset);
        self.postMessage({ id: message.id, html: result.html, error: result.error });
      } catch (error) {
        // A panic ends the Go program; the engine starts a new worker
        self.postMessage({ id: message.id, error: String((error && error.message) || error), fatal: true });
      }
    },
    (error) => self.postMessage({ id: message.id, error: String((error && error.message) || error), fatal: true }),
  );
};
`;

interface RenderReply {
  id: number;
  html?: string;
  error?: string;
  fatal?: boolean;
}

function decodeBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function gunzip(gzipBase64: string): Promise<ArrayBuffer> {
  const stream = new Blob([decodeBase64(gzipBase64)]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

/** Window-global so a reloaded plugin reuses libraries already evaluated in this window */
interface Libraries {
  mermaid?: Promise<Mermaid>;
  mathjax?: Promise<MathJax>;
  leaflet?: Promise<{ leaflet: Leaflet; leafletCss: string; topojson: TopoJson }>;
}

const LIBRARIES_KEY = "__paseoEditorEnhancementsLibraries";

function libraries(): Libraries {
  const scope = globalThis as unknown as Record<string, Libraries | undefined>;
  scope[LIBRARIES_KEY] ??= {};
  return scope[LIBRARIES_KEY];
}

/**
 * Runs library code as a classic page script, as gh-gfm-preview's page loads it: top-level
 * declarations become globals even under "use strict", which eval would keep to itself
 */
function evaluate(source: string): void {
  const script = document.createElement("script");
  script.textContent = source;
  document.head.appendChild(script);
  script.remove();
}

/** A global a library defines when it runs; its type is the library's documented API */
function libraryGlobal<T>(name: string): T {
  const value: unknown = Reflect.get(globalThis, name);
  if (value === undefined || value === null) throw new Error(`The GitHub engine's ${name} library did not load`);
  return value as T;
}

/** A window-wide library, loaded once; a failed load is tried again on next use */
function library<K extends keyof Libraries>(key: K, load: () => NonNullable<Libraries[K]>): NonNullable<Libraries[K]> {
  const shared = libraries();
  const cached = shared[key];
  if (cached) return cached;
  const loading = load();
  shared[key] = loading;
  void (loading as Promise<unknown>).catch(() => {
    if (shared[key] === loading) delete shared[key];
  });
  return loading;
}

export class GfmEngine {
  private readonly load: LoadEngineAsset;
  private readonly files = new Map<EngineAssetName, Promise<ArrayBuffer>>();
  private module: Promise<WebAssembly.Module> | null = null;
  private worker: Promise<Worker> | null = null;
  private readonly pending = new Map<number, { resolve(html: string): void; reject(error: Error): void }>();
  private nextId = 0;
  private disposed = false;

  constructor(load: LoadEngineAsset) {
    this.load = load;
  }

  /** Sanitized HTML for a Markdown document, front matter included, blocks marked with their source lines */
  async render(markdown: string): Promise<string> {
    const frontMatter = splitFrontMatter(markdown);
    const html = await this.renderInWorker(frontMatter?.body ?? markdown, frontMatter?.lineOffset ?? 0);
    return sanitizeHtml((frontMatter?.html ?? "") + html);
  }

  mermaid(): Promise<Mermaid> {
    return library("mermaid", () =>
      this.text("mermaid.js").then((source) => {
        evaluate(source);
        return libraryGlobal<Mermaid>("mermaid");
      }),
    );
  }

  /**
   * MathJax with TeX input and SVG output, configured as gh-gfm-preview configures it. SVG keeps
   * glyphs inside each formula, so math renders in a shadow root without web fonts. TeX
   * extensions load from the vendored set as the autoloader asks for them.
   */
  mathjax(): Promise<MathJax> {
    return library("mathjax", () =>
      Promise.all([this.text("mathjax.js"), this.text("mathjax-extensions.json")]).then(async ([source, extensionsJson]) => {
        const extensions = JSON.parse(extensionsJson) as Record<string, string>;
        Reflect.set(globalThis, "MathJax", {
          loader: {
            paths: { mathjax: "mathjax" },
            require: (path: string) => {
              const name = /input\/tex\/extensions\/([\w-]+\.js)$/.exec(path)?.[1];
              const extension = name ? extensions[name] : undefined;
              if (extension === undefined) return Promise.reject(new Error(`MathJax: ${path} is not available offline`));
              evaluate(extension);
              return Promise.resolve();
            },
          },
          tex: {
            inlineMath: [
              ["$", "$"],
              ["\\(", "\\)"],
            ],
            displayMath: [
              ["$$", "$$"],
              ["\\[", "\\]"],
            ],
          },
          svg: { fontCache: "local" },
          startup: { typeset: false },
        });
        evaluate(source);
        const mathjax = libraryGlobal<MathJax>("MathJax");
        await mathjax.startup.promise;
        return mathjax;
      }),
    );
  }

  leaflet(): Promise<{ leaflet: Leaflet; leafletCss: string; topojson: TopoJson }> {
    return library("leaflet", () =>
      Promise.all([this.text("leaflet.js"), this.text("leaflet.css"), this.text("topojson.js")]).then(
        ([leafletSource, leafletCss, topojsonSource]) => {
          evaluate(leafletSource);
          evaluate(topojsonSource);
          return { leaflet: libraryGlobal<Leaflet>("L"), leafletCss, topojson: libraryGlobal<TopoJson>("topojson") };
        },
      ),
    );
  }

  dispose(): void {
    this.disposed = true;
    void this.worker?.then((worker) => worker.terminate()).catch(() => undefined);
    this.worker = null;
    for (const request of this.pending.values()) request.reject(new Error("The GitHub renderer stopped"));
    this.pending.clear();
  }

  private file(name: EngineAssetName): Promise<ArrayBuffer> {
    let file = this.files.get(name);
    if (!file) {
      file = this.load(name).then(gunzip);
      // A failed fetch is retried on next use
      file.catch(() => this.files.delete(name));
      this.files.set(name, file);
    }
    return file;
  }

  private async text(name: EngineAssetName): Promise<string> {
    return new TextDecoder().decode(await this.file(name));
  }

  private renderInWorker(markdown: string, lineOffset: number): Promise<string> {
    if (this.disposed) return Promise.reject(new Error("The GitHub renderer stopped"));
    const id = ++this.nextId;
    const { promise: reply, resolve, reject } = Promise.withResolvers<string>();
    this.pending.set(id, { resolve, reject });
    const worker = (this.worker ??= this.startWorker());
    worker.then(
      (started) => started.postMessage({ type: "render", id, markdown, lineOffset }),
      (error: unknown) => this.settle({ id, error: error instanceof Error ? error.message : String(error), fatal: true }),
    );
    return reply;
  }

  private async startWorker(): Promise<Worker> {
    this.module ??= this.file("gfm.wasm").then((bytes) => WebAssembly.compile(bytes));
    const [module, loader] = await Promise.all([this.module, this.text("wasm_exec.js")]);
    const url = URL.createObjectURL(new Blob([loader, WORKER_MAIN], { type: "text/javascript" }));
    const worker = new Worker(url);
    worker.onmessage = (event: MessageEvent<RenderReply>) => this.settle(event.data);
    worker.onerror = (event) => {
      event.preventDefault();
      this.restart(event.message || "The GitHub renderer's worker failed");
    };
    // The compiled module is shared with the worker, not copied
    worker.postMessage({ type: "start", module });
    // The worker has read its script once it answers; the URL is not needed after that
    const revoke = () => URL.revokeObjectURL(url);
    worker.addEventListener("message", revoke, { once: true });
    worker.addEventListener("error", revoke, { once: true });
    return worker;
  }

  private settle(reply: RenderReply): void {
    const request = this.pending.get(reply.id);
    this.pending.delete(reply.id);
    if (reply.fatal) this.restart(null);
    if (!request) return;
    if (reply.error !== undefined || reply.html === undefined) request.reject(new Error(reply.error ?? "No output"));
    else request.resolve(reply.html);
  }

  /** Drops a broken worker; the next render starts another. `failure` rejects the renders it held. */
  private restart(failure: string | null): void {
    const broken = this.worker;
    this.worker = null;
    void broken?.then((worker) => worker.terminate()).catch(() => undefined);
    if (failure === null) return;
    for (const request of this.pending.values()) request.reject(new Error(failure));
    this.pending.clear();
  }
}
