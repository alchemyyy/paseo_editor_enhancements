import { createHash } from "node:crypto";
import { open, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  MAX_IMAGE_BYTES,
  MAX_RESOURCE_BYTES,
  type readFileRpc,
  type readImageRpc,
  type readResourceRpc,
  type resolveLinkRpc,
  type writeFileRpc,
} from "../shared/contracts";
import { candidatePaths, imageMimeType, resourceMimeType } from "./references";

async function workspaceRoot(context: PluginHandlerContext, workspaceId: string): Promise<string | null> {
  const { entries } = await context.paseo.workspaces.list({});
  const workspace = entries.find((entry) => entry.id === workspaceId);
  return workspace ? (workspace.workspaceDirectory ?? workspace.projectRootPath) : null;
}

type Found = { path: string; kind: "file" | "directory"; size: number };

/** The first candidate path of a reference that exists as a file or folder */
async function findReference(input: RpcInput<typeof readImageRpc>, context: PluginHandlerContext): Promise<Found | null> {
  const candidates = candidatePaths(input.reference, {
    markdownPath: input.markdownPath,
    workspaceRoot: await workspaceRoot(context, input.workspaceId),
    platform: process.platform,
    home: homedir(),
  });
  for (const candidate of candidates) {
    const stats = await stat(candidate).catch(() => null);
    if (stats?.isFile()) return { path: candidate, kind: "file", size: stats.size };
    if (stats?.isDirectory()) return { path: candidate, kind: "directory", size: 0 };
  }
  return null;
}

export async function readImage(
  input: RpcInput<typeof readImageRpc>,
  context: PluginHandlerContext,
): Promise<RpcOutput<typeof readImageRpc>> {
  const found = await findReference(input, context);
  if (!found || found.kind !== "file") throw new Error(`Image not found: ${input.reference}`);
  const mimeType = imageMimeType(found.path);
  if (!mimeType) throw new Error(`Not an image: ${input.reference}`);
  if (found.size > MAX_IMAGE_BYTES) throw new Error(`Image is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MiB`);
  const bytes = await readFile(found.path);
  return { mimeType, base64: bytes.toString("base64") };
}

export async function readResource(
  input: RpcInput<typeof readResourceRpc>,
  context: PluginHandlerContext,
): Promise<RpcOutput<typeof readResourceRpc>> {
  const found = await findReference(input, context);
  if (!found || found.kind !== "file") throw new Error(`File not found: ${input.reference}`);
  if (found.size > MAX_RESOURCE_BYTES) throw new Error(`File is larger than ${MAX_RESOURCE_BYTES / 1024 / 1024} MiB`);
  const bytes = await readFile(found.path);
  return { mimeType: resourceMimeType(found.path), base64: bytes.toString("base64") };
}

export async function resolveLink(
  input: RpcInput<typeof resolveLinkRpc>,
  context: PluginHandlerContext,
): Promise<RpcOutput<typeof resolveLinkRpc>> {
  const found = await findReference(input, context);
  return found ? { path: found.path, kind: found.kind } : { path: null, kind: null };
}

/** Larger files are cut off and opened read-only; a companion window is not a log tail */
const MAX_READ_BYTES = 4 * 1024 * 1024;

async function resolveFile(context: PluginHandlerContext, workspaceId: string, path: string): Promise<string> {
  if (isAbsolute(path)) return path;
  const root = await workspaceRoot(context, workspaceId);
  if (!root) throw new Error("Workspace not found");
  return resolve(root, path);
}

function hashOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function readWorkspaceFile(
  input: RpcInput<typeof readFileRpc>,
  context: PluginHandlerContext,
): Promise<RpcOutput<typeof readFileRpc>> {
  const absolutePath = await resolveFile(context, input.workspaceId, input.path);
  const handle = await open(absolutePath, "r");
  try {
    const { size } = await handle.stat();
    if (size <= MAX_READ_BYTES) {
      const bytes = await handle.readFile();
      return { absolutePath, content: bytes.toString("utf8"), size, hash: hashOf(bytes), truncated: false };
    }
    const bytes = Buffer.alloc(MAX_READ_BYTES);
    await handle.read(bytes, 0, MAX_READ_BYTES, 0);
    return { absolutePath, content: bytes.toString("utf8"), size, hash: "", truncated: true };
  } finally {
    await handle.close();
  }
}

export async function writeWorkspaceFile(
  input: RpcInput<typeof writeFileRpc>,
  context: PluginHandlerContext,
): Promise<RpcOutput<typeof writeFileRpc>> {
  const absolutePath = await resolveFile(context, input.workspaceId, input.path);
  const current = hashOf(await readFile(absolutePath));
  if (current !== input.expectedHash) return { status: "conflict", hash: current };
  const bytes = Buffer.from(input.content, "utf8");
  await writeFile(absolutePath, bytes);
  return { status: "saved", size: bytes.length, hash: hashOf(bytes) };
}
