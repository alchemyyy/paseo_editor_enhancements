import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";

/** Explorer's `/select,` argument; a drive root stays unquoted so its slash is not read as an escaped quote */
export function explorerSelectArgument(target: string): string {
  return `/select,${target.endsWith("\\") ? target : `"${target}"`}`;
}

/**
 * Starts a GUI program detached from the plugin process. `child_process.spawn` directly: the SDK's
 * process helper hides windows, which starts Windows GUI apps hidden.
 */
function launchDetached(command: string, args: string[], windowsVerbatimArguments = false): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: false, windowsVerbatimArguments });
  child.once("error", reject);
  child.once("spawn", () => {
    child.unref();
    resolve();
  });
  return promise;
}

/**
 * Shows `target` selected in its folder in the host's file browser. A file that no longer exists
 * shows its nearest existing folder.
 */
export async function revealInFileBrowser(target: string): Promise<void> {
  let current = path.resolve(target);
  let stats = await stat(current).catch(() => null);
  while (!stats && path.dirname(current) !== current) {
    current = path.dirname(current);
    stats = await stat(current).catch(() => null);
  }
  if (!stats) throw new Error(`${target} does not exist`);
  const isFile = !stats.isDirectory();
  switch (process.platform) {
    case "win32":
      // Explorer parses its own command line, so the argument is passed verbatim
      await launchDetached("explorer.exe", [isFile ? explorerSelectArgument(current) : `"${current}"`], true);
      break;
    case "darwin":
      await launchDetached("open", isFile ? ["-R", current] : [current]);
      break;
    default:
      // Most Linux file managers have no portable "select"; open the folder
      await launchDetached("xdg-open", [isFile ? path.dirname(current) : current]);
  }
}
