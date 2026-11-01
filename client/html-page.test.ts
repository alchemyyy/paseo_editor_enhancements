import assert from "node:assert/strict";
import { test } from "node:test";
import { pageDocument, parsePageMessage } from "./html-page.ts";

test("Paseo's policy opens the document, ahead of the page script and everything the file declares", () => {
  const file =
    '<!DOCTYPE html><meta http-equiv="Content-Security-Policy" content="script-src *"><script>fetch("https://example.com")</script>';
  const document = pageDocument(file, { x: 0, y: 120 }, "0f");
  assert.ok(document.startsWith(`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none';`));
  const policyEnd = document.indexOf(">", "<!doctype html>".length) + 1;
  assert.ok(document.indexOf("<script") >= policyEnd, "no script precedes the policy");
  assert.ok(document.endsWith(file), "the file follows as written");
});

test("a leading byte order mark is dropped, which would otherwise render as a zero-width space", () => {
  const document = pageDocument("\uFEFF<p>héllo</p>\uFEFF", null, "0f");
  assert.ok(document.endsWith("<p>héllo</p>\uFEFF"));
  assert.equal(document.indexOf("\uFEFF"), document.length - 1);
});

test("only well-formed, signed page messages are taken; scroll offsets are zero or more", () => {
  const scroll = (x: unknown, y: unknown, token: unknown = "ab") => ({ type: "editor-enhancements:page-scroll", token, x, y });
  assert.deepEqual(parsePageMessage({ type: "editor-enhancements:page-ready", token: "ab" }), { type: "ready", token: "ab" });
  assert.deepEqual(parsePageMessage(scroll(12, 340.5)), { type: "scroll", token: "ab", scroll: { x: 12, y: 340.5 } });
  assert.deepEqual(parsePageMessage(scroll(-4, -1)), { type: "scroll", token: "ab", scroll: { x: 0, y: 0 } });
  for (const data of [
    null,
    "editor-enhancements:page-ready",
    { type: "editor-enhancements:page-ready" },
    scroll(1, 2, 7),
    scroll("12", 3),
    scroll(1, Number.NaN),
    scroll(Number.POSITIVE_INFINITY, 0),
    { type: "editor-enhancements:page-follow", token: "ab", ratio: 0.5 },
  ]) {
    assert.equal(parsePageMessage(data), null);
  }
});
