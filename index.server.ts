import type { PluginServerContext } from "@getpaseo/plugin/server";
import { engineAsset } from "./server/engine-assets";
import { readImage, readWorkspaceFile, resolveLink, writeWorkspaceFile } from "./server/handlers";
import { engineAssetRpc, readFileRpc, readImageRpc, resolveLinkRpc, writeFileRpc } from "./shared/contracts";

export default function contribute(server: PluginServerContext) {
  server.handle(readImageRpc, readImage);
  server.handle(resolveLinkRpc, resolveLink);
  server.handle(readFileRpc, readWorkspaceFile);
  server.handle(writeFileRpc, writeWorkspaceFile);
  server.handle(engineAssetRpc, engineAsset);
  return () => {};
}
