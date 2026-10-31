// What gh-gfm-preview's page script (internal/server/static/script.js) does over the rendered
// HTML, for one preview: copy buttons on code blocks, Mermaid diagrams with pan, zoom, reset, and a
// full-pane view, GeoJSON and TopoJSON maps, and MathJax. Maps draw their shapes without the
// online tile layer gh-gfm-preview adds, so the preview stays offline.
import type { GfmEngine, Leaflet, LeafletMap, MathJax, TopoJson } from "./gfm-engine";

const MERMAID_QUERY = "code.language-mermaid";
const GEOJSON_QUERY = "code.language-geojson";
const TOPOJSON_QUERY = "code.language-topojson";
const MAP_QUERY = `${GEOJSON_QUERY}, ${TOPOJSON_QUERY}`;
const MERMAID_MIN_SCALE = 0.2;
const MERMAID_MAX_SCALE = 5;
const MERMAID_ZOOM_IN = 1.1;
const MERMAID_ZOOM_OUT = 0.9;
const MERMAID_OVERLAY_PADDING = 64;
const COPIED_MS = 1000;

/** Mermaid needs a fresh element id for every render in the page */
let diagramSerial = 0;
/** Delimiters gh-gfm-preview's MathJax configuration looks for */
const MATH_PATTERN = /\$|\\\(|\\\[/;

const COPY_ICON = `<svg class="copy-icon" aria-hidden="true" fill="none" height="18" shape-rendering="geometricPrecision" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" viewBox="0 0 24 24" width="18"><path d="M8 17.929H6c-1.105 0-2-.912-2-2.036V5.036C4 3.91 4.895 3 6 3h8c1.105 0 2 .911 2 2.036v1.866m-6 .17h8c1.105 0 2 .91 2 2.035v10.857C20 21.09 19.105 22 18 22h-8c-1.105 0-2-.911-2-2.036V9.107c0-1.124.895-2.036 2-2.036z"></path></svg>`;
const TICK_ICON = `<svg class="tick-icon" aria-hidden="true" fill="none" height="18" shape-rendering="geometricPrecision" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" viewBox="0 0 24 24" width="18"><path d="M5 13l4 4L19 7"></path></svg>`;
const EXPAND_ICON = `<svg class="expand-icon" aria-hidden="true" viewBox="0 0 1792 1792" width="14" height="14" fill="currentColor"><path d="M883 1056q0 13-10 23l-332 332 144 144q19 19 19 45t-19 45-45 19h-448q-26 0-45-19t-19-45v-448q0-26 19-45t45-19 45 19l144 144 332-332q10-10 23-10t23 10l114 114q10 10 10 23zm781-864v448q0 26-19 45t-45 19-45-19l-144-144-332 332q-10 10-23 10t-23-10l-114-114q-10-10-10-23t10-23l332-332-144-144q-19-19-19-45t19-45 45-19h448q26 0 45 19t19 45z"></path></svg>`;

interface PanZoom {
  state: { scale: number; tx: number; ty: number };
  apply(): void;
  detach(): void;
}

/** Wheel zoom and drag pan for an SVG inside `element` */
function attachPanZoom(element: HTMLElement, svg: SVGElement): PanZoom {
  const state = { dragging: false, lastX: 0, lastY: 0, scale: 1, tx: 0, ty: 0 };
  const apply = () => {
    svg.style.transform = `translate(${state.tx}px, ${state.ty}px) scale(${state.scale})`;
  };
  const onWheel = (event: WheelEvent) => {
    const rect = element.getBoundingClientRect();
    const factor = event.deltaY < 0 ? MERMAID_ZOOM_IN : MERMAID_ZOOM_OUT;
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const scale = Math.max(MERMAID_MIN_SCALE, Math.min(MERMAID_MAX_SCALE, state.scale * factor));
    event.preventDefault();
    if (scale === state.scale) return;
    state.tx = x - (x - state.tx) * (scale / state.scale);
    state.ty = y - (y - state.ty) * (scale / state.scale);
    state.scale = scale;
    apply();
  };
  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    state.dragging = true;
    state.lastX = event.clientX;
    state.lastY = event.clientY;
    element.style.cursor = "grabbing";
    element.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!state.dragging) return;
    state.tx += event.clientX - state.lastX;
    state.ty += event.clientY - state.lastY;
    state.lastX = event.clientX;
    state.lastY = event.clientY;
    apply();
  };
  const onPointerUp = () => {
    if (!state.dragging) return;
    state.dragging = false;
    element.style.cursor = "grab";
  };
  element.addEventListener("wheel", onWheel, { passive: false });
  element.addEventListener("pointerdown", onPointerDown);
  element.addEventListener("pointermove", onPointerMove);
  element.addEventListener("pointerup", onPointerUp);
  element.addEventListener("pointercancel", onPointerUp);
  return {
    state,
    apply,
    detach() {
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("pointerdown", onPointerDown);
      element.removeEventListener("pointermove", onPointerMove);
      element.removeEventListener("pointerup", onPointerUp);
      element.removeEventListener("pointercancel", onPointerUp);
    },
  };
}

