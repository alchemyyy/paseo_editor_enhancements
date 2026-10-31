// Declarations of markdown.js, the bundle scripts/vendor.mjs builds from vendor-src/markdown.ts.

export interface FrontMatter {
  /** GitHub's table of the front matter: keys across the header, values below */
  html: string;
  /** The Markdown after the front matter */
  body: string;
  /** Lines the front matter took, which the body's source lines are offset by */
  lineOffset: number;
}

/** The YAML front matter of a document as GitHub shows it, or null when there is none or it is not a mapping */
export declare function splitFrontMatter(source: string): FrontMatter | null;

/**
 * Rendered Markdown made safe to insert into Paseo's window. Local image sources and link targets
 * move into `data-mde-src` / `data-mde-href`.
 */
export declare function sanitizeHtml(html: string): string;
