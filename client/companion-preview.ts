// Markdown and HTML in a companion window: the same Preview | Split | Source as the main window's
// toolbar, and for Markdown its renderer and palette dropdowns, for one companion tab. Paseo's own
// previews exist only in the main window, so companion windows render Markdown with the GitHub
// renderer, saying so when Paseo's renderer is chosen, and HTML in the plugin's sandboxed page. The
// tab's editor stays mounted; Preview hides it and Split narrows it, with the preview beside it fed
// from the editor's unsaved text. Preferences are shared with the main window.
import { type Layout, ToolbarControls } from "./controls";
import { editorScrollPosition } from "./editor-scroll";
import type { PanelKind } from "./fiber";
import type { GfmEngine } from "./gfm-engine";
import { backendFor, type HostRegistry } from "./hosts";
import { HtmlPage } from "./html-page";
import { imageUrl } from "./images";
import { paseoColorScheme, paseoVariablesRule } from "./palettes";
import { previewPrefs, splitChoice, syncChoice, syncsScroll } from "./prefs";
import { PreviewPane } from "./preview";
import { classifyReference, splitLocalTarget } from "./references";
import { watchPaseoTheme } from "./theme-watch";

/** The files Paseo gives a Preview, by extension as its file panel catalog matches them */
const PREVIEW_PATHS: readonly (readonly [PanelKind, RegExp])[] = [
  ["markdown", /\.(md|markdown)$/i],
  ["html", /\.html?$/i],
];
const VARIABLES_STYLE_ATTRIBUTE = "data-markdown-enhancements-variables";
const PASEO_RENDERER_NOTICE =
  "Paseo's renderer runs only in Paseo's main window, so the GitHub renderer shows this window's preview.";

export interface CompanionPreviewFile {
  serverId: string;
  workspaceId: string;
  /** The tab's path, workspace-relative or absolute */
  path: string;
}

export interface CompanionPreviewInput {
  file: CompanionPreviewFile;
  /** The tab's content area; its first child is the editor (or read-only rows) */
  container: HTMLElement;
  /** The tab's current text, unsaved edits included */
  text(): string;
  /** The layout to open in: one handed over from the main window, else the remembered default */
  layout: Layout | null;
}

export interface CompanionPreview {
  /** The toolbar controls, for the companion's info bar while this tab is active */
  readonly controls: HTMLElement;
  readonly layout: Layout;
  /** The editor's text changed */
  textChanged(): void;
  /** The window or its bar resized; drops controls that no longer fit in `row` */
  fit(row: HTMLElement): void;
  dispose(): void;
}

export type CompanionPreviewFactory = (input: CompanionPreviewInput) => CompanionPreview | null;

/** Paseo's theme variables in a companion document, which the app's stylesheets do not reach */
function syncVariables(doc: Document): void {
  let style = doc.head.querySelector<HTMLStyleElement>(`style[${VARIABLES_STYLE_ATTRIBUTE}]`);
  if (!style) {
    style = doc.createElement("style");
    style.setAttribute(VARIABLES_STYLE_ATTRIBUTE, "");
    doc.head.appendChild(style);
  }
  const rule = paseoVariablesRule();
  if (style.textContent !== rule) style.textContent = rule;
}

/**
 * Builds the controls and preview for companion tabs of Markdown and HTML files. `openFile` shows
 * a file a Markdown link points to in the main window.
 */
