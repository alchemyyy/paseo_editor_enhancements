// NOTE: App-internal DOM augmentation of Paseo's built-in Markdown and HTML file panels
// (packages/app/src/file-panels: builtin.tsx, source/panel.tsx, source/toolbar.tsx), one text file
// panel with a different Preview. The toolbar gets Preview | Split | Source in place of
// Preview | Source, and Markdown's also a renderer dropdown and a color palette dropdown.
//
//   Markdown, Paseo renderer   Preview is Paseo's own preview, untouched. Split keeps Paseo's
//                              preview on the right and puts an editor cloned from Paseo's Source
//                              editor (split-editor.ts), bound to the panel's buffer, on the left.
//   Markdown, GitHub renderer  Preview hides Paseo's preview behind the plugin's gh-gfm-preview
//                              rendering (preview.ts). Split keeps Paseo's Source editor (its
//                              buffer, autosave, and conflict handling) on the left, narrowed, with
//                              that rendering beside it, fed from the unsaved buffer.
//   HTML                       Preview is Paseo's own sandboxed page, untouched. Split keeps Paseo's
//                              Source editor on the left, narrowed, with the plugin's own sandboxed
//                              page (html-page.ts) beside it, fed from the unsaved buffer.
//
// Where Paseo's renderer cannot show a Markdown Split, the GitHub renderer shows it, saying why.
import { type CmView, findEditorView } from "./companion-editor";
import { type Layout, ToolbarControls } from "./controls";
import { type EditorScrollPosition, editorScrollPosition, findEditorScroller } from "./editor-scroll";
import { findPaneBridge, findSetView, findTextPanel, type PanelKind, type SetView, type TextFileView, type TextPanelInfo } from "./fiber";
import type { GfmEngine } from "./gfm-engine";
import { backendFor, type HostRegistry } from "./hosts";
import { HtmlPage } from "./html-page";
import { imageUrl } from "./images";
import { type EngineId, paseoColorScheme } from "./palettes";
import { opensInSplit, previewPrefs, splitChoice, syncChoice, syncsScroll, takeLayout } from "./prefs";
import { PreviewPane } from "./preview";
import { classifyReference, splitLocalTarget } from "./references";
import { SplitEditor } from "./split-editor";
import { paseoSurface, watchPaseoTheme } from "./theme-watch";

const BAR_SELECTOR = '[data-testid="file-panel-bar"]';
const VIEW_CONTROL_SELECTOR = '[data-testid="file-preview-mode"]';
const PREVIEW_SEGMENT_SELECTOR = '[data-testid="file-mode-preview"]';
/** A requested view not applied by then is treated as refused */
const VIEW_REQUEST_TIMEOUT_MS = 1000;
/** Elements searched for the scroll container of Paseo's preview */
const SCROLLER_SEARCH_LIMIT = 200;
/** How soon to look again at an editor still drawn in the theme Paseo just left */
const THEME_SETTLE_MS = 150;
const READ_ONLY_SPLIT =
  "Paseo's renderer sits beside an editor only in files Paseo can edit, and this one opens read-only, so the GitHub renderer shows this Split.";

function copyFailedNotice(reason: string): string {
  return `Paseo's editor could not be copied to sit beside Paseo's renderer (${reason}), so the GitHub renderer shows this Split. Choosing a renderer or view tries again.`;
}

/** Paseo's content view as it was before this plugin hid, narrowed, or shifted it */
interface Restyled {
  element: HTMLElement;
  display: string;
  width: string;
  marginLeft: string;
}

/** Where an editor's cursor and scroll were, for the next editor of the panel to start from */
interface EditorPlace {
  head: number;
  scrollTop: number;
}

