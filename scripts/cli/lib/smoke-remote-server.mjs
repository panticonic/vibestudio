import path from "node:path";

export function createRemoteServeArgs(repoRoot, readyFile, port) {
  return [
    path.join(repoRoot, "scripts", "cli", "remote-serve.mjs"),
    "--app-root",
    repoRoot,
    "--port",
    String(port),
    "--ready-file",
    readyFile,
  ];
}

export function requireRootInvite(ready, client) {
  if (client !== "desktop" && client !== "mobile") {
    throw new Error(`unsupported root-invite client: ${client}`);
  }
  const invite = ready.rootInvites?.[client];
  if (!invite) {
    throw new Error(
      `Fresh smoke hub did not publish the ${client} root invite in its ready-file contract`
    );
  }
  return invite;
}
