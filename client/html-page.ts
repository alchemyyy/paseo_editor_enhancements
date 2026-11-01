// An HTML file's page in the plugin's own frame: beside Paseo's Source editor in a Split, and as the
// Preview in companion windows, where Paseo's preview does not exist. Paseo's preview
// (packages/app/src/file-panels/html-preview.web.tsx) reloads its frame whenever its text changes,
// and nothing outside its opaque-origin frame can scroll it, so beside an editor it would flash and
// jump to the top with each keystroke. This pane keeps Paseo's isolation and adds what a live page
// needs: an update waits for a pause in typing, loads in a hidden frame, and takes over once loaded,
// and a script ahead of the file reports the page's scroll and moves it where it was or where the
// editor is.
//
// Isolation is Paseo's, unchanged (SECURITY.md, "HTML file preview"): `sandbox="allow-scripts"` alone
// gives the page an opaque origin, so it cannot reach Paseo's DOM, storage, cookies, desktop bridge,
// or daemon connections, open popups, or navigate the window; Paseo's content security policy, ahead
// of everything the file declares, lets inline script and style run and refuses every request. Never
// add `allow-same-origin` (the page would share Paseo's origin, and with it all of the above) or
// `allow-popups` / `allow-top-navigation` (Paseo's window permits both).
//
// A page may also be allowed to load resources (a per-device choice, off by default): its policy
// then lets it load from the web and connect there, and its local files are read through the
// daemon and written into it (html-resources.ts). The frame keeps its opaque origin, so it still
// cannot reach Paseo; what it gains is the network and the files it names, which it can send on.
import { createDivider } from "./divider.ts";
import type { EditorScrollPosition } from "./editor-scroll.ts";
import { createResourceInliner, type ReadResource } from "./html-resources.ts";

export interface HtmlPageActions {
  /** The divider of a Split moved to `ratio` of the panel width */
  resizeSplit(ratio: number): void;
  /** A local file the page references, relative to the page */
  readResource: ReadResource;
}

/** A page's scroll offset in CSS pixels */
export interface PageScroll {
  x: number;
  y: number;
}

/** What a page script posts, signed with its frame's token */
export type PageMessage = { type: "ready"; token: string } | { type: "scroll"; token: string; scroll: PageScroll };

const SANDBOX = "allow-scripts";

/** Paseo's preview policy (file-panels/html-preview-csp.ts), unchanged; keep it in step with Paseo's */
const POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' blob:",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "object-src 'none'",
].join("; ");

/** Paseo's policy opened to the web, for a page allowed to load resources; its local files arrive as `data:` URLs */
const RESOURCES_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' blob: data: http: https:",
  "style-src 'unsafe-inline' data: http: https:",
  "img-src data: blob: http: https:",
  "font-src data: http: https:",
  "media-src data: blob: http: https:",
  "connect-src data: blob: http: https: ws: wss:",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "object-src 'none'",
].join("; ");

// As in Paseo, the prologue is supplied rather than placed after the file's own doctype: the policy
// is always the first element, inside <head> where a meta policy applies, and the file's doctype
// becomes a stray token the parser ignores. A leading BOM would sit mid-document as a zero-width
// space, so it is dropped.
const prologue = (policy: string) => `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}">`;
const BOM = "\uFEFF";

const READY_MESSAGE = "editor-enhancements:page-ready";
const SCROLL_MESSAGE = "editor-enhancements:page-scroll";
const FOLLOW_MESSAGE = "editor-enhancements:page-follow";
const PLACE_MESSAGE = "editor-enhancements:page-place";

/** Updates wait this long after the last edit; larger documents wait longer */
const RENDER_DELAY_MS = 300;
const LARGE_DOCUMENT = 200_000;
const LARGE_RENDER_DELAY_MS = 800;
/** How long a loaded page holds its restored place while its layout settles */
const SETTLE_MS = 1500;
/** A page that has not loaded by then is taken as stuck: a script in it never returns */
const LOAD_TIMEOUT_MS = 10_000;
/**
 * How long the next frame waits after a stuck page's frames are gone. Chromium keeps a frameless
 * subframe process a moment for reuse, and a frame placed in the stuck one would be stuck too.
 */
const STUCK_RECOVERY_MS = 3000;
const STUCK_NOTICE =
  "The page did not finish loading within 10 seconds, so a script in it may never return. It shows again once a version of it loads.";