interface Panel {
  bar: HTMLElement;
  info: TextPanelInfo;
  setView: SetView;
  /** Paseo's Preview | Source control, hidden behind ours */
  original: HTMLElement;
  controls: ToolbarControls;
  layout: Layout;
  requestedView: { view: TextFileView; at: number } | null;
  /** The GitHub renderer's rendering, in Preview or beside Paseo's Source editor */
  preview: PreviewPane | null;
  /** An HTML Split's page, beside Paseo's Source editor */
  page: HtmlPage | null;
  /** The Paseo renderer's Split editor, beside Paseo's preview */
  splitEditor: SplitEditor | null;
  restyled: Restyled | null;
  stopText: (() => void) | null;
  editorScroller: HTMLElement | null;
  /** The scroll container of Paseo's preview, which the Paseo renderer's Split follows */
  paseoScroller: HTMLElement | null;
  /** Cursor and scroll for the next editor that appears: Paseo's Source editor or the Split editor */
  carry: EditorPlace | null;
  /** The view Paseo showed at the last look, to tell its own switches from the ones asked of it */
  seenView: TextFileView;
  resizeObserver: ResizeObserver;
  /** Toolbar width, view, and renderer the controls were last fitted to */
  fittedFor: string | null;
  /** Why Paseo's editor could not be copied for the Paseo renderer's Split, until chosen again */
  copyFailure: string | null;
}

/**
 * The newest Source editor Paseo showed for a Markdown file, and the background it was drawn
 * with. The Paseo renderer's Split editors copy it; a destroyed editor still serves, its classes and
 * extensions unchanged.
 */
let template: { view: CmView; background: string } | null = null;

/** The background an editor draws: Paseo's surface color in the theme the editor was built in */
function editorBackground(view: CmView): string {
  // The editor's root element, a well-known part of every EditorView
  return getComputedStyle(view.dom as HTMLElement).backgroundColor;
}

/**
 * Whether the template was drawn in the theme Paseo shows now. A theme switch reaches Paseo's CSS
 * variables before its editors, so the colors compare, not the moment of the switch.
 */
function templateIsCurrent(): boolean {
  return template !== null && template.background === paseoSurface();
}

/** Identifies a file across windows, as companion windows do: `serverId:workspaceId:path` */
function panelKey(info: TextPanelInfo): string {
  return `${info.serverId}:${info.workspaceId}:${info.path}`;
}

/** Each open Markdown or HTML panel's layout and view setter, by panelKey */
const openPanels = new Map<string, { layout: Layout; setView: SetView }>();

/** The layout an open Markdown or HTML panel shows for `key` (`serverId:workspaceId:path`), if one is open */
export function panelLayoutOf(key: string): Layout | null {
  return openPanels.get(key)?.layout ?? null;
}

/**
 * Switches an open Markdown or HTML panel to Paseo's Source view, which mounts its editor (a
 * companion window clones it). The panel's layout follows to Source as for any switch Paseo makes
 * itself.
 */
export function revealPanelSource(key: string): void {
  openPanels.get(key)?.setView("source");
}

/** The renderer a panel shows: the chosen one, or the GitHub renderer and why, where Paseo's cannot */
function engineFor(panel: Panel, chosen: EngineId): { engine: EngineId; notice: string | null } {
  if (chosen === "github" || panel.layout !== "split") return { engine: chosen, notice: null };
  if (!panel.info.model) return { engine: "github", notice: READ_ONLY_SPLIT };
  if (panel.copyFailure) return { engine: "github", notice: copyFailedNotice(panel.copyFailure) };
  return { engine: "paseo", notice: null };
}

/** The view Paseo's panel shows under each layout and renderer */
function viewFor(layout: Layout, engine: EngineId): TextFileView {
  if (layout === "source") return "source";
  if (layout === "preview") return "preview";
  // The Paseo renderer's Split shows Paseo's preview, once Paseo's editor has been seen to copy
  return engine === "paseo" && templateIsCurrent() ? "preview" : "source";
}

/** The first scrolling element under `root`, as React Native Web renders a ScrollView */
function findScrollContainer(root: HTMLElement): HTMLElement | null {
  const queue: HTMLElement[] = [root];
  for (let visited = 0; queue.length > 0 && visited < SCROLLER_SEARCH_LIMIT; visited++) {
    const element = queue.shift() as HTMLElement;
    const { overflowY } = getComputedStyle(element);
    if ((overflowY === "auto" || overflowY === "scroll") && element.scrollHeight > element.clientHeight) return element;
    queue.push(...(Array.from(element.children) as HTMLElement[]));
  }
  return null;
}

