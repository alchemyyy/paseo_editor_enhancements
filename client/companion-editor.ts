// A real CodeMirror editor for the companion window, built from a Source editor already on
// screen. The plugin cannot import CodeMirror, so the classes come from that editor's own view,
// and its extensions are reused minus the parts bound to its tab: the update listener feeding
// the tab's file model, and the Mod-s binding that saves through it.
// NOTE: App-internal. `cmTile` (@codemirror/view 6.4x) and `state.config.base` are private API.

import { attachFindBar } from "./find-bar";
// Narrow structural types for what this module touches; they shadow lib.dom's in this module.
interface CmText {
  readonly length: number;
  readonly lines: number;
  eq(other: CmText): boolean;
  toString(): string;
  sliceString(from: number, to?: number, lineSeparator?: string): string;
  lineAt(position: number): { number: number; from: number };
}
interface CmState {
  readonly doc: CmText;
  toText(text: string): CmText;
  readonly selection: { main: { head: number } };
  readonly config?: { base?: unknown };
  update(spec: object): { constructor: { addToHistory?: { of(value: boolean): unknown } } };
}
interface CmViewUpdate {
  readonly state: CmState;
  readonly docChanged: boolean;
  readonly selectionSet: boolean;
}
interface CmFacet {
  of(value: unknown): unknown;
}
export interface CmView {
  readonly state: CmState;
  readonly dom: unknown;
  /** The element that scrolls the document (`.cm-scroller`) */
  readonly scrollDOM: unknown;
  dispatch(spec: object): void;
  destroy(): void;
  focus(): void;
}
interface CmViewClass {
  new (config: { state: CmState; parent: unknown; root: unknown }): CmView;
  readonly updateListener: CmFacet;
}
interface CmStateClass {
  create(config: { doc: string; extensions: unknown }): CmState;
}
interface FacetProviderLike {
  facet: CmFacet;
  value: unknown;
}
interface CompartmentInstanceLike {
  compartment: { of(extension: unknown): unknown; get(state: CmState): unknown };
  inner: unknown;
}
interface PrecLike {
  constructor: new (inner: unknown, prec: unknown) => unknown;
  inner: unknown;
  prec: unknown;
}
interface KeyBinding {
  key?: string;
  run?: (view: unknown) => boolean;
  preventDefault?: boolean;
}

declare const document: unknown;

const SAVE_KEY = "Mod-s";

/** The EditorView behind a CodeMirror DOM tree, or null */
export function findEditorView(editorElement: unknown): CmView | null {
  const element = editorElement as { querySelector?(selector: string): unknown } | null;
  const content = element?.querySelector?.(".cm-content") as
    | { cmTile?: { root?: { view?: CmView } }; cmView?: { rootView?: { view?: CmView } } }
    | null
    | undefined;
  return content?.cmTile?.root?.view ?? content?.cmView?.rootView?.view ?? null;
}

function isFacetProvider(value: unknown): value is FacetProviderLike {
  return Boolean(value && typeof value === "object" && "facet" in value && "value" in value);
}

function isCompartmentInstance(value: unknown): value is CompartmentInstanceLike {
  return Boolean(value && typeof value === "object" && "compartment" in value && "inner" in value);
}

function isPrec(value: unknown): value is PrecLike {
  return Boolean(value && typeof value === "object" && "inner" in value && "prec" in value);
}

/**
 * The source editor's extension tree with its tab bindings removed: update listeners dropped,
 * and a keymap holding Mod-s rebuilt with `onSave` in its place. Compartments take what they hold
 * now in `state`, since the editor reconfigures them after it starts (Paseo sets its theme so).
 */
function detachExtensions(extension: unknown, viewClass: CmViewClass, state: CmState, onSave: () => void): unknown {
  const detach = (child: unknown) => detachExtensions(child, viewClass, state, onSave);
  if (Array.isArray(extension)) return extension.map(detach);
  if (isCompartmentInstance(extension)) {
    return extension.compartment.of(detach(extension.compartment.get(state) ?? extension.inner));
  }
  if (isPrec(extension)) {
    return new extension.constructor(detach(extension.inner), extension.prec);
  }
  if (isFacetProvider(extension)) {
    if (extension.facet === viewClass.updateListener) return [];
    const bindings = extension.value;
    if (Array.isArray(bindings) && bindings.some((binding: KeyBinding) => binding?.key === SAVE_KEY)) {
      const rebound = bindings.map((binding: KeyBinding) =>
        binding?.key === SAVE_KEY ? { ...binding, run: () => (onSave(), true) } : binding,
      );
      return extension.facet.of(rebound);
    }
  }
  return extension;
}

