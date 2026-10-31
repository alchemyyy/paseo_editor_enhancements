// Markdown rendering engines and color palettes. The Paseo engine is Paseo's own preview, which
// always shows Paseo's theme. The GitHub engine is gh-gfm-preview (gfm-engine.ts) laid out as
// gh-gfm-preview lays out its page: github-markdown-css's rules and chroma's code colors, with the
// palette supplying every color those rules read. The Paseo palette reads Paseo's app variables
// (`--colors-*`), which reach the preview's shadow root through inheritance, so it follows
// Paseo's theme without re-rendering.
import { CHROMA_GITHUB_DARK, CHROMA_GITHUB_LIGHT, CHROMA_PALETTE } from "./vendor/gfm-styles.ts";
import {
  GITHUB_BASE_VARIABLES,
  GITHUB_DARK_VARIABLES,
  GITHUB_LIGHT_VARIABLES,
  GITHUB_MARKDOWN_RULES,
} from "./vendor/github-markdown.ts";

export const ENGINE_IDS = ["paseo", "github"] as const;
export type EngineId = (typeof ENGINE_IDS)[number];

export const ENGINES: Readonly<Record<EngineId, { label: string; title: string }>> = {
  paseo: { label: "Paseo", title: "Paseo's own Markdown preview, in Paseo's theme" },
  github: {
    label: "GitHub",
    title: "GitHub Flavored Markdown rendered offline by gh-gfm-preview: goldmark, chroma, Mermaid, MathJax",
  },
};

export const PALETTE_IDS = ["paseo", "github", "taiga-oak"] as const;
export type PaletteId = (typeof PALETTE_IDS)[number];

export const PALETTES: Readonly<Record<PaletteId, { label: string; title: string }>> = {
  paseo: { label: "Paseo", title: "Paseo's current theme colors" },
  github: { label: "GitHub", title: "GitHub's colors, light or dark as Paseo's theme is" },
  "taiga-oak": { label: "Taiga Oak", title: "Dark oak, parchment, and moss green" },
};

export type ColorScheme = "light" | "dark";

type Variables = Readonly<Record<string, string>>;

export function isEngineId(value: unknown): value is EngineId {
  return typeof value === "string" && (ENGINE_IDS as readonly string[]).includes(value);
}

export function isPaletteId(value: unknown): value is PaletteId {
  return typeof value === "string" && (PALETTE_IDS as readonly string[]).includes(value);
}

/** Variables the GitHub engine's rules read beyond those github-markdown-css defines */
const BASE_VARIABLES: Variables = {
  // github-markdown-css names this stack only as a var() fallback
  "--fontStack-sansSerif":
    '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji"',
  "--mde-table-header-bg": "transparent",
};

/**
 * Taiga Oak: dark oak heartwood and parchment, moss-green accents, weathered-oak rules. Colors from
 * the Taiga Oak Paseo theme (background #251b13, foreground #f3e9d8, raised #36281b, control
 * #2c3a25, border #664b33, accent #6f9f55, muted #cfb795, ring #9c7552).
 */
