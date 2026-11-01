import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PREFS, opensInSplit, parsePrefs, PrefsStore, splitChoice, syncChoice, syncsScroll } from "./prefs.ts";

function memoryStorage() {
  const stored = new Map<string, string>();
  return { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => void stored.set(key, value) };
}

test("defaults: Paseo's engine, GitHub's palette for the GitHub engine, Preview first, an even Split", () => {
  assert.deepEqual(parsePrefs(null), {
    engine: "paseo",
    palette: "github",
    openInSplit: false,
    htmlOpenInSplit: false,
    syncScroll: true,
    htmlSyncScroll: false,
    htmlResources: false,
    splitRatio: 0.5,
  });
});

test("corrupt or foreign storage falls back field by field", () => {
  assert.deepEqual(parsePrefs("not json"), DEFAULT_PREFS);
  assert.deepEqual(parsePrefs("[1,2]"), DEFAULT_PREFS);
  assert.deepEqual(parsePrefs(JSON.stringify({ engine: "pandoc", palette: "solarized", splitRatio: 3 })), {
    ...DEFAULT_PREFS,
    splitRatio: 0.8,
  });
});

test("the earlier theme setting becomes an engine and a palette", () => {
  const migrated = (stored: object) => {
    const { engine, palette } = parsePrefs(JSON.stringify(stored));
    return { engine, palette };
  };
  assert.deepEqual(migrated({ theme: "paseo", inheritColors: true }), { engine: "paseo", palette: "github" });
  assert.deepEqual(migrated({ theme: "github", inheritColors: false }), { engine: "github", palette: "github" });
  assert.deepEqual(migrated({ theme: "taiga-oak" }), { engine: "github", palette: "taiga-oak" });
  // "Paseo colors" painted either theme in Paseo's colors, which is now the Paseo palette
  assert.deepEqual(migrated({ theme: "taiga-oak", inheritColors: true }), { engine: "github", palette: "paseo" });
  // Split and the divider carry over unchanged
  assert.deepEqual(parsePrefs(JSON.stringify({ theme: "github", openInSplit: true, splitRatio: 0.3 })), {
    engine: "github",
    palette: "github",
    openInSplit: true,
    htmlOpenInSplit: false,
    syncScroll: true,
    htmlSyncScroll: false,
    htmlResources: false,
    splitRatio: 0.3,
  });
  // A setting already in the new form wins over a leftover theme
  assert.deepEqual(migrated({ engine: "paseo", palette: "taiga-oak", theme: "github" }), { engine: "paseo", palette: "taiga-oak" });
});

test("updates persist, clamp the split, and notify only on change", () => {
  const storage = memoryStorage();
  const store = new PrefsStore(storage);
  let notified = 0;
  store.subscribe(() => notified++);
  store.update({ engine: "github", splitRatio: 0.05 });
  store.update({ engine: "github" });
  assert.equal(notified, 1);
  assert.deepEqual(new PrefsStore(storage).get(), { ...DEFAULT_PREFS, engine: "github", splitRatio: 0.2 });
});

test("Markdown and HTML files each remember whether they open in Split", () => {
  const storage = memoryStorage();
  const store = new PrefsStore(storage);
  store.update(splitChoice("html", "split"));
  assert.equal(opensInSplit(store.get(), "html"), true);
  assert.equal(opensInSplit(store.get(), "markdown"), false);
  store.update(splitChoice("markdown", "split"));
  store.update(splitChoice("html", "source"));
  const reloaded = new PrefsStore(storage).get();
  assert.equal(opensInSplit(reloaded, "markdown"), true);
  assert.equal(opensInSplit(reloaded, "html"), false);
});

test("scroll sync is on for Markdown and off for HTML until chosen, each kind on its own", () => {
  const storage = memoryStorage();
  const store = new PrefsStore(storage);
  assert.equal(syncsScroll(store.get(), "markdown"), true);
  assert.equal(syncsScroll(store.get(), "html"), false);
  store.update(syncChoice("html", true));
  store.update(syncChoice("markdown", false));
  const reloaded = new PrefsStore(storage).get();
  assert.equal(syncsScroll(reloaded, "html"), true);
  assert.equal(syncsScroll(reloaded, "markdown"), false);
});
