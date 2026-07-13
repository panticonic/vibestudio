import fsp from "node:fs/promises";
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

export function mintRemoteInvite({
  readyFile,
  kind = "desktop",
  timeoutMs = 180_000,
}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      callback();
    };
    const read = async () => {
      try {
        const payload = JSON.parse(await fsp.readFile(readyFile, "utf8"));
        const invite = payload?.rootInvites?.[kind];
        if (typeof invite?.pairUrl === "string" && invite.pairUrl) {
          finish(() => resolve(invite));
          return;
        }
        if (payload?.rootInvites === null) {
          finish(() => reject(new Error("root account already exists; no first-device invite is available")));
        }
      } catch (error) {
        if (Date.now() - startedAt >= timeoutMs) {
          finish(() => reject(error));
        }
      }
    };
    const poll = setInterval(() => void read(), 100);
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`root ${kind} invite timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    void read();
  });
}
