// The toolbar controls of a Markdown or HTML panel: a Preview | Split | Source control standing in
// for Paseo's Preview | Source, and for Markdown a labeled renderer dropdown and a labeled color
// palette dropdown before it. The stand-in copies the size and type of Paseo's control as laid out,
// and takes its colors from Paseo's CSS variables, as Paseo's segmented control does
// (components/ui/segmented-control.tsx). Paseo's style classes cannot be reused: their rules are
// rewritten in place as the control they belong to changes state.
import type { PanelKind } from "./fiber";
import { ENGINE_IDS, ENGINES, type EngineId, PALETTE_IDS, PALETTES, type PaletteId } from "./palettes";

export type Layout = "preview" | "split" | "source";

/** Preview | Split | Source as each kind of panel describes them */
const LAYOUTS: Readonly<Record<PanelKind, readonly { value: Layout; label: string; title: string }[]>> = {
  markdown: [
    { value: "preview", label: "Preview", title: "Rendered Markdown" },
    { value: "split", label: "Split", title: "Source and preview side by side; the preview follows unsaved edits" },
    { value: "source", label: "Source", title: "Markdown source" },
  ],
  html: [
    { value: "preview", label: "Preview", title: "Rendered page" },
    { value: "split", label: "Split", title: "Source and page side by side; the page follows unsaved edits" },
    { value: "source", label: "Source", title: "HTML source" },
  ],
};

const GROUP_LABELS: Readonly<Record<PanelKind, string>> = { markdown: "Markdown view", html: "HTML view" };

/** What Markdown's renderer and palette dropdowns show */
export interface RendererState {
  /** The renderer chosen, which the dropdown shows even where the GitHub renderer stands in for it */
  engine: EngineId;
  /** Whether the palette colors what the view shows, which only the GitHub renderer draws */
  paletteApplies: boolean;
  palette: PaletteId;
}

export interface ControlsState {
  layout: Layout;
  /** Whether a Split's preview follows the editor's scroll */
  syncScroll: boolean;
  /** HTML: whether the page may load resources from the web and its local files */
  resources?: boolean;
  /** Markdown's dropdowns; HTML has none */
  renderer?: RendererState;
}

/** The panel kind, and what choosing in its controls does */
export type ControlsSetup =
  | {
      kind: "markdown";
      setLayout(layout: Layout): void;
      setSyncScroll(on: boolean): void;
      setEngine(engine: EngineId): void;
      setPalette(palette: PaletteId): void;
    }
  | { kind: "html"; setLayout(layout: Layout): void; setSyncScroll(on: boolean): void; setResources(on: boolean): void };

type ToggleName = "syncScroll" | "resources";

/** Geometry of Paseo's control as laid out, so the stand-in matches it at any UI scale */
interface SegmentLook {
  containerGap: string;
  containerMinHeight: string;
  padding: string;
  minHeight: string;
  borderRadius: string;
  fontFamily: string;
  fontSize: string;
  lineHeight: string;
}

/** For windows without Paseo's control to measure: Paseo 0.13's "xs" segmented control */
const DEFAULT_LOOK: SegmentLook = {
  containerGap: "4px",
  containerMinHeight: "26px",
  padding: "0px 8px",
  minHeight: "22px",
  borderRadius: "12px",
  fontFamily: "var(--fontFamily-ui)",
  fontSize: "12px",
  lineHeight: "normal",
};

const PALETTE_ONLY_GITHUB = "Palettes color the GitHub renderer; Paseo's renderer shows Paseo's theme";
const SYNC_TITLE = "In Split, the preview follows the editor's scroll";
const RESOURCES_TITLE =
  "Lets the page load from the web and load the local files it references (images, stylesheets, scripts, fonts, media). The page stays isolated from Paseo, but can send what it loads to the web.";

/** A dropdown and the caption before it, which narrow toolbars drop before the dropdown */
interface Field<Id extends string> {
  element: HTMLLabelElement;
  caption: HTMLSpanElement;
  select: HTMLSelectElement & { value: Id };
}

/**
 * Paseo's Preview | Source control as styled. Computed styles hold for a hidden control too, so
 * any one in the main window serves a companion window; without one the defaults stand in.
 */
function measure(control: HTMLElement | null): SegmentLook {
  const original = control ?? document.querySelector<HTMLElement>('[data-testid="file-preview-mode"]');
  if (!original) return DEFAULT_LOOK;
  const container = getComputedStyle(original);
  const segment = original.firstElementChild;
  const segmentStyle = segment ? getComputedStyle(segment) : container;
  // React Native Web renders Text with dir="auto"
  const label = segment?.querySelector('[dir="auto"]');
  const labelStyle = label ? getComputedStyle(label) : segmentStyle;
  return {
    containerGap: container.columnGap || "4px",
    containerMinHeight: container.minHeight,
    padding: `${segmentStyle.paddingTop} ${segmentStyle.paddingRight} ${segmentStyle.paddingBottom} ${segmentStyle.paddingLeft}`,
    minHeight: segmentStyle.minHeight,
    borderRadius: segmentStyle.borderRadius,
    fontFamily: labelStyle.fontFamily,
    fontSize: labelStyle.fontSize,
    lineHeight: labelStyle.lineHeight,
  };
}

