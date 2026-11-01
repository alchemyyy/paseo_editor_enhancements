// The divider between a Split's editor and its preview. Dragging it reports the pointer's share of
// the panel's width; the panel is the parent of the pane that holds the divider.

const DIVIDER_WIDTH_PX = 6;

/**
 * A divider for a pane on one side of a Split: `edge` is the side its border lines (the left edge of
 * a preview on the right, the right edge of an editor on the left). `resize` gets the pointer's share
 * of the panel width while it is dragged.
 */
export function createDivider(edge: "left" | "right", resize: (ratio: number) => void): HTMLDivElement {
  const divider = document.createElement("div");
  divider.setAttribute("role", "separator");
  divider.setAttribute("aria-orientation", "vertical");
  divider.setAttribute("title", "Drag to resize");
  divider.style.cssText = [
    `flex:0 0 ${DIVIDER_WIDTH_PX}px`,
    "cursor:col-resize",
    "background:var(--colors-surface0)",
    `border-${edge}:1px solid var(--colors-border)`,
    "box-sizing:border-box",
    "-webkit-app-region:no-drag",
    "touch-action:none",
  ].join(";");
  divider.addEventListener("pointerdown", (event) => {
    const panel = divider.parentElement?.parentElement;
    if (!panel || event.button !== 0) return;
    event.preventDefault();
    divider.setPointerCapture(event.pointerId);
    // The editor and preview would otherwise take the pointer and select text while dragging. The
    // shield goes into the window showing the divider: the main window, or a companion window.
    const shield = divider.ownerDocument.createElement("div");
    shield.style.cssText = "position:fixed;inset:0;cursor:col-resize;z-index:2147483647;";
    divider.ownerDocument.body.appendChild(shield);
    const move = (moveEvent: PointerEvent) => {
      const bounds = panel.getBoundingClientRect();
      if (bounds.width > 0) resize((moveEvent.clientX - bounds.left) / bounds.width);
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
  });
  return divider;
}
