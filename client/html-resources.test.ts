import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveAgainst } from "./html-resources.ts";

test("a stylesheet's relative references resolve against the stylesheet's folder", () => {
  assert.equal(resolveAgainst("css/site.css", "../img/logo.png"), "css/../img/logo.png");
  assert.equal(resolveAgainst("C:\\site\\css\\site.css", "fonts/a.woff2"), "C:\\site\\css\\fonts/a.woff2");
  assert.equal(resolveAgainst("site.css", "logo.png"), "logo.png");
});

test("root, home, absolute, file:, and web references stand as written", () => {
  for (const reference of ["/img/logo.png", "~/logo.png", "C:/img/logo.png", "file:///tmp/a.png", "https://example.com/a.png"]) {
    assert.equal(resolveAgainst("css/site.css", reference), reference);
  }
});