function button(doc: Document, className: string, label: string): HTMLButtonElement {
  const element = doc.createElement("button");
  element.type = "button";
  element.className = className;
  element.setAttribute("aria-label", label);
  return element;
}

/** The elements under `nodes` (themselves included) that match `query` */
function matching<T extends Element>(nodes: readonly Element[], query: string): T[] {
  return nodes.flatMap((node) => [...(node.matches(query) ? [node] : []), ...Array.from(node.querySelectorAll(query))] as T[]);
}

export class GfmPage {
  private readonly engine: GfmEngine;
  private readonly root: ShadowRoot;
  private readonly overlay: HTMLDivElement;
  private readonly maps = new Map<HTMLElement, LeafletMap>();
  /** Pan and zoom of each diagram, replaced when the diagram renders again */
  private readonly panZooms = new WeakMap<HTMLElement, PanZoom>();
  private mathStyle: HTMLStyleElement | null = null;
  private leafletStyle: HTMLStyleElement | null = null;
  private dark = false;
  private closeOverlay: (() => void) | null = null;
  private disposed = false;

  constructor(engine: GfmEngine, root: ShadowRoot) {
    this.engine = engine;
    this.root = root;
    this.overlay = root.ownerDocument.createElement("div");
    this.overlay.className = "mermaid-overlay";
    this.overlay.setAttribute("role", "dialog");
    this.overlay.setAttribute("aria-modal", "true");
    this.overlay.setAttribute("aria-label", "Diagram full view");
    root.appendChild(this.overlay);
  }

  /** Runs the page script over blocks just inserted into the preview */
  enhance(nodes: readonly Element[]): void {
    if (nodes.length === 0) return;
    const diagrams = matching<HTMLElement>(nodes, MERMAID_QUERY);
    const maps = matching<HTMLElement>(nodes, MAP_QUERY);
    for (const code of [...diagrams, ...maps]) {
      const original = code.textContent ?? "";
      code.setAttribute("data-original-code", original);
      code.closest("pre")?.setAttribute("data-copy-content", original);
    }
    this.addCopyButtons(matching<HTMLPreElement>(nodes, "pre"));
    if (diagrams.length > 0) void this.renderDiagrams(diagrams);
    if (maps.length > 0) void this.renderMaps(maps);
    if (nodes.some((node) => MATH_PATTERN.test(node.textContent ?? ""))) void this.typesetMath(nodes);
  }

  /** Frees what the page script attached to blocks leaving the preview */
  release(nodes: readonly Node[]): void {
    const elements = nodes.filter((node): node is Element => node instanceof Element);
    for (const code of matching<HTMLElement>(elements, MAP_QUERY)) {
      this.maps.get(code)?.remove();
      this.maps.delete(code);
    }
    if (this.mathStyle && elements.length > 0) {
      void this.engine.mathjax().then((mathjax) => mathjax.typesetClear(elements));
    }
  }

  /** Diagrams follow the palette's light or dark scheme, re-rendering when it changes */
  setDark(dark: boolean): void {
    if (dark === this.dark) return;
    this.dark = dark;
    const diagrams = Array.from(this.root.querySelectorAll<HTMLElement>(`${MERMAID_QUERY}[data-original-code]`));
    if (diagrams.length > 0) void this.renderDiagrams(diagrams);
  }

  dispose(): void {
    this.disposed = true;
    this.closeOverlay?.();
    for (const map of this.maps.values()) map.remove();
    this.maps.clear();
  }

  private addCopyButtons(blocks: readonly HTMLPreElement[]): void {
    for (const pre of blocks) {
      const code = pre.querySelector("code");
      if (!code || pre.querySelector(".copy-button")) continue;
      const copy = button(pre.ownerDocument, "copy-button", "Copy code to clipboard");
      copy.innerHTML = COPY_ICON;
      pre.style.position = "relative";
      pre.appendChild(copy);
      copy.addEventListener("click", () => {
        const text = pre.getAttribute("data-copy-content") ?? code.textContent ?? "";
        // The clipboard of the window showing the preview, which has the focus
        const clipboard = pre.ownerDocument.defaultView?.navigator.clipboard;
        void clipboard?.writeText(text).then(() => {
          copy.innerHTML = TICK_ICON;
          setTimeout(() => (copy.innerHTML = COPY_ICON), COPIED_MS);
        });
      });
    }
  }

