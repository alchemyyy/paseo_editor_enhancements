import assert from "node:assert/strict";
import { test } from "node:test";
import { candidatePaths } from "./references.ts";

const windows = {
  markdownPath: "docs/guide.md",
  workspaceRoot: "C:\\repo",
  platform: "win32" as const,
  home: "C:\\Users\\me",
};
const posix = { markdownPath: "docs/guide.md", workspaceRoot: "/repo", platform: "linux" as const, home: "/home/me" };

test("relative references resolve against the Markdown file's folder", () => {
  assert.deepEqual(candidatePaths("img/a%20b.png?raw=1", windows), ["C:\\repo\\docs\\img\\a b.png"]);
  assert.deepEqual(candidatePaths("../README.md#usage", posix), ["/repo/README.md"]);
  assert.deepEqual(candidatePaths("a.png", { ...posix, markdownPath: "/elsewhere/notes.md" }), ["/elsewhere/a.png"]);
});

test("/x is the workspace root first, as on GitHub, then a POSIX host path", () => {
  assert.deepEqual(candidatePaths("/assets/logo.svg", posix), ["/repo/assets/logo.svg", "/assets/logo.svg"]);
  assert.deepEqual(candidatePaths("/assets/logo.svg", windows), ["C:\\repo\\assets\\logo.svg"]);
});

test("absolute, home, and file: references stand as written", () => {
  assert.deepEqual(candidatePaths("D:/shots/one.png", windows), ["D:\\shots\\one.png"]);
  assert.deepEqual(candidatePaths("~/pics/a.png", posix), ["/home/me/pics/a.png"]);
  assert.deepEqual(candidatePaths("file:///C:/shots/one.png", windows), ["C:\\shots\\one.png"]);
});

test("a relative reference without a known workspace resolves nowhere", () => {
  assert.deepEqual(candidatePaths("img.png", { ...posix, workspaceRoot: null }), []);
});