function createField<Id extends string>(
  caption: string,
  testId: string,
  ids: readonly Id[],
  entries: Readonly<Record<Id, { label: string; title: string }>>,
  onChange: (id: Id) => void,
): Field<Id> {
  const element = document.createElement("label");
  element.style.cssText = "display:flex;align-items:center;gap:6px;flex:none;white-space:nowrap;";
  const text = document.createElement("span");
  text.textContent = caption;
  const select = document.createElement("select") as HTMLSelectElement & { value: Id };
  select.setAttribute("data-testid", testId);
  select.style.cssText = [
    "font:inherit",
    // Options take the select's color in the open list, where muted text would read as disabled
    "color:var(--colors-foreground)",
    "color-scheme:var(--color-scheme)",
    "background-color:var(--colors-surface0)",
    "border:1px solid var(--colors-border)",
    "border-radius:6px",
    "height:22px",
    "padding:0 4px",
    "min-width:64px",
    "flex:none",
    "cursor:pointer",
  ].join(";");
  for (const id of ids) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = entries[id].label;
    option.title = entries[id].title;
    select.appendChild(option);
  }
  select.addEventListener("change", () => onChange(select.value));
  element.append(text, select);
  return { element, caption: text, select };
}

export class ToolbarControls {
  readonly element: HTMLDivElement;
  /** Markdown's renderer and palette dropdowns; null for HTML */
  private readonly fields: { renderer: Field<EngineId>; palette: Field<PaletteId> } | null;
  private readonly segments = new Map<Layout, { segment: HTMLDivElement; label: HTMLSpanElement }>();
  /** On/off toggles styled as single segments: scroll sync, and HTML's resources */
  private readonly toggles = new Map<ToggleName, { element: HTMLDivElement; label: HTMLSpanElement }>();
  private shown: ControlsState | null = null;

