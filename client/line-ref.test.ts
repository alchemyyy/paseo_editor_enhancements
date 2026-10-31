import assert from "node:assert/strict";
import { test } from "node:test";
import { formatLineReference, formatLineSpec, lineRange } from "./line-ref.ts";

test("runs collapse to ranges and disjoint lines stay separate", () => {
  assert.equal(formatLineSpec([44, 45, 46, 47, 48, 49, 50]), "44-50");
  assert.equal(formatLineSpec([50, 44, 46, 48, 49, 48]), "44,46,48-50");
  assert.equal(formatLineSpec([7]), "7");
  assert.equal(formatLineSpec([]), "");
});

test("references join the path and the spec", () => {
  assert.equal(formatLineReference("filename.txt", lineRange(50, 44)), "filename.txt:44-50");
  assert.equal(formatLineReference("src/a.ts", []), "src/a.ts");
});
