// The Paseo engine's Split. Paseo's panel shows either its Source editor or its own preview, never
// both, so the panel stays on Paseo's preview (which renders the panel's buffer) and the left side
// gets an editor cloned from Paseo's Source editor: its extensions, theme, and keymaps, bound to
// that same buffer. Edits reach Paseo's preview, autosave, and conflict handling as they would from
// Source; changes the buffer takes from disk come back into the editor.
import { type CmView, type CompanionEditor, createCompanionEditor } from "./companion-editor";
import { type EditorScrollPosition, editorScrollPosition } from "./editor-scroll";
import type { EditorModel } from "./fiber";

const DIVIDER_WIDTH_PX = 6;

export interface SplitEditorActions {
  /** The divider moved to `ratio` of the panel width */
  resizeSplit(ratio: number): void;
  /** The editor scrolled */
  scrolled(position: EditorScrollPosition): void;
}

export class SplitEditor {
  /** Positioned in the panel at its left edge; holds the editor and the divider */
  readonly element: HTMLDivElement;
  private readonly editor: CompanionEditor;
  private readonly actions: SplitEditorActions;
  private readonly divider: HTMLDivElement;
  private readonly unsubscribe: () => void;
  private readonly scroller: HTMLElement | null;
  /** The buffer as this editor last wrote or loaded it */
  private pushed: string;
  private frame = 0;

  /**
   * `template` is a Paseo Source editor for a Markdown file, live or already destroyed: its classes
   * and extensions build the copy. Throws when they cannot.
   */
  constructor(
    template: CmView,
    model: EditorModel,
    start: { head: number; scrollTop: number } | null,
    actions: SplitEditorActions,
  ) {
    this.actions = actions;
    this.pushed = model.getSnapshot().content;
    this.element = document.createElement("div");
    this.element.setAttribute("data-markdown-enhancements-split-editor", "");
    // Paseo's UI font rule spares only code surfaces it marks so (appearance/apply-root-font.web.ts)
    this.element.setAttribute("data-pmono", "");
    this.element.style.cssText = "position:absolute;left:0;bottom:0;display:flex;z-index:1;background:var(--colors-surface0);";
    const host = document.createElement("div");
    host.style.cssText = "position:relative;flex:1 1 auto;min-width:0;display:flex;flex-direction:column;";
    this.element.appendChild(host);

    this.divider = document.createElement("div");
    this.divider.setAttribute("role", "separator");
    this.divider.setAttribute("aria-orientation", "vertical");
    this.divider.setAttribute("title", "Drag to resize");
    this.divider.style.cssText = [
      `flex:0 0 ${DIVIDER_WIDTH_PX}px`,
      "cursor:col-resize",
      "background:var(--colors-surface0)",
      "border-right:1px solid var(--colors-border)",
      "box-sizing:border-box",
      "-webkit-app-region:no-drag",
      "touch-action:none",
    ].join(";");
    this.divider.addEventListener("pointerdown", this.startResize);
    this.element.appendChild(this.divider);

    let editor: CompanionEditor | null = null;
    editor = createCompanionEditor({
      sourceView: template,
      content: this.pushed,
      parent: host,
      root: document,
      onSave: () => void model.save(),
      onChange: (state) => {
        if (!state.docChanged || !editor) return;
        const text = editor.textWithSeparator(model.getSnapshot().lineSeparator);
        if (text === this.pushed) return;
        this.pushed = text;
        model.edit(text);
      },
    });
    if (!editor) throw new Error("its CodeMirror state lacks the parts a copy is built from");
    this.editor = editor;
    // The buffer reloads from disk, or takes an overwrite or reload after a conflict
    this.unsubscribe = model.subscribe(() => {
      const content = model.getSnapshot().content;
      if (content === this.pushed) return;
      this.pushed = content;
      editor.load(content);
    });

    // A well-known part of every EditorView
    const scroller = editor.view.scrollDOM as HTMLElement | undefined;
    this.scroller = scroller ?? null;
    this.scroller?.addEventListener("scroll", this.handleScroll, { passive: true });
    if (start) {
      editor.view.dispatch({ selection: { anchor: Math.min(start.head, editor.view.state.doc.length) } });
      if (this.scroller) this.scroller.scrollTop = start.scrollTop;
    }
  }

  /** Places the editor: below `top` pixels, `width` (a CSS length) wide from the panel's left edge */
  setBounds(top: number, width: string): void {
    const style = this.element.style;
    if (style.top !== `${top}px`) style.top = `${top}px`;
    if (style.width !== width) style.width = width;
  }

  /** Where the editor is scrolled to, for the preview to follow */
  position(): EditorScrollPosition | null {
    return this.scroller ? editorScrollPosition(this.scroller) : null;
  }

  /** The cursor and scroll, for Paseo's Source editor or the next Split to start from */
  state(): { head: number; scrollTop: number } {
    return { head: this.editor.view.state.selection.main.head, scrollTop: this.scroller?.scrollTop ?? 0 };
  }

  focus(): void {
    this.editor.view.focus();
  }

  destroy(): void {
    cancelAnimationFrame(this.frame);
    this.unsubscribe();
    this.scroller?.removeEventListener("scroll", this.handleScroll);
    this.editor.view.destroy();
    this.element.remove();
  }

  private readonly handleScroll = () => {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const position = this.position();
      if (position) this.actions.scrolled(position);
    });
  };

  private readonly startResize = (event: PointerEvent) => {
    const panel = this.element.parentElement;
    if (!panel || event.button !== 0) return;
    event.preventDefault();
    const divider = this.divider;
    divider.setPointerCapture(event.pointerId);
    // The editor and preview would otherwise take the pointer and select text while dragging
    const shield = document.createElement("div");
    shield.style.cssText = "position:fixed;inset:0;cursor:col-resize;z-index:2147483647;";
    document.body.appendChild(shield);
    const move = (moveEvent: PointerEvent) => {
      const bounds = panel.getBoundingClientRect();
      if (bounds.width > 0) this.actions.resizeSplit((moveEvent.clientX - bounds.left) / bounds.width);
    };
    const end = () => {
      shield.remove();
      divider.removeEventListener("pointermove", move);
      divider.removeEventListener("pointerup", end);
      divider.removeEventListener("pointercancel", end);
    };
    divider.addEventListener("pointermove", move);
    divider.addEventListener("pointerup", end);
    divider.addEventListener("pointercancel", end);
  };
}
