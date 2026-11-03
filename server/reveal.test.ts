import assert from "node:assert/strict";
import { test } from "node:test";
import { explorerSelectArgument } from "./reveal.ts";

test("Explorer's select argument quotes paths with spaces and commas, but not a drive root", () => {
  assert.equal(explorerSelectArgument("C:\\a b\\x,y.md"), '/select,"C:\\a b\\x,y.md"');
  assert.equal(explorerSelectArgument("C:\\"), "/select,C:\\");
});
