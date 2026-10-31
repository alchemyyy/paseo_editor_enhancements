import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLimit, selectEvictions, type LruTab } from "./lru.ts";

const file = (tabId: string, lastUsed: number): LruTab => ({ tabId, isFile: true, lastUsed });
const chat = (tabId: string, lastUsed: number): LruTab => ({ tabId, isFile: false, lastUsed });

test("closes the least recently used files down to the limit", () => {
  const tabs = [file("a", 30), file("b", 10), chat("c", 0), file("d", 20), file("e", 40)];
  assert.deepEqual(selectEvictions(tabs, 2, "e", new Set()), ["b", "d"]);
});

test("off, under the limit, focused and unsaved tabs close nothing", () => {
  const tabs = [file("a", 1), file("b", 2), file("c", 3)];
  assert.deepEqual(selectEvictions(tabs, 0, null, new Set()), []);
  assert.deepEqual(selectEvictions(tabs, 3, null, new Set()), []);
  assert.deepEqual(selectEvictions(tabs, 1, "a", new Set(["b"])), ["c"]);
});

test("limits parse to whole numbers within range", () => {
  assert.equal(parseLimit("5", 99), 5);
  assert.equal(parseLimit("", 99), 0);
  assert.equal(parseLimit("-3", 99), 0);
  assert.equal(parseLimit("500", 99), 99);
});
