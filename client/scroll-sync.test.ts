import assert from "node:assert/strict";
import { test } from "node:test";
import { previewOffsetForLine } from "./scroll-sync.ts";

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
