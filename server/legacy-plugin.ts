import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { execCommand } from "@getpaseo/plugin/server";
import { z } from "zod";

/** This plugin's former id: with both installed, the Markdown panels would be augmented twice */
const LEGACY_PLUGIN_ID = "markdown-enhancements";
// Lets the daemon finish starting its plugins before it is asked to remove one
const START_DELAY_MS = 5_000;
const REMOVE_TIMEOUT_MS = 120_000;

/** The slice of Paseo's config.json this reads: configured plugins by id */
const PaseoConfigSchema = z.object({ plugins: z.record(z.string(), z.unknown()).optional() });

/** Removes the plugin this one replaced, when Paseo still has it configured; returns the cleanup */
export function scheduleLegacyRemoval(): () => void {
  const timer = setTimeout(() => void removeLegacyPlugin(), START_DELAY_MS);
  return () => clearTimeout(timer);
}

async function removeLegacyPlugin(): Promise<void> {
  // The daemon exports PASEO_HOME to its plugin processes; ~/.paseo is its own default
  const home = process.env.PASEO_HOME?.trim() || path.join(homedir(), ".paseo");
  let plugins: Record<string, unknown> | undefined;
  try {
    plugins = PaseoConfigSchema.parse(JSON.parse(await readFile(path.join(home, "config.json"), "utf8"))).plugins;
  } catch {
    return;
  }
  if (!plugins || !(LEGACY_PLUGIN_ID in plugins)) return;
  // The plugin SDK cannot manage plugins, so this goes through the CLI of the daemon this plugin runs in
  const exported = process.env.PASEO_CLI?.trim();
  const bundled = path.join(path.dirname(process.execPath), "resources", "bin", "paseo.cmd");
  let cli = { command: process.platform === "win32" && existsSync(bundled) ? bundled : "paseo", prefixArgs: [] as string[] };
  if (exported) cli = /\.[cm]?js$/i.test(exported) ? { command: process.execPath, prefixArgs: [exported] } : { command: exported, prefixArgs: [] };
  try {
    await execCommand(cli.command, [...cli.prefixArgs, "plugin", "remove", LEGACY_PLUGIN_ID], {
      env: process.env,
      timeout: REMOVE_TIMEOUT_MS,
    });
    console.log(`[editor-enhancements] Removed ${LEGACY_PLUGIN_ID}, this plugin's former id`);
  } catch (error) {
    console.error(`[editor-enhancements] Could not remove ${LEGACY_PLUGIN_ID}`, error instanceof Error ? error.message : error);
  }
}

