import assert from "node:assert/strict";
import { test } from "node:test";
import { findMatches, stepMatch } from "./find-bar.ts";

test("matches ignore case, do not overlap, and stop at the limit", () => {
  assert.deepEqual(findMatches("aAa Aa", "aa"), [
    { from: 0, to: 2 },
    { from: 4, to: 6 },
  ]);
  assert.deepEqual(findMatches("abc", ""), []);
  assert.equal(findMatches("x".repeat(50), "x", 10).length, 10);
});

test("stepping moves past the selected match and wraps both ways", () => {
  const matches = findMatches("one two one two one", "one");
  assert.equal(stepMatch(matches, { from: 0, to: 0 }, true), 0);
  assert.equal(stepMatch(matches, matches[0], true), 1);
  assert.equal(stepMatch(matches, matches[2], true), 0);
  assert.equal(stepMatch(matches, matches[0], false), 2);
  assert.equal(stepMatch(matches, matches[2], false), 1);
  assert.equal(stepMatch([], { from: 0, to: 0 }, true), -1);
});