const TAIGA_OAK_VARIABLES: Variables = {
  "color-scheme": "dark",
  "--bgColor-default": "#251b13",
  "--bgColor-muted": "#36281b",
  "--bgColor-neutral-muted": "#664b3366",
  "--bgColor-attention-muted": "#9c755240",
  "--bgColor-danger-muted": "#d9734e26",
  "--fgColor-default": "#f3e9d8",
  "--fgColor-muted": "#cfb795",
  "--fgColor-accent": "#8fbd74",
  "--fgColor-attention": "#d9a441",
  "--fgColor-danger": "#e08a6d",
  "--fgColor-done": "#b39ad1",
  "--fgColor-success": "#8fbd74",
  "--borderColor-default": "#664b33",
  "--borderColor-muted": "#664b33b3",
  "--borderColor-neutral-muted": "#664b33b3",
  "--borderColor-accent-emphasis": "#6f9f55",
  "--borderColor-attention-emphasis": "#c08a2e",
  "--borderColor-danger-emphasis": "#c8603d",
  "--borderColor-done-emphasis": "#9077b5",
  "--borderColor-success-emphasis": "#6f9f55",
  "--focus-outlineColor": "#9c7552",
  "--color-prettylights-syntax-comment": "#9c7552",
  "--color-prettylights-syntax-constant": "#e0b46c",
  "--color-prettylights-syntax-constant-other-reference-link": "#a9c97f",
  "--color-prettylights-syntax-entity": "#e8c992",
  "--color-prettylights-syntax-entity-tag": "#8fbd74",
  "--color-prettylights-syntax-keyword": "#d9885a",
  "--color-prettylights-syntax-string": "#a9c97f",
  "--color-prettylights-syntax-string-regexp": "#c9d98a",
  "--color-prettylights-syntax-variable": "#e0a46c",
  "--color-prettylights-syntax-markup-heading": "#8fbd74",
  "--color-prettylights-syntax-markup-list": "#e0b46c",
  "--color-prettylights-syntax-markup-bold": "#f3e9d8",
  "--color-prettylights-syntax-markup-italic": "#f3e9d8",
  "--color-prettylights-syntax-storage-modifier-import": "#f3e9d8",
  "--color-prettylights-syntax-markup-inserted-text": "#bfe0a4",
  "--color-prettylights-syntax-markup-inserted-bg": "#2c3a25",
  "--color-prettylights-syntax-markup-deleted-text": "#f2b8a2",
  "--color-prettylights-syntax-markup-deleted-bg": "#4a2418",
  "--color-prettylights-syntax-markup-changed-text": "#f0d39a",
  "--color-prettylights-syntax-markup-changed-bg": "#4a3514",
  "--color-prettylights-syntax-meta-diff-range": "#b39ad1",
  "--color-prettylights-syntax-brackethighlighter-angle": "#cfb795",
  "--color-prettylights-syntax-brackethighlighter-unmatched": "#e08a6d",
  "--color-prettylights-syntax-invalid-illegal-text": "#e08a6d",
  "--color-prettylights-syntax-invalid-illegal-bg": "#4a2418",
  "--mde-table-header-bg": "#2c3a25",
};

/** Paseo's app colors under GitHub's names */
const PASEO_VARIABLES: Variables = {
  "color-scheme": "var(--color-scheme)",
  "--bgColor-default": "var(--colors-surface0)",
  "--bgColor-muted": "var(--colors-surface2)",
  "--bgColor-neutral-muted": "var(--colors-surface2)",
  "--bgColor-attention-muted": "color-mix(in srgb, var(--colors-status-warning) 25%, transparent)",
  "--bgColor-danger-muted": "var(--colors-status-danger-tint)",
  "--fgColor-default": "var(--colors-foreground)",
  "--fgColor-muted": "var(--colors-foreground-muted)",
  "--fgColor-accent": "var(--colors-accent-bright)",
  "--fgColor-attention": "var(--colors-status-warning)",
  "--fgColor-danger": "var(--colors-status-danger)",
  "--fgColor-done": "var(--colors-status-merged)",
  "--fgColor-success": "var(--colors-status-success)",
  // Paseo's plain border nearly vanishes against its surfaces in table grids and rules
  "--borderColor-default": "var(--colors-border-accent)",
  "--borderColor-muted": "var(--colors-border)",
  "--borderColor-neutral-muted": "var(--colors-border)",
  "--borderColor-accent-emphasis": "var(--colors-accent-bright)",
  "--borderColor-attention-emphasis": "var(--colors-status-warning)",
  "--borderColor-danger-emphasis": "var(--colors-status-danger)",
  "--borderColor-done-emphasis": "var(--colors-status-merged)",
  "--borderColor-success-emphasis": "var(--colors-status-success)",
  "--focus-outlineColor": "var(--colors-ring)",
  "--color-prettylights-syntax-comment": "var(--colors-syntax-comment)",
  "--color-prettylights-syntax-constant": "var(--colors-syntax-number)",
  "--color-prettylights-syntax-constant-other-reference-link": "var(--colors-syntax-link)",
  "--color-prettylights-syntax-entity": "var(--colors-syntax-function)",
  "--color-prettylights-syntax-entity-tag": "var(--colors-syntax-tag)",
  "--color-prettylights-syntax-keyword": "var(--colors-syntax-keyword)",
  "--color-prettylights-syntax-string": "var(--colors-syntax-string)",
  "--color-prettylights-syntax-string-regexp": "var(--colors-syntax-regexp)",
  "--color-prettylights-syntax-variable": "var(--colors-syntax-variable)",
  "--color-prettylights-syntax-markup-heading": "var(--colors-syntax-heading)",
  "--color-prettylights-syntax-markup-list": "var(--colors-syntax-keyword)",
  "--color-prettylights-syntax-markup-bold": "var(--colors-foreground)",
  "--color-prettylights-syntax-markup-italic": "var(--colors-foreground)",
  "--color-prettylights-syntax-storage-modifier-import": "var(--colors-foreground)",
  "--color-prettylights-syntax-markup-inserted-text": "var(--colors-diff-addition)",
  "--color-prettylights-syntax-markup-inserted-bg": "var(--colors-status-success-tint)",
  "--color-prettylights-syntax-markup-deleted-text": "var(--colors-diff-deletion)",
  "--color-prettylights-syntax-markup-deleted-bg": "var(--colors-status-danger-tint)",
  "--color-prettylights-syntax-markup-changed-text": "var(--colors-status-warning)",
  "--color-prettylights-syntax-markup-changed-bg": "var(--colors-status-warning-tint)",
  "--color-prettylights-syntax-meta-diff-range": "var(--colors-syntax-meta)",
  "--color-prettylights-syntax-brackethighlighter-angle": "var(--colors-syntax-punctuation)",
  "--color-prettylights-syntax-brackethighlighter-unmatched": "var(--colors-status-danger)",
  "--color-prettylights-syntax-invalid-illegal-text": "var(--colors-status-danger)",
  "--color-prettylights-syntax-invalid-illegal-bg": "var(--colors-status-danger-tint)",
  "--mde-table-header-bg": "var(--colors-surface1)",
};

