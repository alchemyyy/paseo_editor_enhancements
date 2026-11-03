// The GitHub engine's preview: gh-gfm-preview's rendering in a shadow root (so its CSS neither leaks
// into Paseo nor inherits from it), re-rendered as the text changes. Unchanged blocks keep their
// DOM, so images, diagrams, math, and scroll position survive edits. Positioned over the panel by
// the panel controller.
import { createDivider } from "./divider";
import type { EditorScrollPosition } from "./editor-scroll";
import type { GfmEngine } from "./gfm-engine";
import { GfmPage } from "./gfm-page";
import { type ColorScheme, type PaletteId, paletteScheme, previewStylesheet } from "./palettes";
import { classifyReference, LOCAL_IMAGE_ATTRIBUTE, LOCAL_LINK_ATTRIBUTE, SOURCE_LINE_ATTRIBUTE } from "./references";
import { increasingAnchors, type LineAnchor, previewOffsetForLine } from "./scroll-sync";

export interface PreviewActions {
  /** A local image's URL, at once when cached */
  imageUrl(reference: string): string | Promise<string>;
  /** Opens a local link target; `side` when Ctrl/Cmd was held */
  openLocal(target: string, side: boolean): void;
  openExternal(url: string): void;
  /** The divider of a Split moved to `ratio` of the panel width */
  resizeSplit(ratio: number): void;
  /** A render finished; the layout of the preview may have changed */
  rendered(): void;
}

/** Documents above this size render less often while they are edited */
const LARGE_DOCUMENT = 200_000;
const RENDER_DELAY_MS = 30;
const LARGE_RENDER_DELAY_MS = 250;
const SOURCE_LINE_PATTERN = new RegExp(` ${SOURCE_LINE_ATTRIBUTE}="\\d+"`, "g");

/** A node's identity for re-rendering: its HTML without its source line, which edits above shift */
function nodeKey(node: Node): string {
  return node instanceof Element ? node.outerHTML.replace(SOURCE_LINE_PATTERN, "") : `#${node.nodeType}:${node.textContent}`;
}

export class PreviewPane {
  /** Positioned in the panel; holds the divider and the shadow host */
  readonly element: HTMLDivElement;
  private readonly actions: PreviewActions;
  private readonly engine: GfmEngine;
  private readonly divider: HTMLDivElement;
  private readonly style: HTMLStyleElement;
  private readonly scroller: HTMLDivElement;
  private readonly status: HTMLDivElement;
  /** Why the GitHub renderer shows this view when Paseo's renderer was chosen */
  private readonly notice: HTMLDivElement;
  private readonly article: HTMLElement;
  private readonly page: GfmPage;
  private readonly keys = new WeakMap<Node, string>();
  private text: string | null = null;
  /** The text of the newest render request, and of the newest render shown */
  private requested: { text: string; serial: number } | null = null;
  private shownSerial = 0;
  private serial = 0;
  private renderTimer: number | null = null;
  private destroyed = false;

  constructor(actions: PreviewActions, engine: GfmEngine) {
    this.actions = actions;
    this.engine = engine;
    this.element = document.createElement("div");
    this.element.setAttribute("data-markdown-enhancements-preview", "");
    this.element.style.cssText = "position:absolute;right:0;bottom:0;display:flex;z-index:1;";

    this.divider = createDivider("left", (ratio) => this.actions.resizeSplit(ratio));
    this.element.appendChild(this.divider);

    const host = document.createElement("div");
    host.style.cssText = "position:relative;flex:1 1 auto;min-width:0;";
    this.element.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    this.style = document.createElement("style");
    this.scroller = document.createElement("div");
    this.scroller.className = "mde-root";
    this.scroller.setAttribute("data-testid", "markdown-enhancements-preview");
    this.notice = document.createElement("div");
    this.notice.className = "mde-notice";
    this.notice.hidden = true;
    this.status = document.createElement("div");
    this.status.className = "mde-status";
    this.status.textContent = "Starting the GitHub renderer…";
    this.article = document.createElement("article");
    this.article.className = "markdown-body";
    this.scroller.append(this.notice, this.status, this.article);
    shadow.append(this.style, this.scroller);
    this.page = new GfmPage(engine, shadow);
    this.scroller.addEventListener("click", this.handleClick);
  }

