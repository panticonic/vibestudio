import { spawn, type ChildProcess } from "node:child_process";

export interface BrowserLaunchCommand {
  command: string;
  args: string[];
}

/** Resolve the platform-native browser launcher without involving a shell. */
export function browserLaunchCommand(
  url: string,
  platform: NodeJS.Platform = process.platform
): BrowserLaunchCommand {
  const protocol = new URL(url).protocol;
  if (protocol !== "https:" && protocol !== "http:") {
    throw new Error(`Cannot open non-HTTP browser URL (${protocol})`);
  }

  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") {
    return {
      command: "rundll32",
      args: ["url.dll,FileProtocolHandler", url],
    };
  }
  if (platform === "linux" || platform === "freebsd" || platform === "openbsd") {
    return { command: "xdg-open", args: [url] };
  }
  throw new Error(`Opening a system browser is not supported on ${platform}`);
}

/**
 * Open an HTTP(S) URL with the OS browser. The promise settles on the child
 * process' spawn/error event so a missing launcher fails immediately instead
 * of becoming an OAuth callback timeout.
 */
export function openExternalBrowser(
  url: string,
  options: {
    platform?: NodeJS.Platform;
    spawnProcess?: typeof spawn;
  } = {}
): Promise<void> {
  const launch = browserLaunchCommand(url, options.platform);
  const spawnProcess = options.spawnProcess ?? spawn;

  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnProcess(launch.command, launch.args, {
        detached: true,
        stdio: "ignore",
      });
    } catch (error) {
      reject(error);
      return;
    }

    let settled = false;
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve();
    });
  });
}
