// Paseo's theme as the page shows it. Paseo switches themes, and follows the system's light or dark
// scheme, by changing the CSS variables in its stylesheets, which no DOM event reports and which
// can land after the scheme's media query reports a change. The surface color is sampled instead.

const THEME_POLL_MS = 250;

let probe: HTMLElement | null = null;
let watchers = 0;

/** Paseo's surface color as the browser resolves it, which its editors use as their background */
export function paseoSurface(): string {
  if (!probe?.isConnected) {
    probe = document.createElement("div");
    probe.style.cssText =
      "position:fixed;width:0;height:0;visibility:hidden;pointer-events:none;background-color:var(--colors-surface0);";
    document.body.appendChild(probe);
  }
  return getComputedStyle(probe).backgroundColor;
}

/** Calls `changed` after each change of Paseo's theme, until the returned function stops it */
export function watchPaseoTheme(changed: () => void): () => void {
  watchers++;
  let last = paseoSurface();
  const timer = setInterval(() => {
    const surface = paseoSurface();
    if (surface === last) return;
    last = surface;
    changed();
  }, THEME_POLL_MS);
  return () => {
    clearInterval(timer);
    if (--watchers > 0) return;
    probe?.remove();
    probe = null;
  };
}
