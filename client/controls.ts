// The Markdown toolbar controls: a labeled renderer dropdown, a labeled color palette dropdown, and
// a Preview | Split | Source control standing in for Paseo's Preview | Source. The stand-in copies
// the size and type of Paseo's control as laid out, and takes its colors from Paseo's CSS
// variables, as Paseo's segmented control does (components/ui/segmented-control.tsx). Paseo's
// style classes cannot be reused: their rules are rewritten in place as the control they belong to
// changes state.
import { ENGINE_IDS, ENGINES, type EngineId, PALETTE_IDS, PALETTES, type PaletteId } from "./palettes";

export type Layout = "preview" | "split" | "source";

const LAYOUTS: readonly { value: Layout; label: string; title: string }[] = [
  { value: "preview", label: "Preview", title: "Rendered Markdown" },
  { value: "split", label: "Split", title: "Source and preview side by side; the preview follows unsaved edits" },
  { value: "source", label: "Source", title: "Markdown source" },
];

export interface ControlsState {
  /** The renderer chosen, which the dropdown shows even where the GitHub renderer stands in for it */
  engine: EngineId;
  /** Whether the palette colors what the view shows, which only the GitHub renderer draws */
  paletteApplies: boolean;
  palette: PaletteId;
  layout: Layout;
}

export interface ControlsActions {
  setEngine(engine: EngineId): void;
  setPalette(palette: PaletteId): void;
  setLayout(layout: Layout): void;
}

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
  private readonly actions: ControlsActions;
  private readonly renderer: Field<EngineId>;
  private readonly palette: Field<PaletteId>;
  private readonly segments = new Map<Layout, { segment: HTMLDivElement; label: HTMLSpanElement }>();
  private shown: ControlsState | null = null;

  /** `original` is Paseo's Preview | Source control (`file-preview-mode`), or null outside a panel */
  constructor(original: HTMLElement | null, actions: ControlsActions) {
    this.actions = actions;
    const look = measure(original);

    this.element = document.createElement("div");
    this.element.setAttribute("data-markdown-enhancements-controls", "");
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

    this.renderer = createField("Renderer", "markdown-enhancements-engine", ENGINE_IDS, ENGINES, (engine) =>
      this.actions.setEngine(engine),
    );
    this.palette = createField("Palette", "markdown-enhancements-palette", PALETTE_IDS, PALETTES, (palette) =>
      this.actions.setPalette(palette),
    );
    this.element.append(this.renderer.element, this.palette.element);

    const layoutControl = document.createElement("div");
    layoutControl.setAttribute("data-testid", "markdown-enhancements-layout");
    layoutControl.setAttribute("role", "group");
    layoutControl.setAttribute("aria-label", "Markdown view");
    layoutControl.style.cssText = `display:flex;align-items:center;flex-shrink:0;gap:${look.containerGap};min-height:${look.containerMinHeight};`;
    for (const { value, label: text, title } of LAYOUTS) {
      const segment = document.createElement("div");
      segment.setAttribute("data-testid", `markdown-enhancements-layout-${value}`);
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
      segment.addEventListener("click", () => this.actions.setLayout(value));
      segment.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        this.actions.setLayout(value);
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
    if (shown?.engine !== state.engine) {
      this.renderer.select.value = state.engine;
      this.renderer.select.title = `Renderer: ${ENGINES[state.engine].title}`;
    }
    if (shown?.palette !== state.palette || shown?.paletteApplies !== state.paletteApplies) {
      const applies = state.paletteApplies;
      const { element, select } = this.palette;
      select.disabled = !applies;
      // Paseo's renderer draws in Paseo's theme, whichever palette is chosen
      select.value = applies ? state.palette : "paseo";
      select.style.cursor = applies ? "pointer" : "default";
      select.title = applies ? `Palette: ${PALETTES[state.palette].title}` : PALETTE_ONLY_GITHUB;
      element.style.opacity = applies ? "" : "0.5";
      element.title = applies ? "" : PALETTE_ONLY_GITHUB;
    }
    if (shown?.layout !== state.layout) {
      for (const value of this.segments.keys()) this.paintSegment(value, false);
    }
  }

  /**
   * Drops the dropdowns' captions, then the palette dropdown, then the renderer dropdown, until
   * `row` (the bar holding them) stops overflowing, so Preview | Split | Source keeps its place in
   * narrow panes
   */
  fitTo(row: HTMLElement): void {
    for (const [captions, palette, renderer] of [
      ["", "", ""],
      ["none", "", ""],
      ["none", "none", ""],
      ["none", "none", "none"],
    ]) {
      this.renderer.caption.style.display = captions;
      this.palette.caption.style.display = captions;
      this.palette.element.style.display = palette;
      this.renderer.element.style.display = renderer;
      if (row.scrollWidth <= row.clientWidth) return;
    }
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
