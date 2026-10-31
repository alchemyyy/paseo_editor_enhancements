import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const MAX_REFERENCE_LENGTH = 2048;
/** Larger images are not shown in the preview */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const ReferenceInput = z.object({
  workspaceId: z.string().min(1),
  /** The Markdown file's path as its file tab names it: workspace-relative or absolute */
  markdownPath: z.string().min(1).max(MAX_REFERENCE_LENGTH),
  /** The image source or link target exactly as the Markdown wrote it */
  reference: z.string().min(1).max(MAX_REFERENCE_LENGTH),
});

/** Reads a local image a Markdown file references, relative to that file */
export const readImageRpc = defineRpc({
  name: "markdown.image",
  input: ReferenceInput,
  output: z.object({ mimeType: z.string(), base64: z.string() }),
});

/** Resolves a local link target a Markdown file contains to an existing file or folder on the daemon host */
export const resolveLinkRpc = defineRpc({
  name: "markdown.link",
  input: ReferenceInput,
  output: z.object({
    /** Absolute path on the daemon host, or null when nothing exists there */
    path: z.string().nullable(),
    kind: z.enum(["file", "directory"]).nullable(),
  }),
});

const FileLocation = z.object({ workspaceId: z.string().min(1), path: z.string().min(1) });

/** Reads a file for a companion window; `path` is workspace-relative or absolute */
export const readFileRpc = defineRpc({
  name: "files.read",
  input: FileLocation,
  output: z.object({
    absolutePath: z.string(),
    content: z.string(),
    /** Bytes on disk */
    size: z.number(),
    /** sha256 of the bytes on disk, for detecting changes made elsewhere */
    hash: z.string(),
    /** Set when the file was cut off at the size limit; such files are not saved */
    truncated: z.boolean(),
  }),
});

/** Saves a companion window's text unless the file changed since `expectedHash` was read */
export const writeFileRpc = defineRpc({
  name: "files.write",
  input: FileLocation.extend({ content: z.string(), expectedHash: z.string() }),
  output: z.discriminatedUnion("status", [
    z.object({ status: z.literal("saved"), size: z.number(), hash: z.string() }),
    z.object({ status: z.literal("conflict"), hash: z.string() }),
  ]),
});

/** The GitHub engine's files, fetched by the client on first use (scripts/vendor.mjs builds them) */
export const ENGINE_ASSETS = [
  "gfm.wasm",
  "wasm_exec.js",
  "mathjax.js",
  "mathjax-extensions.json",
  "mermaid.js",
  "leaflet.js",
  "leaflet.css",
  "topojson.js",
] as const;
export type EngineAssetName = (typeof ENGINE_ASSETS)[number];

/** One GitHub engine file, gzipped and base64-encoded */
export const engineAssetRpc = defineRpc({
  name: "markdown.engine-asset",
  input: z.object({ name: z.enum(ENGINE_ASSETS) }),
  output: z.object({ gzipBase64: z.string() }),
});