/**
 * The script ahead of the file. It returns the page to `restore` once its content is parsed, again
 * when it has loaded, and as its layout grows for a moment after (fonts, images, scripts that draw),
 * until the reader scrolls; says when the page has loaded and where it scrolls; and scrolls where
 * the pane asks. Messages both ways carry `token`. The pane's cannot be told by their source: they
 * come from the main window's script, also when the frame sits in a companion window.
 */
function pageScript(restore: PageScroll | null, token: string): string {
  const start = restore ? JSON.stringify({ x: Math.round(restore.x), y: Math.round(restore.y) }) : "null";
  return `(() => {
const host = parent;
const token = ${JSON.stringify(token)};
const restore = ${start};
let held = restore !== null;
const release = () => { held = false; };
for (const type of ["wheel", "keydown", "pointerdown", "touchstart"]) addEventListener(type, release, { capture: true, passive: true });
const settle = () => { if (held) scrollTo(restore.x, restore.y); };
document.addEventListener("DOMContentLoaded", settle);
addEventListener("load", () => {
  settle();
  host.postMessage({ type: "${READY_MESSAGE}", token }, "*");
  if (!held || typeof ResizeObserver !== "function") return;
  const observer = new ResizeObserver(settle);
  observer.observe(document.documentElement);
  if (document.body) observer.observe(document.body);
  setTimeout(() => { observer.disconnect(); held = false; }, ${SETTLE_MS});
});
let reporting = false;
addEventListener("scroll", () => {
  if (reporting) return;
  reporting = true;
  requestAnimationFrame(() => {
    reporting = false;
    host.postMessage({ type: "${SCROLL_MESSAGE}", token, x: scrollX, y: scrollY }, "*");
  });
}, { passive: true });
addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object" || data.token !== token) return;
  if (data.type === "${FOLLOW_MESSAGE}" && typeof data.ratio === "number") {
    held = false;
    const root = document.scrollingElement || document.documentElement;
    scrollTo(scrollX, data.ratio * Math.max(0, root.scrollHeight - root.clientHeight));
  } else if (data.type === "${PLACE_MESSAGE}" && typeof data.x === "number" && typeof data.y === "number") {
    held = false;
    scrollTo(data.x, data.y);
  }
});
})();`;
}

/** The frame's document: Paseo's policy (opened to the web with `resources`), the page script, then the file */
export function pageDocument(html: string, restore: PageScroll | null, token: string, resources = false): string {
  const file = html.startsWith(BOM) ? html.slice(BOM.length) : html;
  return `${prologue(resources ? RESOURCES_POLICY : POLICY)}<script>${pageScript(restore, token)}</script>${file}`;
}

/**
 * A page script's message, or null for anything else. The page's own scripts can read their
 * frame's token and post the same messages, so a message moves only that page and its scroll.
 */
export function parsePageMessage(data: unknown): PageMessage | null {
  if (typeof data !== "object" || data === null || !("type" in data) || !("token" in data)) return null;
  const { type, token } = data;
  if (typeof token !== "string") return null;
  if (type === READY_MESSAGE) return { type: "ready", token };
  if (type !== SCROLL_MESSAGE || !("x" in data) || !("y" in data)) return null;
  const { x, y } = data;
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { type: "scroll", token, scroll: { x: Math.max(0, x), y: Math.max(0, y) } };
}

/** A token no other frame can guess, for one frame's messages */
function frameToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** One frame of the pane and its page */
interface PageFrame {
  element: HTMLIFrameElement;
  token: string;
  /** Where the page was told to scroll back to */
  restore: PageScroll | null;
  /**
   * The page's window, as its messages carry it. Chromium's `contentWindow` for the frame was seen
   * to differ from the window its messages come from once the sandboxed page runs in a process of
   * its own, so it is not used.
   */
  window: Window | null;
}

