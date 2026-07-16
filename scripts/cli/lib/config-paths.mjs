import os from "node:os";
import path from "node:path";

/** XDG-aware root shared by compiled CLI code and raw-node support scripts. */
export function cliConfigRoot() {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return path.join(xdg || path.join(os.homedir(), ".config"), "vibestudio");
}

export function cliCredentialPath() {
  return path.join(cliConfigRoot(), "cli-credentials.json");
}

export function hubIdentityPath() {
  return path.join(cliConfigRoot(), "server-auth", "webrtc", "identity.pem");
}

export function workspaceIdentityPath(workspace = "default") {
  return path.join(cliConfigRoot(), "workspaces", workspace, "reach", "webrtc", "identity.pem");
}