  setPalette(palette: PaletteId, paseoScheme: ColorScheme): void {
    const css = previewStylesheet(palette, paseoScheme);
    if (this.style.textContent !== css) this.style.textContent = css;
    this.page.setDark(paletteScheme(palette, paseoScheme) === "dark");
  }

  /** Places the preview: below `top` pixels, from `left` (a CSS length) to the panel's right edge */
  setBounds(top: number, left: string, showDivider: boolean): void {
    const style = this.element.style;
    if (style.top !== `${top}px`) style.top = `${top}px`;
    if (style.left !== left) style.left = left;
    this.divider.style.display = showDivider ? "" : "none";
  }

  /** Shows `text` above the rendering, or nothing for null */
  setNotice(text: string | null): void {
    if (this.notice.hidden !== (text === null)) this.notice.hidden = text === null;
    if (text !== null && this.notice.textContent !== text) this.notice.textContent = text;
  }

  setText(text: string): void {
    if (text === this.text) return;
    const first = this.text === null;
    this.text = text;
    this.timers().clearTimeout(this.renderTimer ?? undefined);
    if (first) {
      this.render();
      return;
    }
    const delay = text.length > LARGE_DOCUMENT ? LARGE_RENDER_DELAY_MS : RENDER_DELAY_MS;
    this.renderTimer = this.timers().setTimeout(() => this.render(), delay);
  }

  /** Scrolls so the editor's top line is at the top of the preview */
  follow(position: EditorScrollPosition): void {
    const scroller = this.scroller;
    const maximum = scroller.scrollHeight - scroller.clientHeight;
    let target: number;
    if (position.atTop) target = 0;
    else if (position.atBottom) target = maximum;
    else if (position.line === null || position.lineCount === null) target = position.ratio * maximum;
    else {
      // The footnotes block renders last but carries its first definition's line, often early
      const blocks: LineAnchor[] = [];
      for (const child of Array.from(this.article.children) as HTMLElement[]) {
        if (child.classList.contains("footnotes")) continue;
        blocks.push({ line: Number(child.getAttribute(SOURCE_LINE_ATTRIBUTE)), top: child.offsetTop });
      }
      const end = { line: position.lineCount + 1, top: scroller.scrollHeight };
      target = previewOffsetForLine(increasingAnchors(blocks), position.line, end);
    }
    scroller.scrollTop = Math.max(0, Math.min(maximum, target));
  }

  destroy(): void {
    this.destroyed = true;
    this.timers().clearTimeout(this.renderTimer ?? undefined);
    this.page.dispose();
    this.element.remove();
  }

  /**
   * Timers of the window showing the preview. A companion window runs this script from the main
   * window, whose timers Electron throttles while it is minimized or hidden.
   */
  private timers(): Window {
    return this.element.ownerDocument.defaultView ?? window;
  }

  /** Renders the current text; results arriving out of order never replace a newer one */
  private render(): void {
    this.renderTimer = null;
    const text = this.text;
    if (this.destroyed || text === null || text === this.requested?.text) return;
    const serial = ++this.serial;
    this.requested = { text, serial };
    this.engine.render(text).then(
      (html) => {
        if (this.destroyed || serial < this.shownSerial) return;
        this.shownSerial = serial;
        this.status.hidden = true;
        this.status.removeAttribute("data-error");
        const template = document.createElement("template");
        template.innerHTML = html;
        this.patch(Array.from(template.content.childNodes));
        this.actions.rendered();
      },
      (error: unknown) => {
        if (this.destroyed || serial < this.shownSerial) return;
        // The next edit tries again
        if (this.requested?.serial === serial) this.requested = null;
        this.status.hidden = false;
        this.status.setAttribute("data-error", "");
        this.status.textContent = `The GitHub renderer failed: ${error instanceof Error ? error.message : String(error)}`;
      },
    );
  }

