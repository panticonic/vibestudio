import { spawn } from "node:child_process";
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
  repoRoot,
  env,
  port,
  workspace = "default",
  timeoutMs = 180_000,
}) {
  const cliEntry = path.join(repoRoot, "dist", "cli", "client.mjs");
  const args = [
    cliEntry,
    "remote",
    "invite",
    "--port",
    String(port),
    "--workspace",
    workspace,
    "--json",
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`remote invite timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(
            `remote invite failed (code=${code}, signal=${signal ?? "none"}): ${stderr || stdout}`
          )
        );
        return;
      }
      try {
        const line = stdout
          .trim()
          .split(/\r?\n/)
          .findLast((entry) => entry.trim().startsWith("{"));
        if (!line) throw new Error(`remote invite emitted no JSON: ${stdout}`);
        const invite = JSON.parse(line);
        if (typeof invite?.pairUrl !== "string" || !invite.pairUrl) {
          throw new Error(`remote invite returned no pairUrl: ${line}`);
        }
        resolve(invite);
      } catch (error) {
        reject(error);
      }
    });
  });
}