export class HtmlPage {
  /** Positioned in the panel; holds the divider and the frames */
  readonly element: HTMLDivElement;
  private readonly actions: HtmlPageActions;
  private readonly divider: HTMLDivElement;
  private readonly frames: HTMLDivElement;
  /** The frame on screen */
  private shown: PageFrame | null = null;
  /** The frame loading the newest text, hidden behind the one on screen */
  private loading: PageFrame | null = null;
  /** Where the page on screen last scrolled to; the next page starts there */
  private scroll: PageScroll | null = null;
  /** The editor's place, a share of its scrollable height, for a page with no place of its own */
  private followRatio: number | null = null;
  private text: string | null = null;
  /** The text of the newest frame, loading or on screen */
  private framedText: string | null = null;
  private renderTimer: number | null = null;
  private loadTimer: number | null = null;
  /** The text of the page that got stuck, whether it was tried again, and when a frame may load next */
  private stuck: { text: string; retried: boolean; until: number } | null = null;
  /** Says why no page shows after one got stuck */
  private readonly notice: HTMLDivElement;
  /** The window the frames post to: their parent, the main window or a companion window */
  private listening: Window | null = null;
  private destroyed = false;
  /** Whether the page may load resources from the web and its local files */
  private resources = false;
  private readonly inlineResources: (html: string) => Promise<string>;
  /** Counts renders, so a page whose resources arrive after a newer render is dropped */
  private renderSerial = 0;

  constructor(actions: HtmlPageActions) {
    this.actions = actions;
    this.inlineResources = createResourceInliner((reference) => this.actions.readResource(reference));
    this.element = document.createElement("div");
    this.element.setAttribute("data-editor-enhancements-html-page", "");
    this.element.style.cssText = "position:absolute;right:0;bottom:0;display:flex;z-index:1;";
    this.divider = createDivider("left", (ratio) => this.actions.resizeSplit(ratio));
    this.element.appendChild(this.divider);
    this.frames = document.createElement("div");
    this.frames.style.cssText = "position:relative;flex:1 1 auto;min-width:0;background-color:white;";
    this.notice = document.createElement("div");
    this.notice.hidden = true;
    this.notice.textContent = STUCK_NOTICE;
    this.notice.style.cssText =
      "position:absolute;left:0;right:0;top:0;z-index:1;padding:10px 14px;font:13px/1.4 system-ui,sans-serif;color:#1f2328;background:#fff8c5;border-bottom:1px solid #d4a72c;";
    this.frames.appendChild(this.notice);
    this.element.appendChild(this.frames);
  }