export interface CompanionEditor {
  view: CmView;
  /** True when the text differs from the last loaded or saved text */
  isDirty(): boolean;
  text(): string;
  /** The text with the file's own line separator */
  textWithSeparator(separator: string): string;
  /** The last loaded or saved text */
  savedText(): string;
  /** Replaces the text from disk without an undo step and marks it clean */
  load(content: string): void;
  /** Records the current text as saved */
  markSaved(): void;
}

export function createCompanionEditor(input: {
  sourceView: CmView;
  content: string;
  /** The text on disk when it differs from `content`, such as a tab moved with unsaved edits */
  savedContent?: string;
  parent: unknown;
  root: unknown;
  onSave(): void;
  onChange(state: { dirty: boolean; line: number; column: number; lines: number; length: number; docChanged: boolean }): void;
}): CompanionEditor | null {
  const viewClass = input.sourceView.constructor as unknown as CmViewClass;
  const stateClass = input.sourceView.state.constructor as unknown as CmStateClass;
  const base = input.sourceView.state.config?.base;
  if (!base || typeof viewClass.updateListener?.of !== "function" || typeof stateClass.create !== "function") {
    return null;
  }
  const addToHistory = input.sourceView.state.update({}).constructor.addToHistory;
  let saved: CmText | null = null;
  let view: CmView | null = null;

  const report = (state: CmState, docChanged: boolean) => {
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    input.onChange({
      dirty: saved !== null && !state.doc.eq(saved),
      line: line.number,
      column: head - line.from + 1,
      lines: state.doc.lines,
      length: state.doc.length,
      docChanged,
    });
  };

  const extensions = [
    detachExtensions(base, viewClass, input.sourceView.state, () => input.onSave()),
    viewClass.updateListener.of((update: CmViewUpdate) => {
      if (update.docChanged || update.selectionSet) report(update.state, update.docChanged);
    }),
  ];
  const state = stateClass.create({ doc: input.content, extensions });
  saved = input.savedContent !== undefined && input.savedContent !== input.content ? state.toText(input.savedContent) : state.doc;
  // `root` mounts CodeMirror's generated styles into the companion's document
  view = new viewClass({ state, parent: input.parent, root: input.root });
  // The constructor binds resize, scroll, and selectionchange listeners to the window of its
  // element before attaching it, which is still this window. setRoot rebinds to the root's
  // window but skips an unchanged root, so it takes a round trip through this document.
  const rebindable = view as unknown as { setRoot?(root: unknown): void; requestMeasure?(): void };
  rebindable.setRoot?.(document);
  rebindable.setRoot?.(input.root);
  rebindable.requestMeasure?.();
  report(view.state, false);
  const editorView = view;
  // Paseo's find widget belongs to its own editor; the copy gets the plugin's
  attachFindBar(editorView, input.parent as HTMLElement);

  return {
    view: editorView,
    isDirty: () => saved !== null && !editorView.state.doc.eq(saved),
    text: () => editorView.state.doc.toString(),
    textWithSeparator: (separator) => editorView.state.doc.sliceString(0, undefined, separator),
    savedText: () => (saved ?? editorView.state.doc).toString(),
    load(content) {
      // The cursor stays where it was, as far as the new text reaches
      const head = Math.min(editorView.state.selection.main.head, editorView.state.toText(content).length);
      editorView.dispatch({
        changes: { from: 0, to: editorView.state.doc.length, insert: content },
        selection: { anchor: head },
        ...(addToHistory ? { annotations: addToHistory.of(false) } : {}),
      });
      saved = editorView.state.doc;
      report(editorView.state, false);
    },
    markSaved() {
      saved = editorView.state.doc;
      report(editorView.state, false);
    },
  };
}
