import assert from "node:assert/strict";
import { test } from "node:test";
import { increasingAnchors, previewOffsetForLine } from "./scroll-sync.ts";

const anchors = [
  { line: 3, top: 100 },
  { line: 7, top: 300 },
  { line: 8, top: 340 },
];
const end = { line: 21, top: 1000 };

test("a block's first line puts the block at the top", () => {
  assert.equal(previewOffsetForLine(anchors, 3, end), 100);
  assert.equal(previewOffsetForLine(anchors, 7, end), 300);
});

test("lines inside a block interpolate toward the next block", () => {
  assert.equal(previewOffsetForLine(anchors, 5, end), 200);
  assert.equal(previewOffsetForLine(anchors, 7.5, end), 320);
});

test("lines before the first block scroll from the top; lines in the last block toward the end", () => {
  assert.equal(previewOffsetForLine(anchors, 1, end), 0);
  assert.equal(previewOffsetForLine(anchors, 2, end), 50);
  assert.equal(previewOffsetForLine(anchors, 14.5, end), 670);
  assert.equal(previewOffsetForLine(anchors, 40, end), 1000);
});

test("without rendered blocks the whole document is one span", () => {
  assert.equal(previewOffsetForLine([], 11, end), 500);
});

test("a block rendered out of source order does not pull later lines toward it", () => {
  // Footnotes render at the bottom but carry the line of their first definition
  const rendered = [...anchors, { line: 12, top: 600 }, { line: 18, top: 800 }, { line: 5, top: 900 }];
  const kept = increasingAnchors(rendered);
  assert.deepEqual(
    kept.map((anchor) => anchor.line),
    [3, 7, 8, 12, 18],
  );
  assert.equal(previewOffsetForLine(kept, 15, end), 700);
});

test("blocks without a source line are dropped", () => {
  assert.deepEqual(increasingAnchors([{ line: 0, top: 0 }, { line: Number.NaN, top: 10 }, ...anchors]), anchors);
});