  private async renderDiagrams(diagrams: readonly HTMLElement[]): Promise<void> {
    let mermaid;
    try {
      mermaid = await this.engine.mermaid();
    } catch (error) {
      console.error("[editor-enhancements] Mermaid did not load", error);
      return;
    }
    // Mermaid's theme is global; each batch sets the one its preview shows
    mermaid.initialize({ startOnLoad: false, theme: this.dark ? "dark" : "default" });
    for (const code of diagrams) {
      if (!code.isConnected || this.disposed) continue;
      const text = code.getAttribute("data-original-code") ?? "";
      // mermaid.run would render inside the preview's shadow root, where Mermaid's d3 selections
      // (which search the document) cannot reach; render() works in the document and returns SVG
      try {
        const { svg, bindFunctions } = await mermaid.render(`mde-mermaid-${++diagramSerial}`, text);
        if (!code.isConnected || this.disposed) continue;
        code.innerHTML = svg;
        bindFunctions?.(code);
        code.setAttribute("data-processed", "true");
        this.setupPanZoom(code);
      } catch (error) {
        // gh-gfm-preview logs and leaves the diagram's code in place
        console.error("[editor-enhancements] Mermaid could not render a diagram", error);
        code.textContent = text;
      }
    }
  }

  private setupPanZoom(code: HTMLElement): void {
    const svg = code.querySelector("svg");
    if (!svg || svg.hasAttribute("data-panzoom")) return;
    const pre = code.closest("pre");
    this.panZooms.get(code)?.detach();
    const panZoom = attachPanZoom(code, svg);
    this.panZooms.set(code, panZoom);
    svg.setAttribute("data-panzoom", "true");
    svg.style.transformOrigin = "0 0";
    svg.style.display = "block";
    code.classList.add("diagram-mermaid-code");
    if (!pre) return;
    pre.classList.add("diagram-mermaid-pre");
    pre.style.position = "relative";
    pre.querySelector(".mermaid-reset-btn")?.remove();
    pre.querySelector(".mermaid-expand-btn")?.remove();
    const reset = button(pre.ownerDocument, "mermaid-reset-btn", "Reset diagram view");
    reset.textContent = "Reset";
    reset.addEventListener("click", () => {
      Object.assign(panZoom.state, { scale: 1, tx: 0, ty: 0 });
      panZoom.apply();
    });
    const expand = button(pre.ownerDocument, "mermaid-expand-btn", "Expand diagram to the full preview");
    expand.innerHTML = EXPAND_ICON;
    expand.addEventListener("click", () => this.openOverlay(svg));
    pre.append(reset, expand);
  }

