import assert from "node:assert/strict";
import { test } from "node:test";
import { restorePinnedOrder } from "./pin-order.ts";

test("pinned tabs return to their index after a drag or an insert", () => {
  assert.deepEqual(restorePinnedOrder(["b", "a", "c"], new Map([["a", 0]])), ["a", "b", "c"]);
  assert.deepEqual(restorePinnedOrder(["new", "a", "b"], new Map([["b", 1]])), ["new", "b", "a"]);
});

test("indices clamp to the strip and absent pins are ignored", () => {
  assert.deepEqual(restorePinnedOrder(["a", "b"], new Map([["a", 5], ["gone", 0]])), ["b", "a"]);
  assert.deepEqual(restorePinnedOrder(["a", "b", "c"], new Map()), ["a", "b", "c"]);
});