export function companionPreviewFactory(
  registry: HostRegistry,
  engine: GfmEngine,
  openFile: (file: CompanionPreviewFile, lineStart?: number, lineEnd?: number) => void,
): CompanionPreviewFactory {
  return (input) => {
    const kind = PREVIEW_PATHS.find(([, pattern]) => pattern.test(input.file.path))?.[0];
    if (!kind) return null;
    const prefs = previewPrefs();
    const { file, container } = input;
    const doc = container.ownerDocument;
    const backend = () => backendFor(registry, file.workspaceId);
    const reference = (value: string) => ({ workspaceId: file.workspaceId, markdownPath: file.path, reference: value });
    // A companion window is an editor: a tab arriving on Preview, or with no layout, opens in Split,
    // so its editor shows; Source stays Source. Preview can still be chosen.
    let layout: Layout = input.layout === "source" ? "source" : "split";
    let preview: PreviewPane | HtmlPage | null = null;
    let scroller: HTMLElement | null = null;
    let restyled: { element: HTMLElement; display: string; width: string } | null = null;
    let disposed = false;
    let fitRow: HTMLElement | null = null;

    const follow = () => {
      if (layout !== "split" || !scroller || !preview || !syncsScroll(prefs.get(), kind)) return;
      preview.follow(editorScrollPosition(scroller));
    };
    let followFrame = false;
    const onEditorScroll = () => {
      if (followFrame) return;
      followFrame = true;
      // This window's frames: the main window's pause while it is minimized
      (doc.defaultView ?? window).requestAnimationFrame(() => {
        followFrame = false;
        follow();
      });
    };
    const watchScroll = (next: HTMLElement | null) => {
      if (next === scroller) return;
      scroller?.removeEventListener("scroll", onEditorScroll);
      scroller = next;
      scroller?.addEventListener("scroll", onEditorScroll, { passive: true });
      if (scroller) onEditorScroll();
    };

    const createPreview = (): PreviewPane | HtmlPage => {
      const resizeSplit = (ratio: number) => prefs.update({ splitRatio: ratio });
      if (kind === "html") {
        return new HtmlPage({
          resizeSplit,
          readResource: async (value) => {
            const host = await backend();
            if (!host) throw new Error("No Paseo host has this workspace");
            return host.readResource(reference(value));
          },
        });
      }
      return new PreviewPane(
        {
          imageUrl: (value) =>
            imageUrl(`${file.serverId}|${file.workspaceId}|${file.path}|${value}`, value, async (source) => {
              const host = await backend();
              if (!host) throw new Error("No Paseo host has this workspace");
              return host.readImage(reference(source));
            }),
          openLocal: (target) => {
            const { path, lineStart, lineEnd } = splitLocalTarget(target);
            if (!path) return;
            void backend().then(async (host) => {
              const resolved = await host?.resolveLink(reference(path)).catch(() => null);
              if (resolved?.kind === "file" && resolved.path) {
                openFile({ ...file, path: resolved.path }, lineStart, lineEnd);
              }
            });
          },
          openExternal: (url) => {
            if (classifyReference(url) === "external") void backend().then((host) => host?.openExternal(url));
          },
          resizeSplit,
          rendered: follow,
        },
        engine,
      );
    };

    const restore = () => {
      if (!restyled) return;
      restyled.element.style.display = restyled.display;
      restyled.element.style.width = restyled.width;
      restyled = null;
    };

    const setLayout = (next: Layout) => {
      layout = next;
      prefs.update(splitChoice(kind, next));
      apply();
    };
    const setSyncScroll = (on: boolean) => {
      prefs.update(syncChoice(kind, on));
      if (on) follow();
    };
    const controls =
      kind === "html"
        ? new ToolbarControls(null, {
            kind: "html",
            setLayout,
            setSyncScroll,
            setResources: (on) => prefs.update({ htmlResources: on }),
          })
        : new ToolbarControls(null, {
            kind: "markdown",
            setEngine: (chosen) => prefs.update({ engine: chosen }),
            setPalette: (palette) => prefs.update({ palette }),
            setLayout,
            setSyncScroll,
          });

    const apply = () => {
      if (disposed) return;
      const { engine: chosen, palette, splitRatio, htmlResources: resources } = prefs.get();
      syncVariables(doc);
      const syncScroll = syncsScroll(prefs.get(), kind);
      controls.update(
        kind === "html"
          ? { layout, syncScroll, resources }
          : { layout, syncScroll, renderer: { engine: chosen, paletteApplies: true, palette } },
      );
      if (fitRow?.contains(controls.element)) controls.fitTo(fitRow);
      let content: HTMLElement | null = null;
      for (const child of Array.from(container.children)) {
        if (child !== preview?.element) {
          content = child as HTMLElement;
          break;
        }
      }
      if (restyled && restyled.element !== content) restore();
      if (layout === "source" || !content) {
        restore();
        watchScroll(null);
        preview?.destroy();
        preview = null;
        return;
      }
      const split = layout === "split";
      const percent = `${(splitRatio * 100).toFixed(2)}%`;
      restyled ??= { element: content, display: content.style.display, width: content.style.width };
      content.style.display = split ? restyled.display : "none";
      content.style.width = split ? percent : restyled.width;
      if (!preview) {
        preview = createPreview();
        container.appendChild(preview.element);
        if (preview instanceof HtmlPage) preview.setResources(resources);
        preview.setText(input.text());
      }
      if (preview instanceof PreviewPane) {
        preview.setPalette(palette, paseoColorScheme());
        preview.setNotice(chosen === "paseo" ? PASEO_RENDERER_NOTICE : null);
      } else {
        preview.setResources(resources);
      }
      preview.setBounds(0, split ? percent : "0px", split);
      watchScroll(split ? content.querySelector<HTMLElement>(".cm-scroller") : null);
    };

    // Preferences change from either window, and Paseo's theme from its settings or the system
    const unsubscribe = prefs.subscribe(apply);
    const stopThemeWatch = watchPaseoTheme(apply);

    container.style.position = "relative";
    apply();

    return {
      controls: controls.element,
      get layout() {
        return layout;
      },
      textChanged: () => preview?.setText(input.text()),
      fit: (row) => {
        fitRow = row;
        controls.fitTo(row);
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        unsubscribe();
        stopThemeWatch();
        watchScroll(null);
        preview?.destroy();
        preview = null;
        restore();
        controls.element.remove();
      },
    };
  };
}
