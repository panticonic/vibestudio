import * as os from "node:os";
import * as path from "node:path";

/** Shared XDG-aware root for all CLI credentials and session state. */
export function cliConfigRoot(): string {
  const xdg = process.env["XDG_CONFIG_HOME"]?.trim();
  return xdg ? path.join(xdg, "vibestudio") : path.join(os.homedir(), ".config", "vibestudio");
}