// The scroll container and gh-gfm-preview's page layout (internal/server/template.html): a 920px
// reading column with 45px padding, 15px on narrow panes
const FRAME_RULES = `
:host { all: initial; display: block; }
.mde-root {
  position: absolute; inset: 0; overflow: auto; box-sizing: border-box; container-type: inline-size;
  background-color: var(--bgColor-default); color: var(--fgColor-default);
}
.mde-root > .markdown-body {
  box-sizing: border-box; min-width: 200px; max-width: 920px; margin: 0 auto; padding: 45px;
}
@container (max-width: 767px) { .mde-root > .markdown-body { padding: 15px; } }
.mde-notice {
  box-sizing: border-box; width: calc(100% - 90px); max-width: 830px; margin: 24px auto 0; padding: 8px 12px;
  border: 1px solid var(--borderColor-default); border-radius: 6px; background-color: var(--bgColor-muted);
  color: var(--fgColor-muted); font: 13px/1.5 var(--fontStack-sansSerif);
}
@container (max-width: 767px) { .mde-notice { width: calc(100% - 30px); margin-top: 12px; } }
.mde-status { padding: 45px; color: var(--fgColor-muted); font: 14px var(--fontStack-sansSerif); }
.mde-status[data-error] { color: var(--fgColor-danger); white-space: pre-wrap; }
.markdown-body table th { background-color: var(--mde-table-header-bg); }
.markdown-body img[data-mde-src]:not([src]) { min-width: 16px; min-height: 16px; }
.markdown-body .mde-image-error { outline: 1px dashed var(--fgColor-danger); }
`;

