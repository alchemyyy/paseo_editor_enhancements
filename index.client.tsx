import { openExternalUrl, type PluginClientContext } from "@getpaseo/plugin/client";
import { Platform } from "react-native";
import { startEditorTabs } from "./client/editor-tabs";
import { GfmEngine } from "./client/gfm-engine";
import { registerHost } from "./client/hosts";
import { startTextPanels } from "./client/text-panels";
import { engineAssetRpc, readFileRpc, readImageRpc, readResourceRpc, resolveLinkRpc, writeFileRpc } from "./shared/contracts";

export default function contribute(client: PluginClientContext) {
  // File panels, editors, and tab strips are reachable as DOM only on web and Electron
  if (Platform.OS !== "web") return () => {};
  const unregister = registerHost({
    ownsWorkspace: async (workspaceId) => {
      const { entries } = await client.paseo.workspaces.list({});
      return entries.some((entry) => entry.id === workspaceId);
    },
    readImage: (request) => client.rpc(readImageRpc, request),
    readResource: (request) => client.rpc(readResourceRpc, request),
    resolveLink: (request) => client.rpc(resolveLinkRpc, request),
    openExternal: openExternalUrl,
    readFile: (request) => client.rpc(readFileRpc, request),
    writeFile: (request) => client.rpc(writeFileRpc, request),
    start: (registry) => {
      // The GitHub engine comes from the server of the instance running this code, so its
      // renderer and page libraries match the client code that drives them
      const engine = new GfmEngine(async (name) => (await client.rpc(engineAssetRpc, { name })).gzipBase64);
      const stopPanels = startTextPanels(registry, engine);
      const stopTabs = startEditorTabs(registry, engine);
      return () => {
        stopTabs();
        stopPanels();
        engine.dispose();
      };
    },
  });
  return unregister;
}
