import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

function runCommandBuffer(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    let stderr = "";
    child.stdout?.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout));
      else reject(new Error(`${command} ${args.join(" ")} failed with code ${code}\n${stderr}`));
    });
  });
}

export async function resolveDevelopmentBase({
  repoRoot,
  checkpointTarget,
  productionBase = false,
  explicitCheckout = null,
}) {
  const stdout = await runCommandBuffer(
    process.execPath,
    [
      "--import",
      "tsx",
      path.join(repoRoot, "scripts", "resolve-development-base.ts"),
      "--checkpoint-target",
      checkpointTarget,
      ...(explicitCheckout ? ["--checkout", explicitCheckout] : []),
      ...(productionBase ? ["--production-base"] : []),
    ],
    { cwd: repoRoot }
  );
  return JSON.parse(stdout.toString().trim());
}

export async function assertBaseCheckoutBootable({ repoRoot, checkout }) {
  let failure = null;
  try {
    await runCommandBuffer(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(repoRoot, "scripts", "validate-template-repository.ts"),
        checkout,
        "--boot-only",
      ],
      { cwd: repoRoot }
    );
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  if (failure === null) return;
  const detail = failure
    .split("\n")
    .filter((line) => line.trim() && !/^\s+at /.test(line))
    .join("\n");
  throw new Error(
    `Base checkout at ${checkout} cannot boot a workspace:\n${detail}\n\n` +
      `Fix the checkout (for a stale generated manifest: ` +
      `npx tsx scripts/validate-template-repository.ts ${checkout} --fix), ` +
      `or point this run elsewhere with --base-checkout <dir>.`
  );
}

export function createRemoteServeArgs(repoRoot, readyFile, port) {
  return [
    path.join(repoRoot, "scripts", "cli", "remote-serve.mjs"),
    "--bootstrap-workspace",
    "mobile-smoke",
    "--app-root",
    repoRoot,
    "--port",
    String(port),
    "--ready-file",
    readyFile,
  ];
}

export function waitForRootInvite({ readyFile, timeoutMs = 180_000 }) {
  return new Promise((resolve, reject) => {
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
        const invite = payload?.rootInvite;
        if (typeof invite?.pairUrl === "string" && invite.pairUrl) {
          finish(() => resolve(invite));
          return;
        }
        if (payload?.rootInvite === null) {
          finish(() =>
            reject(new Error("root account already exists; no first-device invite is available"))
          );
          return;
        }
        if (invite != null) finish(() => reject(new Error("root invite has no pairing URL")));
      } catch (error) {
        if (error?.code !== "ENOENT") finish(() => reject(error));
      }
    };
    const poll = setInterval(() => void read(), 100);
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`root invite timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    void read();
  });
}
