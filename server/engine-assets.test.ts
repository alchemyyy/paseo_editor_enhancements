import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import vm from "node:vm";
import { gunzipSync } from "node:zlib";
import assets from "./vendor/engine-assets.json" with { type: "json" };

type Render = (markdown: string, lineOffset: number) => { html?: string; error?: string };

let render: Render;

function asset(name: keyof typeof assets): Buffer {
  return gunzipSync(Buffer.from(assets[name], "base64"));
}

before(async () => {
  // The client runs the engine in a worker; Node runs the same WebAssembly with Go's loader
  vm.runInThisContext(asset("wasm_exec.js").toString("utf8"));
  const go = new (Reflect.get(globalThis, "Go") as new () => { importObject: WebAssembly.Imports; run(instance: WebAssembly.Instance): Promise<void> })();
  const { instance } = await WebAssembly.instantiate(new Uint8Array(asset("gfm.wasm")), go.importObject);
  void go.run(instance);
  render = Reflect.get(globalThis, "paseoGfmRender") as Render;
});

after(() => {
  // The Go program stays parked waiting for calls
  setImmediate(() => process.exit(process.exitCode ?? 0));
});

function html(markdown: string, lineOffset = 0): string {
  const result = render(markdown, lineOffset);
  assert.equal(result.error, undefined);
  return result.html ?? "";
}

/** `tag:line` for each top-level block that carries a source line */
function sourceLines(rendered: string): string[] {
  return [...rendered.matchAll(/<(\w+)[^>]*\bdata-source-line="(\d+)"/g)].map(([, tag, line]) => `${tag}:${line}`);
}

test("top-level blocks carry the editor line they start on, offset past front matter", () => {
  const markdown = "# Title\n\nFirst paragraph\nstill first\n\n- one\n- two\n\n> quote\n\n| a |\n|---|\n| 1 |\n";
  assert.deepEqual(sourceLines(html(markdown)), ["h1:1", "p:3", "ul:6", "blockquote:9", "table:11"]);
  assert.deepEqual(sourceLines(html(markdown, 4)), ["h1:5", "p:7", "ul:10", "blockquote:13", "table:15"]);
});

test("Windows line endings count lines as the editor does", () => {
  assert.deepEqual(sourceLines(html("# Title\r\n\r\ntext\r\n\r\n## Next\r\n")), ["h1:1", "p:3", "h2:5"]);
});

test("Mermaid and map code blocks reach the page with their language class", () => {
  const rendered = html("```mermaid\ngraph TD\n```\n\n```geojson\n{}\n```\n\n```topojson\n{}\n```\n");
  for (const language of ["mermaid", "geojson", "topojson"]) assert.match(rendered, new RegExp(`<code class="language-${language}">`));
});

test("code is highlighted with chroma classes, which the palettes color", () => {
  assert.match(html("```go\nfunc main() {}\n```\n"), /<pre class="chroma"><code>.*<span class="kd">func<\/span>/s);
});