  /** The diagram over the whole preview, with its own pan and zoom; Escape or × closes it */
  private openOverlay(original: SVGElement): void {
    this.closeOverlay?.();
    const doc = this.overlay.ownerDocument;
    const svg = original.cloneNode(true) as SVGElement;
    svg.removeAttribute("data-panzoom");
    svg.style.transform = "";
    svg.style.transformOrigin = "0 0";
    svg.style.display = "block";
    const inner = doc.createElement("div");
    inner.className = "mermaid-overlay-inner";
    inner.appendChild(svg);
    const close = button(doc, "mermaid-overlay-close", "Close full view");
    close.textContent = "×";
    const reset = button(doc, "mermaid-reset-btn", "Reset diagram view");
    reset.textContent = "Reset";
    this.overlay.replaceChildren(inner, close, reset);
    const panZoom = attachPanZoom(inner, svg);
    this.overlay.classList.add("is-open");
    const innerRect = inner.getBoundingClientRect();
    const svgRect = svg.getBoundingClientRect();
    if (svgRect.width > 0 && svgRect.height > 0) {
      const fit = Math.min(
        1,
        (innerRect.width - MERMAID_OVERLAY_PADDING) / svgRect.width,
        (innerRect.height - MERMAID_OVERLAY_PADDING) / svgRect.height,
      );
      Object.assign(panZoom.state, {
        scale: fit,
        tx: (innerRect.width - svgRect.width * fit) / 2,
        ty: (innerRect.height - svgRect.height * fit) / 2,
      });
      panZoom.apply();
    }
    const initial = { ...panZoom.state };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") this.closeOverlay?.();
    };
    this.closeOverlay = () => {
      this.overlay.classList.remove("is-open");
      this.overlay.replaceChildren();
      doc.removeEventListener("keydown", onKeyDown);
      panZoom.detach();
      this.closeOverlay = null;
    };
    reset.addEventListener("click", () => {
      Object.assign(panZoom.state, initial);
      panZoom.apply();
    });
    close.addEventListener("click", () => this.closeOverlay?.());
    doc.addEventListener("keydown", onKeyDown);
  }

  private async renderMaps(codes: readonly HTMLElement[]): Promise<void> {
    let library: { leaflet: Leaflet; leafletCss: string; topojson: TopoJson };
    try {
      library = await this.engine.leaflet();
    } catch (error) {
      console.error("[editor-enhancements] Leaflet did not load", error);
      return;
    }
    if (this.disposed) return;
    if (!this.leafletStyle) {
      this.leafletStyle = this.root.ownerDocument.createElement("style");
      this.leafletStyle.textContent = library.leafletCss;
      this.root.prepend(this.leafletStyle);
    }
    for (const code of codes) {
      if (!code.isConnected || this.maps.has(code)) continue;
      try {
        this.renderMap(code, library);
      } catch (error) {
        console.error("[editor-enhancements] Could not draw a map", error);
      }
    }
  }

  private renderMap(code: HTMLElement, { leaflet, topojson }: { leaflet: Leaflet; topojson: TopoJson }): void {
    const features = mapFeatures(code.getAttribute("data-original-code") ?? code.textContent ?? "", code.matches(TOPOJSON_QUERY), topojson);
    const container = code.ownerDocument.createElement("div");
    code.closest("pre")?.classList.add("diagram-map-pre");
    code.classList.add("diagram-map-code");
    container.className = "leaflet-diagram-map";
    code.replaceChildren(container);
    code.setAttribute("data-processed", "true");
    const map = leaflet.map(container, { attributionControl: false, scrollWheelZoom: false, zoomControl: true });
    this.maps.set(code, map);
    // The palette's accent, which Leaflet needs as a value rather than a variable
    const accent = getComputedStyle(code).getPropertyValue("--fgColor-accent").trim() || "#1f6feb";
    const layer = leaflet
      .geoJSON(features, {
        pointToLayer: (_feature: unknown, latlng: unknown) =>
          leaflet.circleMarker(latlng, { color: accent, fillColor: accent, fillOpacity: 0.8, opacity: 1, radius: 6, weight: 2 }),
        style: (feature: { geometry?: { type?: string } } | undefined) => ({
          color: accent,
          fillColor: accent,
          fillOpacity: feature?.geometry?.type?.includes("Polygon") ? 0.22 : 0,
          opacity: 0.9,
          weight: 2,
        }),
      })
      .addTo(map);
    const bounds = layer.getBounds();
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [24, 24] });
    else map.setView([20, 0], 1);
  }

  private async typesetMath(nodes: readonly Element[]): Promise<void> {
    let mathjax: MathJax;
    try {
      mathjax = await this.engine.mathjax();
    } catch (error) {
      console.error("[editor-enhancements] MathJax did not load", error);
      return;
    }
    if (this.disposed) return;
    if (!this.mathStyle) {
      // MathJax puts its SVG stylesheet in the document head, which the shadow root does not see
      this.mathStyle = this.root.ownerDocument.createElement("style");
      this.mathStyle.textContent = mathjax.svgStylesheet().textContent;
      this.root.prepend(this.mathStyle);
    }
    const connected = nodes.filter((node) => node.isConnected);
    try {
      await mathjax.typesetPromise(connected);
    } catch (error) {
      console.error("[editor-enhancements] MathJax could not typeset", error);
    }
  }
}

/** gh-gfm-preview's reading of a GeoJSON or TopoJSON block as one feature collection */
function mapFeatures(code: string, isTopoJson: boolean, topojson: TopoJson): { type: "FeatureCollection"; features: object[] } {
  const parsed: unknown = JSON.parse(code);
  if (!parsed || typeof parsed !== "object") throw new Error("Geo data is not an object");
  let features: object[];
  if (isTopoJson) {
    const objects = "objects" in parsed && parsed.objects && typeof parsed.objects === "object" ? Object.values(parsed.objects) : [];
    if (objects.length === 0) throw new Error("TopoJSON does not contain any objects");
    features = objects.flatMap((object: object) => {
      const converted = topojson.feature(parsed, object);
      return converted.type === "FeatureCollection" ? (converted.features ?? []) : [converted];
    });
  } else if ("type" in parsed && parsed.type === "FeatureCollection") {
    features = "features" in parsed && Array.isArray(parsed.features) ? parsed.features : [];
  } else if ("type" in parsed && parsed.type === "Feature") {
    features = [parsed];
  } else {
    features = [{ type: "Feature", geometry: parsed, properties: {} }];
  }
  if (features.length === 0) throw new Error("Geo data does not contain any features");
  return { type: "FeatureCollection", features };
}