  /** Replaces only the changed run of top-level nodes between the unchanged head and tail */
  private patch(next: Node[]): void {
    const current = Array.from(this.article.childNodes);
    const keyOf = (node: Node) => {
      let key = this.keys.get(node);
      if (key === undefined) {
        key = nodeKey(node);
        this.keys.set(node, key);
      }
      return key;
    };
    let head = 0;
    while (head < current.length && head < next.length && keyOf(current[head]) === keyOf(next[head])) head++;
    let tail = 0;
    while (
      tail < current.length - head &&
      tail < next.length - head &&
      keyOf(current[current.length - 1 - tail]) === keyOf(next[next.length - 1 - tail])
    ) {
      tail++;
    }
    // Kept blocks take their new source lines
    const kept = [...current.slice(0, head).map((node, index) => [node, next[index]] as const)];
    for (let offset = 1; offset <= tail; offset++) kept.push([current[current.length - offset], next[next.length - offset]]);
    for (const [node, replacement] of kept) {
      if (!(node instanceof Element && replacement instanceof Element)) continue;
      const line = replacement.getAttribute(SOURCE_LINE_ATTRIBUTE);
      if (line !== null && node.getAttribute(SOURCE_LINE_ATTRIBUTE) !== line) node.setAttribute(SOURCE_LINE_ATTRIBUTE, line);
    }
    const reference = tail > 0 ? current[current.length - tail] : null;
    const removed = current.slice(head, current.length - tail);
    this.page.release(removed);
    for (const node of removed) node.remove();
    const inserted: Element[] = [];
    for (const node of next.slice(head, next.length - tail)) {
      keyOf(node);
      this.article.insertBefore(node, reference);
      if (node instanceof Element) {
        this.loadImages(node);
        inserted.push(node);
      }
    }
    this.page.enhance(inserted);
  }

  private loadImages(root: Element): void {
    const images = root.matches(`img[${LOCAL_IMAGE_ATTRIBUTE}]`)
      ? [root]
      : Array.from(root.querySelectorAll(`img[${LOCAL_IMAGE_ATTRIBUTE}]`));
    for (const image of images) {
      const reference = image.getAttribute(LOCAL_IMAGE_ATTRIBUTE);
      if (!reference) continue;
      const url = this.actions.imageUrl(reference);
      if (typeof url === "string") {
        image.setAttribute("src", url);
        continue;
      }
      url.then(
        (resolved) => image.setAttribute("src", resolved),
        (error: unknown) => {
          image.classList.add("mde-image-error");
          image.setAttribute("title", error instanceof Error ? error.message : String(error));
        },
      );
    }
  }

  private readonly handleClick = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target.closest("a") : null;
    if (!target) return;
    // Nothing in the preview may navigate Paseo's own window
    event.preventDefault();
    const local = target.getAttribute(LOCAL_LINK_ATTRIBUTE);
    if (local) {
      this.actions.openLocal(local, event.ctrlKey || event.metaKey);
      return;
    }
    const href = target.getAttribute("href") ?? "";
    const kind = classifyReference(href);
    if (kind === "external") this.actions.openExternal(href);
    else if (kind === "fragment") this.scrollToFragment(href.slice(1));
  };

  private scrollToFragment(fragment: string): void {
    let id = fragment;
    try {
      id = decodeURIComponent(fragment);
    } catch {
      // Use the fragment as written
    }
    const escaped = CSS.escape(id);
    const target = this.article.querySelector(`[id="${escaped}"], [name="${escaped}"]`);
    if (!target) return;
    const offset = target.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top;
    this.scroller.scrollTop += offset - 8;
  }
}