  /** `original` is Paseo's Preview | Source control (`file-preview-mode`), or null outside a panel */
  constructor(original: HTMLElement | null, setup: ControlsSetup) {
    const { kind } = setup;
    const look = measure(original);

    this.element = document.createElement("div");
    this.element.setAttribute(`data-${kind}-enhancements-controls`, "");
    this.element.style.cssText = [
      "display:flex",
      "align-items:center",
      "gap:8px",
      // Squeezed, the captions and dropdowns would overlap; fitTo drops them instead
      "flex-shrink:0",
      `font-family:${look.fontFamily}`,
      `font-size:${look.fontSize}`,
      "color:var(--colors-foreground-muted)",
      // Electron's titlebar drag region would otherwise swallow clicks
      "-webkit-app-region:no-drag",
    ].join(";");

    if (setup.kind === "markdown") {
      this.fields = {
        renderer: createField("Renderer", "markdown-enhancements-engine", ENGINE_IDS, ENGINES, (engine) =>
          setup.setEngine(engine),
        ),
        palette: createField("Palette", "markdown-enhancements-palette", PALETTE_IDS, PALETTES, (palette) =>
          setup.setPalette(palette),
        ),
      };
      this.element.append(this.fields.renderer.element, this.fields.palette.element);
    } else {
      this.fields = null;
    }

    const addToggle = (name: ToggleName, text: string, title: string, set: (on: boolean) => void) => {
      const element = document.createElement("div");
      element.setAttribute("data-testid", `${kind}-enhancements-${name === "syncScroll" ? "sync-scroll" : name}`);
      element.setAttribute("role", "button");
      element.setAttribute("tabindex", "0");
      element.title = title;
      element.style.cssText = [
        "display:flex",
        "align-items:center",
        "justify-content:center",
        "flex-shrink:0",
        "box-sizing:border-box",
        "cursor:pointer",
        `padding:${look.padding}`,
        `min-height:${look.minHeight}`,
        `border-radius:${look.borderRadius}`,
      ].join(";");
      const label = document.createElement("span");
      label.textContent = text;
      label.style.cssText = `white-space:nowrap;font-size:${look.fontSize};line-height:${look.lineHeight};`;
      element.appendChild(label);
      const toggle = () => set(this.shown?.[name] !== true);
      element.addEventListener("mouseenter", () => this.paintToggle(name, true));
      element.addEventListener("mouseleave", () => this.paintToggle(name, false));
      element.addEventListener("click", toggle);
      element.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        toggle();
      });
      this.element.appendChild(element);
      this.toggles.set(name, { element, label });
    };
    if (setup.kind === "html") addToggle("resources", "Resources", RESOURCES_TITLE, (on) => setup.setResources(on));
    addToggle("syncScroll", "Sync scroll", SYNC_TITLE, (on) => setup.setSyncScroll(on));

    const layoutControl = document.createElement("div");
    layoutControl.setAttribute("data-testid", `${kind}-enhancements-layout`);
    layoutControl.setAttribute("role", "group");
    layoutControl.setAttribute("aria-label", GROUP_LABELS[kind]);
    layoutControl.style.cssText = `display:flex;align-items:center;flex-shrink:0;gap:${look.containerGap};min-height:${look.containerMinHeight};`;
    for (const { value, label: text, title } of LAYOUTS[kind]) {
      const segment = document.createElement("div");
      segment.setAttribute("data-testid", `${kind}-enhancements-layout-${value}`);
      segment.setAttribute("role", "button");
      segment.setAttribute("tabindex", "0");
      segment.title = title;
      segment.style.cssText = [
        "display:flex",
        "align-items:center",
        "justify-content:center",
        "flex-shrink:0",
        "box-sizing:border-box",
        "cursor:pointer",
        `padding:${look.padding}`,
        `min-height:${look.minHeight}`,
        `border-radius:${look.borderRadius}`,
      ].join(";");
      const label = document.createElement("span");
      label.textContent = text;
      label.style.cssText = `white-space:nowrap;font-size:${look.fontSize};line-height:${look.lineHeight};`;
      segment.appendChild(label);
      segment.addEventListener("mouseenter", () => this.paintSegment(value, true));
      segment.addEventListener("mouseleave", () => this.paintSegment(value, false));
      segment.addEventListener("click", () => setup.setLayout(value));
      segment.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        setup.setLayout(value);
      });
      layoutControl.appendChild(segment);
      this.segments.set(value, { segment, label });
    }
    this.element.appendChild(layoutControl);
  }

  /** Shows `state`, touching only what changed since the last call */
  update(state: ControlsState): void {
    const shown = this.shown;
    this.shown = state;
    const fields = this.fields;
    const renderer = state.renderer;
    if (fields && renderer) {
      const before = shown?.renderer;
      if (before?.engine !== renderer.engine) {
        fields.renderer.select.value = renderer.engine;
        fields.renderer.select.title = `Renderer: ${ENGINES[renderer.engine].title}`;
      }
      if (before?.palette !== renderer.palette || before?.paletteApplies !== renderer.paletteApplies) {
        const applies = renderer.paletteApplies;
        const { element, select } = fields.palette;
        select.disabled = !applies;
        // Paseo's renderer draws in Paseo's theme, whichever palette is chosen
        select.value = applies ? renderer.palette : "paseo";
        select.style.cursor = applies ? "pointer" : "default";
        select.title = applies ? `Palette: ${PALETTES[renderer.palette].title}` : PALETTE_ONLY_GITHUB;
        element.style.opacity = applies ? "" : "0.5";
        element.title = applies ? "" : PALETTE_ONLY_GITHUB;
      }
    }
    if (shown?.layout !== state.layout) {
      for (const value of this.segments.keys()) this.paintSegment(value, false);
    }
    for (const name of this.toggles.keys()) if (shown?.[name] !== state[name]) this.paintToggle(name, false);
  }

  /**
   * Drops the dropdowns' captions, then the palette dropdown, then the renderer dropdown, until
   * `row` (the bar holding them) stops overflowing, so Preview | Split | Source keeps its place in
   * narrow panes. HTML's controls are Preview | Split | Source alone.
   */
  fitTo(row: HTMLElement): void {
    const fields = this.fields;
    if (!fields) return;
    for (const [captions, palette, renderer] of [
      ["", "", ""],
      ["none", "", ""],
      ["none", "none", ""],
      ["none", "none", "none"],
    ]) {
      fields.renderer.caption.style.display = captions;
      fields.palette.caption.style.display = captions;
      fields.palette.element.style.display = palette;
      fields.renderer.element.style.display = renderer;
      if (row.scrollWidth <= row.clientWidth) return;
    }
  }

  /** On: surface3 and foreground, as a selected segment; hovered: surface2; else muted */
  private paintToggle(name: ToggleName, hovered: boolean): void {
    const parts = this.toggles.get(name);
    if (!parts) return;
    const on = this.shown?.[name] === true;
    parts.element.setAttribute("aria-pressed", String(on));
    parts.element.style.backgroundColor = on ? "var(--colors-surface3)" : hovered ? "var(--colors-surface2)" : "transparent";
    parts.label.style.color = on ? "var(--colors-foreground)" : "var(--colors-foreground-muted)";
  }

  /** Selected: surface3 and foreground; hovered: surface2; else muted text on no fill */
  private paintSegment(value: Layout, hovered: boolean): void {
    const parts = this.segments.get(value);
    if (!parts) return;
    const selected = this.shown?.layout === value;
    parts.segment.setAttribute("aria-pressed", String(selected));
    parts.segment.style.backgroundColor = selected
      ? "var(--colors-surface3)"
      : hovered
        ? "var(--colors-surface2)"
        : "transparent";
    parts.label.style.color = selected ? "var(--colors-foreground)" : "var(--colors-foreground-muted)";
  }
}