/** Scrolls Paseo's preview to the editor's share of its document; it carries no source lines */
function followByRatio(scroller: HTMLElement, position: EditorScrollPosition): void {
  const maximum = scroller.scrollHeight - scroller.clientHeight;
  scroller.scrollTop = position.atTop ? 0 : position.atBottom ? maximum : position.ratio * maximum;
}

/** Augments every built-in Markdown and HTML panel until the returned stop function runs */
export function startTextPanels(registry: HostRegistry, engine: GfmEngine): () => void {
  const prefs = previewPrefs();
  const panels = new Map<HTMLElement, Panel>();
  /** Toolbars of other panels (Source, plugin panels), never inspected again */
  const ignored = new WeakSet<HTMLElement>();
  /** A look scheduled for after Paseo restyles its editors */
  let settleTimer: ReturnType<typeof setTimeout> | undefined;

  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      scan();
    });
  };

  const backend = (panel: Panel) => backendFor(registry, panel.info.workspaceId);

  const reference = (panel: Panel, value: string) => ({
    workspaceId: panel.info.workspaceId,
    markdownPath: panel.info.path,
    reference: value,
  });

  const openLocal = async (panel: Panel, target: string, side: boolean) => {
    const { path, lineStart, lineEnd } = splitLocalTarget(target);
    const host = await backend(panel);
    if (!host || !path) return;
    const resolved = await host.resolveLink(reference(panel, path)).catch(() => null);
    if (resolved?.kind !== "file" || !resolved.path) return;
    findPaneBridge(panel.bar)?.openFileInWorkspace({
      location: { path: resolved.path, lineStart, lineEnd },
      disposition: side ? "side" : "main",
    });
  };

  /** A Split's rendering follows the editor's scroll, while scroll sync is on for the panel's kind */
  const followEditor = (panel: Panel) => {
    if (panel.layout !== "split" || !syncsScroll(prefs.get(), panel.info.kind)) return;
    const rendering = panel.preview ?? panel.page;
    if (panel.editorScroller && rendering) {
      rendering.follow(editorScrollPosition(panel.editorScroller));
      return;
    }
    // The Paseo renderer's Split: Paseo's preview follows the copied editor
    const position = panel.splitEditor?.position();
    if (!position) return;
    if (!panel.paseoScroller?.isConnected) panel.paseoScroller = panel.restyled ? findScrollContainer(panel.restyled.element) : null;
    if (panel.paseoScroller) followByRatio(panel.paseoScroller, position);
  };

  /** Turns scroll sync on or off for every panel of `kind`; turned on, Splits follow at once */
  const setSyncScroll = (kind: PanelKind, on: boolean) => {
    prefs.update(syncChoice(kind, on));
    if (!on) return;
    for (const panel of panels.values()) if (panel.info.kind === kind) followEditor(panel);
  };

  const handleEditorScroll = new WeakMap<Panel, () => void>();

  const watchEditorScroll = (panel: Panel, scroller: HTMLElement | null) => {
    if (panel.editorScroller === scroller) return;
    const listener = handleEditorScroll.get(panel);
    if (panel.editorScroller && listener) panel.editorScroller.removeEventListener("scroll", listener);
    panel.editorScroller = scroller;
    if (!scroller) return;
    let frame = false;
    const next = () => {
      if (frame) return;
      frame = true;
      requestAnimationFrame(() => {
        frame = false;
        followEditor(panel);
      });
    };
    handleEditorScroll.set(panel, next);
    scroller.addEventListener("scroll", next, { passive: true });
    next();
  };

  /** Feeds a rendering the editor buffer, unsaved edits included, or the file for read-only panels */
  const followText = (panel: Panel, rendering: { setText(text: string): void }) => {
    const { model, file } = panel.info;
    if (model) {
      const update = () => rendering.setText(model.getSnapshot().content);
      const unsubscribe = model.subscribe(update);
      update();
      return unsubscribe;
    }
    let stopped = false;
    const read = () =>
      void file.readText().then(
        (text) => !stopped && rendering.setText(text),
        () => undefined,
      );
    const unwatch = file.watch(read);
    read();
    return () => {
      stopped = true;
      unwatch();
    };
  };

  const createPreview = (panel: Panel) =>
    new PreviewPane(
      {
        imageUrl: (value) => {
          const key = `${panel.info.serverId}|${panel.info.workspaceId}|${panel.info.path}|${value}`;
          return imageUrl(key, value, async (source) => {
            const host = await backend(panel);
            if (!host) throw new Error("No Paseo host has this workspace");
            return host.readImage(reference(panel, source));
          });
        },
        openLocal: (target, side) => void openLocal(panel, target, side),
        openExternal: (url) => {
          if (classifyReference(url) !== "external") return;
          void backend(panel).then((host) => host?.openExternal(url));
        },
        resizeSplit: (ratio) => prefs.update({ splitRatio: ratio }),
        rendered: () => followEditor(panel),
      },
      engine,
    );

  /** Removes the plugin's rendering of a panel: the GitHub renderer's, or an HTML Split's page */
  const removeRendering = (panel: Panel) => {
    panel.stopText?.();
    panel.stopText = null;
    watchEditorScroll(panel, null);
    panel.preview?.destroy();
    panel.preview = null;
    panel.page?.destroy();
    panel.page = null;
  };

  const removeSplitEditor = (panel: Panel) => {
    if (!panel.splitEditor) return;
    // Paseo's Source editor, or the next Split, starts where this editor was
    panel.carry = panel.splitEditor.state();
    panel.splitEditor.destroy();
    panel.splitEditor = null;
    panel.paseoScroller = null;
  };

  const restore = (panel: Panel) => {
    const restyled = panel.restyled;
    if (!restyled) return;
    restyled.element.style.display = restyled.display;
    restyled.element.style.width = restyled.width;
    restyled.element.style.marginLeft = restyled.marginLeft;
    panel.restyled = null;
  };

  /** Hides Paseo's content view, narrows it to the left of a Split, or shifts it to the right */
  const restyle = (panel: Panel, element: HTMLElement, style: Partial<Omit<Restyled, "element">>) => {
    if (panel.restyled && panel.restyled.element !== element) restore(panel);
    panel.restyled ??= {
      element,
      display: element.style.display,
      width: element.style.width,
      marginLeft: element.style.marginLeft,
    };
    const target = { ...panel.restyled, ...style };
    if (element.style.display !== target.display) element.style.display = target.display;
    if (element.style.width !== target.width) element.style.width = target.width;
    if (element.style.marginLeft !== target.marginLeft) element.style.marginLeft = target.marginLeft;
  };

  /** Refits the controls when the toolbar's width, view, or renderer changed, or it overflows */
  const fitControls = (panel: Panel, fitFor: string) => {
    const row = panel.controls.element.parentElement;
    if (!row) return;
    if (panel.fittedFor === fitFor && row.scrollWidth <= row.clientWidth) return;
    panel.fittedFor = fitFor;
    panel.controls.fitTo(row);
  };

  const currentView = (panel: Panel): TextFileView =>
    panel.original.querySelector(PREVIEW_SEGMENT_SELECTOR)?.getAttribute("aria-selected") === "true"
      ? "preview"
      : "source";

  /** The view Paseo's panel shows under the panel's layout and, for Markdown, the renderer shown */
  const wantedView = (panel: Panel): TextFileView => {
    // HTML's Split narrows Paseo's Source editor; its Preview is Paseo's own
    if (panel.info.kind === "html") return panel.layout === "preview" ? "preview" : "source";
    return viewFor(panel.layout, engineFor(panel, prefs.get().engine).engine);
  };

  /** Asks Paseo for the view a panel's layout and renderer show */
  const requestView = (panel: Panel) => {
    const wanted = wantedView(panel);
    if (currentView(panel) === wanted) return;
    panel.requestedView = { view: wanted, at: Date.now() };
    panel.setView(wanted);
  };

  const setLayout = (panel: Panel, layout: Layout) => {
    panel.layout = layout;
    panel.copyFailure = null;
    prefs.update(splitChoice(panel.info.kind, layout));
    reconcile(panel);
  };

  /** Picks up the buffer of a panel whose toolbar showed before its editable view held one */
  const refreshModel = (panel: Panel) => {
    const model = findTextPanel(panel.bar)?.model;
    if (!model) return;
    panel.info = { ...panel.info, model };
    // A rendering fed from the file on disk follows the buffer from now on
    const rendering = panel.preview ?? panel.page;
    if (rendering) {
      panel.stopText?.();
      panel.stopText = followText(panel, rendering);
    }
  };

  /** Paseo's Source editor of the panel, when it shows one */
  const liveEditor = (content: HTMLElement | null): CmView | null => (content ? findEditorView(content) : null);

  /**
   * HTML: Paseo's Source as it is; Split narrows the Source editor, the page beside it. Preview is
   * Paseo's own, unless the page may load resources: Paseo's preview cannot, so the plugin's page
   * covers it.
   */
  const reconcileHtml = (
    panel: Panel,
    shownView: TextFileView,
    chrome: HTMLElement | null,
    container: HTMLElement | null,
    content: HTMLElement | null,
  ) => {
    let view = shownView;
    const wanted = wantedView(panel);
    if (view !== wanted && !panel.requestedView) {
      requestView(panel);
      view = currentView(panel);
    }
    const { splitRatio, htmlResources: resources } = prefs.get();
    panel.seenView = view;
    panel.controls.update({ layout: panel.layout, syncScroll: syncsScroll(prefs.get(), "html"), resources });
    openPanels.set(panelKey(panel.info), { layout: panel.layout, setView: panel.setView });
    fitControls(panel, `${panel.bar.clientWidth}|${view}`);

    const settled = view === wanted;
    const split = panel.layout === "split";
    const showsPage = split || (panel.layout === "preview" && resources);
    if (!settled || !showsPage || !chrome || !container || !content) {
      if (settled) restore(panel);
      removeRendering(panel);
      return;
    }
    const percent = `${(splitRatio * 100).toFixed(2)}%`;
    restyle(panel, content, split ? { width: percent } : { display: "none" });
    if (!panel.page) {
      panel.page = new HtmlPage({
        resizeSplit: (ratio) => prefs.update({ splitRatio: ratio }),
        readResource: async (value) => {
          const host = await backend(panel);
          if (!host) throw new Error("No Paseo host has this workspace");
          return host.readResource(reference(panel, value));
        },
      });
      container.appendChild(panel.page.element);
      panel.page.setResources(resources);
      panel.stopText = followText(panel, panel.page);
    } else if (panel.page.element.parentElement !== container) {
      container.appendChild(panel.page.element);
    }
    panel.page.setResources(resources);
    panel.page.setBounds(chrome.offsetHeight, split ? percent : "0px", split);
    watchEditorScroll(panel, split ? findEditorScroller(content) : null);
  };

  const reconcile = (panel: Panel) => {
    if (!panel.info.model) refreshModel(panel);
    let view = currentView(panel);
    const request = panel.requestedView;
    const refused = request !== null && view !== request.view && Date.now() - request.at > VIEW_REQUEST_TIMEOUT_MS;
    if (request && (view === request.view || refused)) panel.requestedView = null;
    // Paseo switched views itself (opening a line target shows Source), or did not take a request
    if ((request === null && view !== panel.seenView) || refused) {
      panel.layout = view;
      // The view Paseo chose wins over the place an earlier editor left off
      panel.carry = null;
    }
    const chrome = panel.bar.parentElement;
    const container = chrome?.parentElement ?? null;
    let content: HTMLElement | null = null;
    for (let node = chrome?.nextElementSibling ?? null; node; node = node.nextElementSibling) {
      const ours = node === panel.preview?.element || node === panel.page?.element || node === panel.splitEditor?.element;
      if (!ours && node instanceof HTMLElement) {
        content = node;
        break;
      }
    }
    if (panel.info.kind === "html") {
      reconcileHtml(panel, view, chrome, container, content);
      return;
    }
    const { engine: chosen, palette, splitRatio } = prefs.get();

    // An editor copied before Paseo's theme changed shows the old colors; copy one in the new theme
    if (panel.splitEditor && !templateIsCurrent()) removeSplitEditor(panel);

    // Paseo's Source editor: the copy the Paseo renderer's Split edits with, and where to carry
    // the place an earlier editor left off. Only an editable panel's editor serves as the copy: a
    // read-only panel's editor carries its read-only setup into every copy.
    const editor = view === "source" ? liveEditor(content) : null;
    if (editor && panel.info.model) {
      const background = editorBackground(editor);
      if (background === paseoSurface()) template = { view: editor, background };
      // Paseo restyles its editor a moment after its theme variables change; look again then
      else
        settleTimer ??= setTimeout(() => {
          settleTimer = undefined;
          schedule();
        }, THEME_SETTLE_MS);
    }
    if (editor && panel.carry) {
      const scroller = editor.scrollDOM as HTMLElement | undefined;
      editor.dispatch({ selection: { anchor: Math.min(panel.carry.head, editor.state.doc.length) } });
      if (scroller) scroller.scrollTop = panel.carry.scrollTop;
      panel.carry = null;
    }

    const { engine: shown, notice } = engineFor(panel, chosen);
    const wanted = viewFor(panel.layout, shown);
    if (view !== wanted && !panel.requestedView) {
      // Leaving Paseo's editor for the Paseo renderer's Split: the copy starts where it was
      if (editor && wanted === "preview" && panel.layout === "split") {
        const scroller = editor.scrollDOM as HTMLElement | undefined;
        panel.carry = { head: editor.state.selection.main.head, scrollTop: scroller?.scrollTop ?? 0 };
      }
      requestView(panel);
      view = currentView(panel);
    }
    panel.seenView = view;
    panel.controls.update({
      layout: panel.layout,
      syncScroll: syncsScroll(prefs.get(), "markdown"),
      renderer: { engine: chosen, paletteApplies: shown === "github", palette },
    });
    openPanels.set(panelKey(panel.info), { layout: panel.layout, setView: panel.setView });
    fitControls(panel, `${panel.bar.clientWidth}|${view}|${shown}`);

    const settled = view === wanted;
    const split = panel.layout === "split";
    const percent = `${(splitRatio * 100).toFixed(2)}%`;
    const githubPreview = shown === "github" && panel.layout !== "source";
    const paseoSplit = shown === "paseo" && split && view === "preview" && templateIsCurrent();
    if (!settled || !chrome || !container || !content || (!githubPreview && !paseoSplit)) {
      if (settled) restore(panel);
      removeRendering(panel);
      removeSplitEditor(panel);
      return;
    }

    if (paseoSplit) {
      removeRendering(panel);
      const { model } = panel.info;
      if (!panel.splitEditor && model && template) {
        try {
          panel.splitEditor = new SplitEditor(template.view, model, panel.carry, {
            resizeSplit: (ratio) => prefs.update({ splitRatio: ratio }),
            scrolled: () => followEditor(panel),
          });
        } catch (error) {
          // The GitHub renderer shows this Split, saying why, until a renderer or view is chosen
          console.warn("[editor-enhancements] Paseo's editor could not be copied beside its preview", error);
          panel.copyFailure = error instanceof Error ? error.message : String(error);
          schedule();
          return;
        }
        panel.carry = null;
      }
      const { splitEditor } = panel;
      if (!splitEditor) return;
      if (splitEditor.element.parentElement !== container) container.appendChild(splitEditor.element);
      restyle(panel, content, { marginLeft: percent });
      splitEditor.setBounds(chrome.offsetHeight, percent);
      return;
    }

    removeSplitEditor(panel);
    restyle(panel, content, split ? { width: percent } : { display: "none" });
    if (!panel.preview) {
      panel.preview = createPreview(panel);
      container.appendChild(panel.preview.element);
      panel.stopText = followText(panel, panel.preview);
    } else if (panel.preview.element.parentElement !== container) {
      container.appendChild(panel.preview.element);
    }
    panel.preview.setPalette(palette, paseoColorScheme());
    panel.preview.setNotice(notice);
    panel.preview.setBounds(chrome.offsetHeight, split ? percent : "0px", split);
    watchEditorScroll(panel, split ? findEditorScroller(content) : null);
  };

  const attach = (bar: HTMLElement) => {
    const info = findTextPanel(bar);
    const original = bar.querySelector<HTMLElement>(VIEW_CONTROL_SELECTOR);
    const setView = findSetView(bar);
    if (!info || !original || !setView || !original.parentElement) {
      ignored.add(bar);
      return;
    }
    const controls =
      info.kind === "html"
        ? new ToolbarControls(original, {
            kind: "html",
            setLayout: (layout) => setLayout(panel, layout),
            setSyncScroll: (on) => setSyncScroll("html", on),
            setResources: (on) => prefs.update({ htmlResources: on }),
          })
        : new ToolbarControls(original, {
            kind: "markdown",
            setEngine: (chosen) => {
              // Choosing a renderer tries again to copy Paseo's editor where that failed
              for (const each of panels.values()) each.copyFailure = null;
              prefs.update({ engine: chosen });
            },
            setPalette: (palette) => prefs.update({ palette }),
            setLayout: (layout) => setLayout(panel, layout),
            setSyncScroll: (on) => setSyncScroll("markdown", on),
          });
    const panel: Panel = {
      bar,
      info,
      setView,
      original,
      controls,
      layout: opensInSplit(prefs.get(), info.kind) ? "split" : "preview",
      requestedView: null,
      preview: null,
      page: null,
      splitEditor: null,
      restyled: null,
      stopText: null,
      editorScroller: null,
      paseoScroller: null,
      carry: null,
      seenView: "preview",
      resizeObserver: new ResizeObserver(schedule),
      fittedFor: null,
      copyFailure: null,
    };
    original.parentElement.insertBefore(controls.element, original);
    original.style.display = "none";
    panel.seenView = currentView(panel);
    // A tab docked from a companion window keeps its layout; without Split remembered, the panel
    // keeps the view Paseo opened it on
    const handedOver = takeLayout(panelKey(info));
    if (handedOver) panel.layout = handedOver;
    else if (panel.layout !== "split") panel.layout = currentView(panel);
    requestView(panel);
    // The toolbar grows when a conflict callout appears under it
    if (bar.parentElement) panel.resizeObserver.observe(bar.parentElement);
    panels.set(bar, panel);
    reconcile(panel);
  };

  const detach = (panel: Panel, restoreToolbar: boolean) => {
    openPanels.delete(panelKey(panel.info));
    removeRendering(panel);
    removeSplitEditor(panel);
    restore(panel);
    panel.resizeObserver.disconnect();
    if (restoreToolbar) {
      panel.controls.element.remove();
      panel.original.style.display = "";
    }
    panels.delete(panel.bar);
  };

  function scan() {
    for (const bar of Array.from(document.querySelectorAll<HTMLElement>(BAR_SELECTOR))) {
      if (ignored.has(bar)) continue;
      const panel = panels.get(bar);
      if (!panel) {
        attach(bar);
        continue;
      }
      // React re-rendered the toolbar row without our controls; put them back
      if (!panel.controls.element.isConnected && panel.original.parentElement) {
        panel.original.parentElement.insertBefore(panel.controls.element, panel.original);
      }
      if (panel.original.style.display !== "none") panel.original.style.display = "none";
      reconcile(panel);
    }
    for (const panel of panels.values()) {
      if (!panel.bar.isConnected) detach(panel, false);
    }
  }

  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true });
  // Palettes follow Paseo's theme, and the Paseo renderer's Split editor is copied again from an
  // editor in the new theme
  const stopThemeWatch = watchPaseoTheme(schedule);
  const unsubscribePrefs = prefs.subscribe(schedule);
  scan();

  return () => {
    observer.disconnect();
    unsubscribePrefs();
    for (const panel of Array.from(panels.values())) detach(panel, true);
    clearTimeout(settleTimer);
    stopThemeWatch();
  };
}
