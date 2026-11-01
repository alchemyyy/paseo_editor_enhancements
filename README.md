# Editor enhancements

Paseo plugin for file editing: Markdown renderers (Paseo's own, or GitHub's as gh-gfm-preview renders it, offline) with color palettes and a live Split view, a live Split view for HTML pages, pinned tabs, a per-pane LRU tab limit, gutter line references for chat, and file editors in separate OS windows.

## Install

Requires [Paseo](https://paseo.sh) 0.13.0 or later with plugins turned on (Settings > Plugins > Enable plugins).

```sh
paseo plugin install https://github.com/alchemyyy/paseo_editor_enhancements
```

On start, the plugin removes `markdown-enhancements`, its former id, if Paseo still has it installed, since both would augment the Markdown panels.

`paseo plugin update editor-enhancements` updates it, and `paseo plugin remove editor-enhancements` removes it. The [Plugin manager](https://github.com/alchemyyy/paseo_plugin_manager) plugin checks and updates installed plugins from the sidebar.

The `paseo` command comes with the desktop app: Settings > Integrations > Command line puts it on `PATH`, or run `paseo.cmd` from the app's `resources\bin` folder.

To work on the plugin, clone this repository and install the folder instead (`paseo plugin install <folder>`), then run `paseo plugin reload editor-enhancements` after editing it.

## Features

### Markdown

The toolbar of every `.md` / `.markdown` file gets, left of the view control: a **Renderer** dropdown, a **Palette** dropdown, and **Preview | Split | Source** in place of Paseo's Preview | Source.

#### Renderers

- **Paseo** (default): Paseo's own Markdown preview, unchanged, always in Paseo's theme (the palette dropdown is disabled).
- **GitHub**: [gh-gfm-preview](https://github.com/thiagokokada/gh-gfm-preview)'s GitHub Flavored Markdown renderer, built from its source into WebAssembly and run offline in a worker in the client. Nothing calls GitHub or any other service. It renders as gh-gfm-preview does: goldmark with tables, strikethrough, autolinks, task lists, footnotes, alerts (`> [!NOTE]` and others), `:emoji:` shortcodes, heading anchors, and chroma-highlighted code; gh-gfm-preview's page layout and code copy buttons; Mermaid diagrams with pan, zoom, reset, and a full-pane view; MathJax for `$…$`, `$$…$$`, `\(…\)`, and `\[…\]`; and GeoJSON/TopoJSON maps.
  - Same libraries as gh-gfm-preview (Mermaid 11.3.0, MathJax 3.2.2, Leaflet 1.9.4, TopoJSON 3.1.0), loaded from the plugin when a document first needs them. MathJax draws SVG instead of HTML with web fonts, and maps show their shapes without gh-gfm-preview's online map tiles, so both stay offline.
  - Beyond gh-gfm-preview: YAML front matter shows as a table, as on GitHub; raw HTML is sanitized (DOMPurify: no scripts, event handlers, styles, or forms), as on GitHub; local images and links work as below.

#### Palettes

Colors for the GitHub renderer; type and layout stay gh-gfm-preview's.

- **GitHub** (default): GitHub's colors and gh-gfm-preview's chroma code colors, light or dark as Paseo's theme is.
- **Paseo**: Paseo's current theme colors (surfaces, text, borders, accent, status and syntax colors), following Paseo theme changes live.
- **Taiga Oak**: dark oak and parchment (background `#251b13`, text `#f3e9d8`, raised `#36281b`, deep taiga green `#2c3a25`, oak grain borders `#664b33`, moss accent `#6f9f55`, light tan `#cfb795`, weathered oak `#9c7552`) with earthy code colors.

Mermaid diagrams use Mermaid's default theme under light palettes and its dark theme under dark ones.

- Local images (relative to the file, `/` from the workspace root, absolute, `~/`, or `file:`) load through the daemon: PNG, JPEG, GIF, WebP, SVG, AVIF, BMP, ICO, APNG, up to 20 MiB.
- Clicking a local link opens the file in Paseo, at the line for `#L12` / `#L12-L20`; Ctrl/Cmd-click opens it to the side. Web and mail links open in the system browser. `#heading` links scroll the preview.

#### Split

- **Split** shows an editor on the left and the preview on the right, updating as you type, from the unsaved buffer, before Paseo's autosave writes the file. Drag the divider to resize (20-80%).
  - GitHub renderer: Paseo's Source editor beside the GitHub rendering. Only changed blocks re-render, so images, diagrams, math, and scroll position hold still. The preview follows the editor's scroll by source line.
  - Paseo renderer: Paseo's own preview beside a copy of Paseo's Source editor (same theme, keymaps, vim mode, and line references), editing the same buffer, so Paseo's autosave and conflict handling apply. The preview follows the editor's scroll by position. Switching between Split and Source keeps the cursor and scroll. After a Paseo theme change the copy is rebuilt in the new theme.
- Choosing Split makes new Markdown tabs open in Split; choosing Preview or Source returns to Paseo's default (Preview, or Source for a line target).
- The GitHub renderer's Preview also follows the unsaved buffer.
- **Sync scroll**, left of Preview | Split | Source, turns the Split preview's following of the editor's scroll on or off (on by default for Markdown).

Paseo's renderer can always be chosen. Where it cannot show the view, the GitHub renderer shows it with a note at the top of the preview saying why: in companion windows (Paseo's preview exists only in the main window), in Split for read-only files (the copied editor edits the buffer), and in Split when Paseo's editor could not be copied (choosing a renderer or view tries again; the reason is also logged to the developer console).

Renderer, palette, Split-by-default, and the divider position are stored per device (browser `localStorage`); the earlier theme setting carries over (Paseo → Paseo renderer; GitHub or Taiga Oak → GitHub renderer in that palette, or in the Paseo palette if **Paseo colors** was on). In narrow panes the toolbar drops the dropdowns' captions, then the palette dropdown, then the renderer dropdown, so Preview | Split | Source stays visible.

### HTML

The toolbar of every `.html` / `.htm` file gets **Preview | Split | Source** in place of Paseo's Preview | Source.

- **Preview** and **Source** are Paseo's own: its sandboxed page and its editor (with **Resources** on, the plugin's page stands in for Paseo's Preview, which cannot load them).
- **Split** narrows Paseo's Source editor to the left and shows the page on the right, from the unsaved buffer. The page updates once typing pauses (300 ms; 800 ms for files over 200,000 characters). Each update loads in a hidden frame and replaces the page once loaded, so the page does not flash and keeps its scroll position. Drag the divider to resize (20-80%); Markdown and HTML share the divider position.
- **Sync scroll** makes the page follow the editor's scroll by position. It is off by default for HTML, so the page scrolls on its own; Markdown and HTML remember it separately.
- The page renders in the plugin's own frame, isolated as Paseo's Preview is (Paseo's SECURITY.md, "HTML file preview"): an opaque-origin frame (`sandbox="allow-scripts"`) under Paseo's content security policy. Inline scripts and styles run, but the page cannot reach Paseo, storage, cookies, the network, or any file but itself. Nothing loads by path or URL; images, fonts, and media embedded as `data:` URLs show.
- **Resources** (off by default, per device) lets the page load from the web (images, stylesheets, scripts, fonts, media, `fetch` and WebSockets, subject to the sites' CORS) and load the local files it references: `src`/`href` of images, media, scripts, stylesheets, and icons, and `url()` / `@import` in styles, relative to the page (or a stylesheet), `/` from the workspace root, absolute, `~/`, or `file:`, up to 20 MiB each. Local files are read through the daemon and written into the page as `data:` URLs, re-read at most every 5 seconds while you type; a referenced file changed on disk shows with the next edit or toggle. The page stays isolated from Paseo, but whatever it loads, it can send to the web, so turn this on only for pages you trust.
- Choosing Split makes new HTML tabs open in Split; choosing Preview or Source returns to Paseo's default (Preview, or Source for a line target). HTML and Markdown remember this separately.
- Read-only HTML panels (files over 1 MiB) get the same Split, showing the file as saved and re-reading it when it changes on disk.

### Pinned tabs

- A file tab's context menu has **Pin tab** / **Unpin tab** (after better-chat-management's split entries, when that plugin is installed).
- A pinned tab keeps its position in its pane's strip and shows a pin icon beside its file icon, in the label's color.
- Pinned tabs are exempt from the LRU limit, and better-chat-management's close-left/right/others skips them.

### LRU tab limit

- Each file pane's strip has an **LRU** box (0–99, 0 = off; the mouse wheel steps it). When a pane has more file tabs than the limit, the least recently focused ones close. The focused tab, pinned tabs, and tabs with unsaved changes never close.

### Line references

- In the Source editor, click line numbers to select lines. Ctrl/Cmd+click adds or removes a line, Shift+click selects a range, dragging selects several lines, and Escape clears.
- Drag a selection into a chat composer (or anywhere in a chat pane) to insert `` `path:44,46,48-50` ``.

### Companion windows (desktop)

- Drag a file tab out of the main window, or use the undock button at the left of a pane's strip (click or drag), to move the pane's files into a separate editor window. A preview window follows the pointer while dragging. Tabs with unsaved changes stay in the main window.
- The companion window has tabs, **Save**, **Reload**, and **Dock** buttons, and a bar with file size, line count, and cursor position. It edits with a copy of Paseo's Source editor, so it supports Mod-s, line selection, and dragging line references into the main window's chats.
- Markdown tabs get the same Renderer and Palette dropdowns and **Preview | Split | Source** at the right of that bar. Paseo's own preview exists only in the main window, so companion windows render with the GitHub renderer; with Paseo's renderer chosen, the preview says so. HTML tabs get **Preview | Split | Source**, with the plugin's page serving both Preview and Split. A tab keeps its layout when torn out and when docked back (a Markdown or HTML tab on Preview is switched to Source for a moment so its editor can be copied). The preview follows the companion editor's unsaved text and scroll, and Markdown links open in the main window. Renderer, palette, Split-by-default, and the divider position are shared with the main window.
- Tabs can be dragged between companion windows and back into the main window.
- Saving checks whether the file changed on disk since it was loaded and reports a conflict. Closing a tab or window with unsaved edits saves them first.
- Files over 4 MB open read-only, showing the first 4 MB. Companion windows reopen at the size you last used and close with the main window.
- Server RPCs `files.read` and `files.write` read and save by workspace-relative or absolute path; writes check the file's sha256 first.

Pins, LRU limits, and the companion window size are kept in `localStorage` under better-chat-management's former id, `better-chat-display`, where they lived before moving to this plugin.

## Limitations

- Works only in the web and desktop (Electron) clients; native clients keep Paseo's viewer unchanged.
- The plugin SDK cannot extend Paseo's built-in file panels or tab strips, so the plugin reads Paseo's internal React fibers (panel, toolbar view setter, editor buffer, pane context, layout store) and patches the toolbar, tab strip, and context menu DOM. A Paseo update can break it; an unrecognized panel is left alone.
- Companion windows and the Paseo renderer's Split rely on CodeMirror private API (`cmTile`, `state.config.base`) to copy the Source editor. Paseo's find bar (Ctrl+F) does not open in a copied editor.
- Read-only Markdown panels (files over 1 MiB) show the file as saved, re-read when it changes on disk. Their Split uses the GitHub renderer, since the Paseo renderer's Split edits the buffer.
- The GitHub renderer shares gh-gfm-preview's limits: math is found in the rendered HTML, so Markdown inside `$…$` (such as `_` pairs) can break it, and GitHub-only features such as @mentions and issue references are plain text. Mermaid, MathJax, Leaflet, and TopoJSON load as page globals (`mermaid`, `MathJax`, `L`, `topojson`) the first time a document uses them.
- Local images are cached for the session; an image changed on disk shows after the plugin reloads or Paseo restarts.
- Reloading the plugin returns open Markdown and HTML tabs to the remembered default layout.
- An HTML page's scripts run again with each update. A page whose script never returns (such as a loop left unfinished mid-edit) holds up every later update, since the browser runs the sandboxed pages in one process. After 10 seconds the plugin drops that page and the page shown with it, with a note saying why, and tries the current text again 3 seconds later; if it gets stuck again, the next edit tries again.

## Development

- `npm run vendor` (`scripts/vendor.mjs`) builds everything the plugin ships instead of `node_modules`:
  - `client/vendor/markdown.js`: `vendor-src/markdown.ts` with DOMPurify and yaml (front matter, sanitizing); `markdown.d.ts` beside it is hand-written.
  - `client/vendor/github-markdown.ts`: github-markdown-css split into its rules and light/dark color variables; `client/vendor/gfm-styles.ts`: gh-gfm-preview's chroma CSS, and the same rules reading palette variables.
  - `server/vendor/engine-assets.json`: the GitHub renderer, gzipped and base64-encoded (about 6 MB), which the server bundles and serves over the `markdown.engine-asset` RPC. It downloads gh-gfm-preview at a pinned commit into `node_modules/.cache`, adds `vendor-src/gfm/` (a `js/wasm` entry point and a parser hook for source-line marks) to its `internal/app` package, builds it with Go 1.25+ (the `go` on `PATH`, `GO=<path>`, or a pinned Go it downloads into `node_modules/.cache`), renders a sample to check the build, and adds Go's `wasm_exec.js`, MathJax's `tex-mml-svg.js` and TeX extensions (npm `mathjax@3.2.2`), and gh-gfm-preview's Mermaid, Leaflet, and TopoJSON files.
  - `client/vendor/THIRD_PARTY_LICENSES.txt` and `server/vendor/THIRD_PARTY_LICENSES.txt`.
- `npm run typecheck`, `npm test`.
- `client/html-page.ts` carries a copy of Paseo's HTML preview policy (`packages/app/src/file-panels/html-preview-csp.ts`, unchanged through Paseo 0.15); keep the two in step.