  /** Places the page: below `top` pixels, from `left` (a CSS length) to the panel's right edge */
  setBounds(top: number, left: string, showDivider: boolean): void {
    const style = this.element.style;
    if (style.top !== `${top}px`) style.top = `${top}px`;
    if (style.left !== left) style.left = left;
    this.divider.style.display = showDivider ? "" : "none";
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

  /** Lets the page load resources from the web and its local files, or not; the page reloads */
  setResources(on: boolean): void {
    if (on === this.resources) return;
    this.resources = on;
    this.framedText = null;
    this.timers().clearTimeout(this.renderTimer ?? undefined);
    this.render();
  }

  /** Scrolls the page to the editor's share of its document; a page carries no source lines */
  follow(position: EditorScrollPosition): void {
    const ratio = position.atTop ? 0 : position.atBottom ? 1 : position.ratio;
    this.followRatio = ratio;
    this.post({ type: FOLLOW_MESSAGE, ratio });
  }

  destroy(): void {
    this.destroyed = true;
    this.timers().clearTimeout(this.renderTimer ?? undefined);
    this.timers().clearTimeout(this.loadTimer ?? undefined);
    this.listening?.removeEventListener("message", this.handleMessage);
    this.listening = null;
    this.element.remove();
  }

  /**
   * Timers of the window showing the page. A companion window runs this script from the main
   * window, whose timers Electron throttles while it is minimized or hidden.
   */
  private timers(): Window {
    return this.element.ownerDocument.defaultView ?? window;
  }

  /** Loads the current text in a new frame, behind the one on screen */
  private render(): void {
    this.renderTimer = null;
    const text = this.text;
    if (this.destroyed || text === null || text === this.framedText) return;
    const doc = this.element.ownerDocument;
    const view = doc.defaultView;
    // A frame posts to the window it is in, which is known once the pane is placed in its panel
    if (!this.element.isConnected || !view) {
      this.renderTimer = this.timers().setTimeout(() => this.render(), RENDER_DELAY_MS);
      return;
    }
    const { stuck } = this;
    if (stuck) {
      const wait = stuck.until - Date.now();
      if (wait > 0) {
        this.renderTimer = this.timers().setTimeout(() => this.render(), wait);
        return;
      }
      // The same page got stuck twice; an edit tries again
      if (stuck.retried && text === stuck.text) return;
    }
    this.framedText = text;
    const serial = ++this.renderSerial;
    const resources = this.resources;
    if (!resources) {
      this.mount(text, text, false);
      return;
    }
    void this.inlineResources(text).then(
      (html) => serial === this.renderSerial && !this.destroyed && this.mount(text, html, true),
      () => serial === this.renderSerial && !this.destroyed && this.mount(text, text, true),
    );
  }

  /** Loads `html`, the page for `text`, in a new frame behind the one on screen */
  private mount(text: string, html: string, resources: boolean): void {
    const doc = this.element.ownerDocument;
    const view = doc.defaultView;
    if (!view) return;
    this.listen(view);
    this.loading?.element.remove();
    const element = doc.createElement("iframe");
    // Set before the frame has a document, so every document it shows is sandboxed
    element.setAttribute("sandbox", SANDBOX);
    element.setAttribute("referrerpolicy", "no-referrer");
    element.setAttribute("title", "HTML page");
    element.setAttribute("data-testid", "editor-enhancements-html-page");
    element.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;border:none;background-color:white;visibility:hidden;";
    const page: PageFrame = { element, token: frameToken(), restore: this.scroll, window: null };
    element.srcdoc = pageDocument(html, page.restore, page.token, resources);
    this.loading = page;
    this.frames.appendChild(element);
    this.timers().clearTimeout(this.loadTimer ?? undefined);
    this.loadTimer = this.timers().setTimeout(() => this.unstick(page, text), LOAD_TIMEOUT_MS);
  }

  /**
   * Drops every frame when a loading page got stuck. Sandboxed pages share a process, so the page on
   * screen is frozen with the stuck one, and while either frame lives the browser keeps that process
   * and puts the next frames in it. The current text is tried once more, since the page on screen
   * may have been the one stuck.
   */
  private unstick(page: PageFrame, text: string): void {
    this.loadTimer = null;
    if (this.destroyed || this.loading !== page) return;
    page.element.remove();
    this.loading = null;
    this.shown?.element.remove();
    this.shown = null;
    this.framedText = null;
    const retried = this.stuck?.text === text;
    this.stuck = { text, retried, until: Date.now() + STUCK_RECOVERY_MS };
    this.notice.hidden = false;
    if (retried) return;
    this.timers().clearTimeout(this.renderTimer ?? undefined);
    this.renderTimer = this.timers().setTimeout(() => this.render(), STUCK_RECOVERY_MS);
  }

  /** A page that has loaded takes the screen; a frame overtaken by newer text is gone before that */
  private reveal(page: PageFrame): void {
    this.timers().clearTimeout(this.loadTimer ?? undefined);
    this.loadTimer = null;
    this.stuck = null;
    this.notice.hidden = true;
    this.loading = null;
    this.shown?.element.remove();
    this.shown = page;
    page.element.style.visibility = "";
    // The page went back to where it was told; the reader or the editor may have moved since
    if (this.scroll && this.scroll !== page.restore) this.post({ type: PLACE_MESSAGE, x: this.scroll.x, y: this.scroll.y });
    else if (!this.scroll && this.followRatio !== null) this.post({ type: FOLLOW_MESSAGE, ratio: this.followRatio });
  }

  /** Sends the page on screen a command, signed as its own messages are */
  private post(command: { type: string } & Record<string, unknown>): void {
    const shown = this.shown;
    shown?.window?.postMessage({ ...command, token: shown.token }, "*");
  }

  private listen(view: Window): void {
    if (this.listening === view) return;
    this.listening?.removeEventListener("message", this.handleMessage);
    this.listening = view;
    view.addEventListener("message", this.handleMessage);
  }

  private readonly handleMessage = (event: MessageEvent) => {
    if (this.destroyed) return;
    const message = parsePageMessage(event.data);
    if (!message) return;
    // A frame's message comes from the frame's window
    const source = event.source as Window | null;
    const { loading, shown } = this;
    if (message.type === "ready" && loading?.token === message.token) {
      loading.window = source;
      this.reveal(loading);
    } else if (message.type === "scroll" && shown?.token === message.token) {
      shown.window = source;
      this.scroll = message.scroll;
    }
  };
}
