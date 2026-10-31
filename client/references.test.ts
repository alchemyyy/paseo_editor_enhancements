import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyReference, splitLocalTarget } from "./references.ts";

test("a single-letter scheme is a Windows drive, so the path is local", () => {
  assert.equal(classifyReference("C:/Users/me/notes.md"), "local");
  assert.equal(classifyReference("d:\\docs\\a.png"), "local");
  assert.equal(classifyReference("file:///C:/docs/a.png"), "local");
});

test("relative, root-relative, and home paths are local", () => {
  for (const target of ["./img.png", "../docs/guide.md", "docs/guide.md#L3", "/assets/logo.svg", "~/notes.md"]) {
    assert.equal(classifyReference(target), "local", target);
  }
});

test("web and mail links are external; fragments stay in the document", () => {
  assert.equal(classifyReference("https://example.com/x"), "external");
  assert.equal(classifyReference("HTTP://example.com"), "external");
  assert.equal(classifyReference("mailto:me@example.com"), "external");
  assert.equal(classifyReference("#section-two"), "fragment");
});

test("other schemes and protocol-relative URLs are left alone", () => {
  for (const target of ["javascript:alert(1)", "vscode://file/x", "//cdn.example.com/a.png", "\\\\server\\share\\a.png", "  "]) {
    assert.equal(classifyReference(target), "other", target);
  }
});

test("a local target's #L line fragment becomes a line range", () => {
  assert.deepEqual(splitLocalTarget("src/a.ts#L12"), { path: "src/a.ts", lineStart: 12 });
  assert.deepEqual(splitLocalTarget("src/a.ts#L12-L20"), { path: "src/a.ts", lineStart: 12, lineEnd: 20 });
  assert.deepEqual(splitLocalTarget("src/a.ts#L20-L12"), { path: "src/a.ts", lineStart: 20 });
  assert.deepEqual(splitLocalTarget("guide.md#install"), { path: "guide.md" });
});
