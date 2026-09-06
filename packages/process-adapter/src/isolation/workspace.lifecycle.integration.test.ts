import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, type ChildProcess } from "node:child_process";
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ProcessAdapter } from "../index.js";
import { WorkspaceSandbox } from "./workspace.js";
import type { ExecutionPolicy } from "./policy.js";
import { prepareNativeRuntime } from "../../../../src/server/nativeRuntimeResources.js";

const owned: WorkspaceSandbox[] = [];
const directories: string[] = [];
let guestWatchdogDeadline = 0;
afterEach(async () => {
  const stops = await Promise.allSettled(owned.splice(0).map((sandbox) => sandbox.stop()));
  // Interrupted MXC retirement is best effort on macOS. Every supervisor in
  // this fault-injection fixture has an independent eight-second watchdog.
  // Wait it out before deleting resources, even when the launcher exited.
  if (guestWatchdogDeadline > Date.now())
    await new Promise((resolve) => setTimeout(resolve, guestWatchdogDeadline - Date.now()));
  guestWatchdogDeadline = 0;
  const failed = stops.find(
    (result) => result.status === "rejected" || !result.value.launcherExited
  );
  if (failed) {
    directories.length = 0;
    throw new Error("Lifecycle fixture launcher did not retire; resources quarantined", {
      cause: failed,
    });
  }
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

function nextMessage(command: ProcessAdapter): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    command.stderr?.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-4096);
    });
    const timer = setTimeout(
      () => reject(new Error(`Lifecycle command timed out: ${stderr}`)),
      3000
    );
    command.on("message", (value: unknown) => {
      clearTimeout(timer);
      resolve(value);
    });
    command.on("exit", () => {
      clearTimeout(timer);
      reject(new Error(`Lifecycle command exited: ${stderr}`));
    });
  });
}

function windowsAcl(paths: string[]): unknown {
  const literals = paths.map((file) => `'${file.replaceAll("'", "''")}'`).join(",");
  const script = `$ErrorActionPreference='Stop'; @(${literals}) | ForEach-Object { (Get-Acl -LiteralPath $_).Sddl } | ConvertTo-Json -Compress`;
  return JSON.parse(
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { encoding: "utf8", timeout: 10000 }
    )
  );
}

async function fixture() {
  const platform = process.platform;
  if (platform !== "linux" && platform !== "darwin" && platform !== "win32")
    throw new Error(`Unsupported test platform: ${platform}`);
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "vibestudio-mxc-lifecycle-")));
  directories.push(root);
  const runtime = path.join(root, "runtime");
  await mkdir(runtime);
  const prepared = prepareNativeRuntime({ runtimeRoot: runtime });
  const { executable } = prepared;
  const installed = fileURLToPath(new URL("../../dist/isolation/", import.meta.url));
  for (const file of ["workspaceChild.js", "control.js"])
    await copyFile(path.join(installed, file), path.join(runtime, file));
  await writeFile(path.join(runtime, "package.json"), '{"type":"module"}');
  const workspaceEntry = path.join(runtime, "bounded-supervisor.js");
  await writeFile(
    workspaceEntry,
    "import './workspaceChild.js'; setTimeout(() => process.exit(0), 8000).unref();"
  );
  const marker = path.join(runtime, "shared-runtime");
  await writeFile(marker, "installed-runtime");
  const entry = path.join(runtime, "command.cjs");
  await writeFile(
    entry,
    `
    const fs = require('node:fs');
    const read = () => ({ runtime: fs.readFileSync(${JSON.stringify(marker)}, 'utf8'), own: fs.readFileSync(process.env.HOME + '/state', 'utf8') });
    const timeout = setTimeout(() => process.exit(0), 4000);
    process.on('disconnect', () => { clearTimeout(timeout); process.exit(0); });
    process.on('message', value => {
      if (value.crashSupervisor) { process.kill(process.ppid, 'SIGKILL'); return; }
      if (value.write) fs.writeFileSync(process.env.HOME + '/state', value.write);
      process.send(read());
    });
    process.send(read());
  `
  );
  const launcher = await realpath(
    fileURLToPath(
      new URL(
        `../../../../dist/mxc/${platform}-${process.arch}/${platform === "win32" ? "wxc-exec.exe" : platform === "darwin" ? "mxc-exec-mac" : "lxc-exec"}`,
        import.meta.url
      )
    )
  );
  const installation = { platform, launcher, workspaceEntry };
  const start = async (id: string, incarnation: string) => {
    const privateRoot = path.join(root, id);
    const home = path.join(privateRoot, "state");
    await mkdir(path.join(home, "tmp"), { recursive: true });
    try {
      await writeFile(path.join(home, "state"), id, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const policy: ExecutionPolicy = {
      version: 1,
      owner: {
        workspaceId: id,
        contextId: null,
        runtimeId: id,
        incarnation,
        executionDigest: "fixture",
      },
      privateRoot,
      executable,
      args: [],
      cwd: home,
      home,
      environment: {
        PATH: runtime,
        ...prepared.environment,
      },
      read: prepared.readPaths,
      write: [home],
      sockets: [],
    };
    const sandbox = await WorkspaceSandbox.start(policy, installation);
    owned.push(sandbox);
    guestWatchdogDeadline = Math.max(guestWatchdogDeadline, Date.now() + 8500);
    return sandbox;
  };
  return { start, entry, platform, aclPaths: [runtime, marker] };
}

describe("MXC interrupted workspace lifecycle", () => {
  it.each(["supervisor crash", "launcher termination"] as const)(
    "recovers from %s while another workspace retains the shared runtime",
    async (failure) => {
      const f = await fixture();
      const aclBefore = f.platform === "win32" ? windowsAcl(f.aclPaths) : null;
      const first = await f.start("A", "first");
      const other = await f.start("B", "first");
      const firstCommand = first.fork(f.entry, {});
      expect(await nextMessage(firstCommand)).toEqual({ runtime: "installed-runtime", own: "A" });
      const changed = nextMessage(firstCommand);
      firstCommand.postMessage({ write: "retained-state" });
      await changed;
      if (failure === "supervisor crash") firstCommand.postMessage({ crashSupervisor: true });
      else {
        // Fault injection targets only this fixture's owned trusted launcher.
        // This is deliberately not a production escape hatch or host PID API.
        const launcher = (first as unknown as { child: ChildProcess }).child;
        expect(launcher.kill("SIGKILL")).toBe(true);
      }
      let retirementDeadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          first.retired,
          new Promise((_, reject) => {
            retirementDeadline = setTimeout(
              () => reject(new Error("Failed workspace authority was not retired")),
              5000
            );
          }),
        ]);
      } finally {
        clearTimeout(retirementDeadline);
      }
      const stopped = first.stop();
      expect(first.stop()).toBe(stopped);
      expect(await stopped).toEqual({ launcherExited: true, descendantCleanup: "unverified" });
      expect(() => first.fork(f.entry, {})).toThrow("not running");
      const restarted = await f.start("A", "restarted");
      expect(await nextMessage(restarted.fork(f.entry, {}))).toEqual({
        runtime: "installed-runtime",
        own: "retained-state",
      });
      expect(await nextMessage(other.fork(f.entry, {}))).toEqual({
        runtime: "installed-runtime",
        own: "B",
      });
      await restarted.stop();
      // Closing one owner must not remove another owner's shared runtime grant.
      expect(await nextMessage(other.fork(f.entry, {}))).toEqual({
        runtime: "installed-runtime",
        own: "B",
      });
      await other.stop();
      if (f.platform === "win32") expect(windowsAcl(f.aclPaths)).toEqual(aclBefore);
    },
    30000
  );
});
