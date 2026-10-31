import assert from "node:assert/strict";
import { test } from "node:test";
import { paletteLayers, previewStylesheet } from "./palettes.ts";
import { CHROMA_GITHUB_DARK, CHROMA_GITHUB_LIGHT, CHROMA_PALETTE } from "./vendor/gfm-styles.ts";

const resolved = (...args: Parameters<typeof paletteLayers>) => Object.assign({}, ...paletteLayers(...args)) as Record<string, string>;

test("GitHub follows Paseo's light or dark scheme with GitHub's own colors", () => {
  assert.equal(resolved("github", "light")["--bgColor-default"], "#ffffff");
  assert.equal(resolved("github", "light")["color-scheme"], "light");
  assert.equal(resolved("github", "dark")["--bgColor-default"], "#0d1117");
  assert.equal(resolved("github", "dark")["color-scheme"], "dark");
});

test("Taiga Oak is dark oak and parchment in either Paseo scheme", () => {
  for (const scheme of ["light", "dark"] as const) {
    const variables = resolved("taiga-oak", scheme);
    assert.equal(variables["--bgColor-default"], "#251b13");
    assert.equal(variables["--fgColor-default"], "#f3e9d8");
    assert.equal(variables["--borderColor-default"], "#664b33");
    assert.equal(variables["--mde-table-header-bg"], "#2c3a25");
    assert.equal(variables["color-scheme"], "dark");
  }
});

test("the Paseo palette reads Paseo's live theme variables", () => {
  const variables = resolved("paseo", "light");
  assert.equal(variables["--bgColor-default"], "var(--colors-surface0)");
  assert.equal(variables["--fgColor-accent"], "var(--colors-accent-bright)");
  assert.equal(variables["--color-prettylights-syntax-keyword"], "var(--colors-syntax-keyword)");
  assert.equal(variables["color-scheme"], "var(--color-scheme)");
});

test("palettes change colors only: every palette keeps GitHub's type", () => {
  const github = resolved("github", "dark");
  for (const palette of ["paseo", "taiga-oak"] as const) {
    const variables = resolved(palette, "dark");
    assert.equal(variables["--fontStack-sansSerif"], github["--fontStack-sansSerif"]);
    assert.equal(variables["--fontStack-monospace"], github["--fontStack-monospace"]);
  }
});

test("code takes gh-gfm-preview's chroma colors under GitHub, and the palette's under the rest", () => {
  assert.ok(previewStylesheet("github", "light").includes(CHROMA_GITHUB_LIGHT));
  assert.ok(previewStylesheet("github", "dark").includes(CHROMA_GITHUB_DARK));
  for (const palette of ["paseo", "taiga-oak"] as const) assert.ok(previewStylesheet(palette, "light").includes(CHROMA_PALETTE));
  // Every color the GitHub style uses reads a palette variable instead
  assert.doesNotMatch(CHROMA_PALETTE, /#[0-9a-f]{6}\b/i);
  assert.match(CHROMA_PALETTE, /\.chroma \.k \{ color: var\(--color-prettylights-syntax-keyword\) \}/);
});
