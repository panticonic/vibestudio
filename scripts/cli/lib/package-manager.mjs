import crossSpawn from "cross-spawn";
import fs from "fs";
import os from "os";
import path from "path";
import process from "process";

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pnpmCommandName() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function pathCandidates(commandName) {
  const candidates = [];
  const seen = new Set();
  const add = (candidate) => {
    if (!candidate || seen.has(candidate)) return;
    seen.add(candidate);
    candidates.push(candidate);
  };

  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir) add(path.join(dir, commandName));
  }

  const home = os.homedir();
  add(process.env.PNPM_HOME ? path.join(process.env.PNPM_HOME, commandName) : null);
  add(home ? path.join(home, ".local", "share", "pnpm", commandName) : null);
  add(process.platform === "win32" ? null : "/usr/bin/pnpm");
  add(process.platform === "win32" ? null : "/usr/local/bin/pnpm");
  add(process.platform === "win32" ? null : "/home/linuxbrew/.linuxbrew/bin/pnpm");

  return candidates;
}

export function createPnpmInvocation(args = []) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && /(^|[\\/])pnpm(\.cjs|\.js|\.mjs)?$/i.test(npmExecPath)) {
    return {
      command: process.execPath,
      args: [npmExecPath, ...args],
    };
  }

  const commandName = pnpmCommandName();
  for (const candidate of pathCandidates(commandName)) {
    if (isExecutable(candidate)) {
      return {
        command: candidate,
        args,
      };
    }
  }

  return {
    command: commandName,
    args,
  };
}

/** Execute command-script shims through the maintained Windows launcher. */
export function spawnPnpmSync(args, options = {}, run = crossSpawn.sync) {
  const invocation = createPnpmInvocation(args);
  return run(invocation.command, invocation.args, options);
}
export function execPnpmSync(args, options = {}) {
  const result = spawnPnpmSync(args, options);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(`pnpm failed (${result.signal ?? result.status})`);
    Object.assign(error, {
      status: result.status,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
    });
    throw error;
  }
  return result.stdout;
}
