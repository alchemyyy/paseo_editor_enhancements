import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { engineAssetRpc } from "../shared/contracts";
// Built by scripts/vendor.mjs; esbuild bundles the JSON into the server, since a plugin's server
// code is evaluated from memory and has no directory to read files from
import assets from "./vendor/engine-assets.json" with { type: "json" };

export function engineAsset({ name }: RpcInput<typeof engineAssetRpc>): RpcOutput<typeof engineAssetRpc> {
  return { gzipBase64: assets[name] };
}