// gh-gfm-preview's page controls (internal/server/template.html), with its fixed dark and light
// colors replaced by the palette's
const PAGE_RULES = `
.markdown-body code.language-mermaid br { display: inline; }
.markdown-body .copy-button {
  background-color: transparent; border: none; position: absolute; top: 8px; right: 8px; z-index: 1;
  border-radius: 5px; padding: 5px; line-height: 0; cursor: pointer;
}
.markdown-body .copy-button svg.copy-icon { stroke: var(--fgColor-muted); }
.markdown-body .copy-button svg.tick-icon { stroke: var(--fgColor-success); }
.markdown-body pre.diagram-mermaid-pre { padding: 0; overflow: hidden; }
.markdown-body pre.diagram-mermaid-pre > code.diagram-mermaid-code {
  display: block; padding: 0; background: transparent; overflow: hidden; cursor: grab;
  touch-action: none; user-select: none;
}
.mermaid-reset-btn {
  background-color: transparent; border: 1px solid var(--borderColor-default); bottom: 8px;
  border-radius: 5px; color: var(--fgColor-muted); cursor: pointer; font-size: 12px; line-height: 1.4;
  padding: 3px 8px; position: absolute; right: 8px; transition: border-color 0.2s ease, color 0.2s ease;
  z-index: 1;
}
.mermaid-reset-btn:hover { border-color: var(--fgColor-muted); color: var(--fgColor-default); }
.mermaid-expand-btn {
  background-color: transparent; border: none; cursor: pointer; left: 8px; padding: 5px;
  position: absolute; top: 8px; z-index: 1;
}
.mermaid-expand-btn svg { display: block; fill: var(--fgColor-muted); transition: fill 0.2s ease; }
.mermaid-expand-btn:hover svg { fill: var(--fgColor-default); }
.mermaid-overlay { background-color: rgba(0, 0, 0, 0.85); display: none; inset: 0; position: absolute; z-index: 2; }
.mermaid-overlay.is-open { display: block; }
.mermaid-overlay-inner {
  cursor: grab; height: 100%; overflow: hidden; touch-action: none; user-select: none; width: 100%;
}
.mermaid-overlay-inner svg { background-color: var(--bgColor-default); }
.mermaid-overlay-close {
  background-color: transparent; border: 1px solid var(--borderColor-default); border-radius: 5px;
  color: var(--fgColor-muted); cursor: pointer; font-size: 18px; line-height: 1; padding: 4px 10px;
  position: absolute; right: 16px; top: 16px; transition: border-color 0.2s ease, color 0.2s ease;
  z-index: 1;
}
.mermaid-overlay-close:hover { border-color: var(--fgColor-muted); color: var(--fgColor-default); }
.mermaid-overlay .mermaid-reset-btn { bottom: 16px; right: 16px; }
.markdown-body pre.diagram-map-pre { padding: 0; overflow: hidden; }
.markdown-body pre.diagram-map-pre > code.diagram-map-code {
  display: block; padding: 0; background: transparent; overflow: hidden;
}
.leaflet-diagram-map { height: 310px; min-height: 310px; width: 100%; background: var(--bgColor-muted); }
.leaflet-diagram-map .leaflet-control-attribution, .leaflet-diagram-map .leaflet-control-zoom a { font-size: 11px; }
@container (max-width: 767px) { .leaflet-diagram-map { height: 260px; min-height: 260px; } }
`;

/** Whether a palette is light or dark while Paseo's theme is `paseoScheme` */
export function paletteScheme(palette: PaletteId, paseoScheme: ColorScheme): ColorScheme {
  return palette === "taiga-oak" ? "dark" : paseoScheme;
}

/** The variable sets a palette layers, in order; later sets win */
export function paletteLayers(palette: PaletteId, paseoScheme: ColorScheme): Variables[] {
  const scheme = paletteScheme(palette, paseoScheme);
  const github = scheme === "dark" ? GITHUB_DARK_VARIABLES : GITHUB_LIGHT_VARIABLES;
  switch (palette) {
    case "github":
      return [GITHUB_BASE_VARIABLES, BASE_VARIABLES, github, { "color-scheme": scheme }];
    case "paseo":
      return [GITHUB_BASE_VARIABLES, BASE_VARIABLES, github, PASEO_VARIABLES];
    case "taiga-oak":
      // Taiga Oak's colors fill the variables GitHub's dark scheme defines but it leaves alone
      return [GITHUB_BASE_VARIABLES, BASE_VARIABLES, github, TAIGA_OAK_VARIABLES];
  }
}

/** The GitHub engine preview's whole shadow-root stylesheet in a palette */
export function previewStylesheet(palette: PaletteId, paseoScheme: ColorScheme): string {
  const merged: Record<string, string> = Object.assign({}, ...paletteLayers(palette, paseoScheme));
  const declarations = Object.entries(merged)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join("\n");
  // The GitHub palette shows gh-gfm-preview's own chroma colors; the rest map them to theirs
  const chroma =
    palette === "github"
      ? paletteScheme(palette, paseoScheme) === "dark"
        ? CHROMA_GITHUB_DARK
        : CHROMA_GITHUB_LIGHT
      : CHROMA_PALETTE;
  return `${FRAME_RULES}\n.mde-root {\n${declarations}\n}\n${GITHUB_MARKDOWN_RULES}\n${chroma}\n${PAGE_RULES}`;
}

/** Paseo's current color scheme, from the app's CSS variables */
export function paseoColorScheme(): ColorScheme {
  return getComputedStyle(document.documentElement).getPropertyValue("--color-scheme").trim() === "light"
    ? "light"
    : "dark";
}

/**
 * A `:root` rule with Paseo's current theme variables (`--colors-*`, `--fontFamily-*`, ...), for
 * windows the app's stylesheets do not reach, such as companion editor windows
 */
export function paseoVariablesRule(): string {
  const style = getComputedStyle(document.documentElement);
  const declarations = Array.from(style)
    .filter((name) => name.startsWith("--"))
    .map((name) => `${name}: ${style.getPropertyValue(name).trim()};`)
    .join(" ");
  return `:root { ${declarations} }`;
}
