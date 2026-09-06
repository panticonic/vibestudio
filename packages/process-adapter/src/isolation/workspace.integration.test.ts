import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, realpath, copyFile, cp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createServer, type Server } from "node:net";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { ProcessAdapter } from "../index.js";
import { WorkspaceSandbox } from "./workspace.js";
import type { ExecutionPolicy } from "./policy.js";
import { prepareNativeRuntime } from "../../../../src/server/nativeRuntimeResources.js";

const sandboxes: WorkspaceSandbox[] = [];
const directories: string[] = [];
const listeners: Server[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  const stops = await Promise.allSettled(sandboxes.splice(0).map((sandbox) => sandbox.stop()));
  await Promise.all(
    listeners
      .splice(0)
      .map((listener) => new Promise<void>((resolve) => listener.close(() => resolve())))
  );
  const unfinished = stops.find(
    (result) => result.status === "rejected" || !result.value.launcherExited
  );
  if (unfinished) {
    // Keep residual paths private and unique instead of deleting resources
    // while a launcher may still own them. Every other cleanup was attempted.
    directories.length = 0;
    throw new Error("A native fixture process did not retire", {
      cause: unfinished,
    });
  }
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

function message(command: ProcessAdapter): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Command message timed out")), 5_000);
    const receive = (value: unknown) => {
      clearTimeout(timer);
      command.off("message", receive);
      resolve(value);
    };
    command.on("message", receive);
    let stderr = "";
    command.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    command.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Command exited ${code}: ${stderr}`));
    });
  });
}

// These are real kernel checks, not mocked launch assertions. Build the package
// before running: the same installed JS entry used by production is exercised.
describe("shared workspace sandbox on the native platform", () => {
  it("opens a real PTY inside the workspace and carries input and resize", async () => {
    const platform = process.platform;
    if (platform !== "linux" && platform !== "darwin" && platform !== "win32")
      throw new Error(`No confinement backend for ${platform}`);
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "vibestudio-workspace-pty-")));
    directories.push(root);
    const privateRoot = path.join(root, "workspace");
    const runtime = path.join(privateRoot, "runtime");
    const home = path.join(privateRoot, "state");
    await mkdir(runtime, { recursive: true });
    await mkdir(path.join(home, "tmp"), { recursive: true });
    const hostCanary = path.join(root, "host-secret");
    await writeFile(hostCanary, "host-only");
    const prepared = prepareNativeRuntime({ runtimeRoot: runtime });
    const { executable } = prepared;
    const installedRuntime = await realpath(
      fileURLToPath(new URL("../../dist/isolation", import.meta.url))
    );
    for (const name of ["workspaceChild.js", "control.js"])
      await copyFile(path.join(installedRuntime, name), path.join(runtime, name));
    await writeFile(path.join(runtime, "package.json"), '{"type":"module"}');

    // Copy the installed package's actual native loader closure into this
    // workspace, rather than exposing the host node_modules tree or a PTY.
    const require = createRequire(import.meta.url);
    // Stock MXC's macOS policy permits host PTY slave access. Host-terminal
    // denial is intentionally outside the accepted MXC containment contract;
    // this fixture verifies workspace PTY functionality and file confinement.
    const installedPty = path.dirname(require.resolve("node-pty/package.json"));
    const ptyRoot = path.join(runtime, "node_modules", "node-pty");
    await mkdir(ptyRoot, { recursive: true });
    await copyFile(path.join(installedPty, "package.json"), path.join(ptyRoot, "package.json"));
    await cp(path.join(installedPty, "lib"), path.join(ptyRoot, "lib"), {
      recursive: true,
      dereference: true,
    });
    for (const relative of [
      "build/Release",
      "build/Debug",
      `prebuilds/${platform}-${process.arch}`,
    ]) {
      try {
        await cp(path.join(installedPty, relative), path.join(ptyRoot, relative), {
          recursive: true,
          dereference: true,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const terminalEntry = path.join(runtime, "terminal.cjs");
    await writeFile(
      terminalEntry,
      `
      const fs = require('node:fs');
      const emit = value => process.stdout.write('PTY_RESULT:' + JSON.stringify(value) + '\\n');
      const dimensions = () => ({ columns: process.stdout.columns, rows: process.stdout.rows });
      process.stdout.on('resize', () => emit({ resized: true, ...dimensions() }));
      const deadline = setTimeout(() => process.exit(124), 8000);
      emit({ ready: true, tty: process.stdin.isTTY && process.stdout.isTTY, ...dimensions() });
      require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
        if (line === 'quit') { clearTimeout(deadline); process.exit(0); }
        let hostDenied = false;
        let inputWriteDenied = false;
        try { fs.readFileSync(${JSON.stringify(hostCanary)}); } catch { hostDenied = true; }
        try { fs.writeFileSync(__filename, 'tampered'); } catch { inputWriteDenied = true; }
        emit({ input: line, ...dimensions() });
        emit({ hostDenied, inputWriteDenied });
      });
    `
    );
    const entry = path.join(runtime, "pty-owner.cjs");
    await writeFile(
      entry,
      `
      let terminal;
      let output = '';
      let outputBytes = 0;
      const deadline = setTimeout(() => { terminal?.kill(); process.exit(124); }, 10000);
      const stop = () => { terminal?.kill(); };
      process.on('SIGTERM', stop);
      process.on('disconnect', stop);
      try {
        terminal = require('node-pty').spawn(process.execPath, [${JSON.stringify(terminalEntry)}], {
          name: 'xterm-256color', cols: 100, rows: 30, cwd: process.env.HOME, env: process.env
        });
        terminal.onData(data => {
          outputBytes += Buffer.byteLength(data);
          if (outputBytes > 65536) { stop(); throw new Error('PTY output exceeded fixture limit'); }
          output += data;
          for (;;) {
            const start = output.indexOf('PTY_RESULT:');
            if (start < 0) break;
            const end = output.indexOf('\\n', start);
            if (end < 0) break;
            const record = output.slice(start + 'PTY_RESULT:'.length, end).trim();
            output = output.slice(end + 1);
            process.send(JSON.parse(record));
          }
        });
        terminal.onExit(event => { clearTimeout(deadline); process.exit(event.exitCode); });
        process.on('message', value => {
          if (value.resize) terminal.resize(value.resize.columns, value.resize.rows);
          if (value.input) terminal.write(value.input);
        });
      } catch (error) {
        console.error('Workspace node-pty startup failed:', error.stack);
        clearTimeout(deadline);
        process.exit(1);
      }
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
    const installation = {
      platform,
      launcher,
      workspaceEntry: path.join(runtime, "workspaceChild.js"),
    };
    const sandbox = await WorkspaceSandbox.start(
      {
        version: 1,
        owner: {
          workspaceId: "pty",
          contextId: null,
          runtimeId: "workspace-pty",
          incarnation: "fixture",
          executionDigest: "fixture-runtime",
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
      },
      installation
    );
    sandboxes.push(sandbox);
    const command = sandbox.fork(entry, {});
    // Collect from one subscription so adjacent PTY records cannot race a
    // succession of one-shot message listeners. Keep failures diagnostic.
    const records: unknown[] = [];
    let stderr = "";
    command.on("message", (value) => records.push(value));
    command.stderr?.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-16_384);
    });
    let exitCode: number | null | undefined;
    command.on("exit", (code) => {
      exitCode = code;
    });
    try {
      await vi.waitFor(
        () => {
          if (exitCode !== undefined) throw new Error(`PTY owner exited ${exitCode}: ${stderr}`);
          expect(records).toContainEqual({ ready: true, tty: true, columns: 100, rows: 30 });
        },
        { timeout: 5000 }
      );
      command.postMessage({ resize: { columns: 120, rows: 40 } });
      // The kernel resize and Node's SIGWINCH delivery are asynchronous. Wait
      // for the terminal to observe its dimensions before sending input.
      await vi.waitFor(
        () => {
          if (exitCode !== undefined) throw new Error(`PTY owner exited ${exitCode}: ${stderr}`);
          expect(records).toContainEqual({ resized: true, columns: 120, rows: 40 });
        },
        { timeout: 5000 }
      );
      command.postMessage({ input: "workspace-input\r" });
      await vi.waitFor(
        () => {
          if (exitCode !== undefined) throw new Error(`PTY owner exited ${exitCode}: ${stderr}`);
          expect(records).toContainEqual({ input: "workspace-input", columns: 120, rows: 40 });
          expect(records).toContainEqual({ hostDenied: true, inputWriteDenied: true });
        },
        { timeout: 5000 }
      );
      command.postMessage({ input: "quit\r" });
      await vi.waitFor(() => expect(exitCode, stderr).toBe(0), { timeout: 3000 });
    } finally {
      if (exitCode === undefined) {
        command.kill();
        await vi.waitFor(() => expect(exitCode, `PTY cleanup: ${stderr}`).not.toBeUndefined(), {
          timeout: 3000,
        });
      }
    }
  }, 20_000);

  it("shares commands within a workspace, denies host/sibling access and cancels independently", async () => {
    vi.stubEnv("ISOLATION_PARENT_SECRET", "synthetic-host-secret");
    const root = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "vibestudio-shared-workspace-"))
    );
    directories.push(root);
    const hostCanary = path.join(root, "host-secret");
    await writeFile(hostCanary, "host-only");
    let hostConnections = 0;
    const listener = createServer((socket) => {
      hostConnections++;
      socket.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", resolve);
    });
    listeners.push(listener);
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("Missing listener address");
    const installedRuntime = await realpath(
      fileURLToPath(new URL("../../dist/isolation", import.meta.url))
    );
    const platform = process.platform;
    if (platform !== "linux" && platform !== "darwin" && platform !== "win32") {
      throw new Error(`No confinement backend for ${platform}`);
    }
    const launcher = await realpath(
      fileURLToPath(
        new URL(
          `../../../../dist/mxc/${platform}-${process.arch}/${platform === "win32" ? "wxc-exec.exe" : platform === "darwin" ? "mxc-exec-mac" : "lxc-exec"}`,
          import.meta.url
        )
      )
    );
    const starts = await Promise.allSettled(
      ["A", "B"].map(async (id) => {
        const privateRoot = path.join(root, id);
        const input = path.join(privateRoot, "input");
        const home = path.join(privateRoot, "state");
        const runtime = path.join(privateRoot, "runtime");
        await mkdir(runtime, { recursive: true });
        const prepared = prepareNativeRuntime({ runtimeRoot: runtime });
        const { executable } = prepared;
        await writeFile(path.join(runtime, "package.json"), '{"type":"module"}');
        for (const name of ["workspaceChild.js", "control.js"]) {
          await copyFile(path.join(installedRuntime, name), path.join(runtime, name));
        }
        await mkdir(input, { recursive: true });
        await mkdir(path.join(home, "tmp"), { recursive: true });
        await writeFile(path.join(home, "shared"), id);
        const entry = path.join(input, "command.cjs");
        await writeFile(
          path.join(input, "detached.cjs"),
          `
        const cp = require('node:child_process');
        const child = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: ['ignore', 1, 2] });
        child.unref();
        process.stdout.write('final-output');
      `
        );
        await writeFile(
          entry,
          `
        const fs = require('node:fs');
        const cp = require('node:child_process');
        const denied = file => { try { fs.readFileSync(file); return false; } catch { return true; } };
        const socket = require('node:net').connect(${address.port}, '127.0.0.1');
        const connected = new Promise(resolve => {
          socket.once('connect', () => { socket.destroy(); resolve(true); });
          socket.once('error', () => resolve(false));
          socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
        });
        connected.then(networkConnected => process.send({
          networkConnected,
          anchorRenameDenied: (() => { try { fs.renameSync(process.env.HOME, process.env.HOME + '-replaced'); return false; } catch { return true; } })(),
          inputWriteDenied: (() => { try { fs.writeFileSync(__filename, 'tampered'); return false; } catch { return true; } })(),
          hardlinkWriteDenied: (() => {
            try {
              const alias = process.env.HOME + '/input-hardlink-' + process.pid;
              fs.linkSync(__filename, alias);
              fs.writeFileSync(alias, 'tampered');
              return false;
            } catch { return true; }
          })(),
          symlinkHostReadDenied: (() => {
            try {
              const alias = process.env.HOME + '/host-symlink-' + process.pid;
              fs.symlinkSync(${JSON.stringify(hostCanary)}, alias);
              fs.readFileSync(alias);
              return false;
            } catch { return true; }
          })(),
          own: fs.readFileSync(process.env.HOME + '/shared', 'utf8'),
          hostDenied: denied(${JSON.stringify(hostCanary)}),
          siblingDenied: denied(${JSON.stringify(path.join(root, id === "A" ? "B" : "A", "state", "shared"))}),
          parentPid: process.ppid,
          ambientSecret: process.env.ISOLATION_PARENT_SECRET ?? null,
          descendant: cp.spawnSync(process.execPath, ['-e', ${JSON.stringify(`try {require('node:fs').readFileSync(${JSON.stringify(hostCanary)}); process.exit(1)} catch {process.exit(0)}`)}]).status
        }));
        process.on('message', message => {
          if (message.write) fs.writeFileSync(process.env.HOME + '/shared', message.write);
          if (message.links) {
            fs.linkSync(process.env.HOME + '/shared', process.env.HOME + '/retained-hardlink');
            fs.symlinkSync(process.env.HOME + '/tmp', process.env.HOME + '/retained-directory-link', process.platform === 'win32' ? 'junction' : 'dir');
          }
          process.send({ value: fs.readFileSync(process.env.HOME + '/shared', 'utf8') });
        });
      `
        );
        const policy: ExecutionPolicy = {
          version: 1,
          owner: {
            workspaceId: id,
            contextId: null,
            runtimeId: `workspace-${id}`,
            incarnation: "fixture",
            executionDigest: "fixture-runtime",
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
          read: [...prepared.readPaths, input],
          write: [home],
          sockets: [],
        };
        const launch = {
          platform,
          launcher,
          workspaceEntry: path.join(runtime, "workspaceChild.js"),
        };
        const sandbox = await WorkspaceSandbox.start(policy, launch);
        sandboxes.push(sandbox);
        return { sandbox, entry, id, policy, launch };
      })
    );
    const fixtures = starts.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    const observations = [];
    for (const fixture of fixtures) {
      // The adversarial fixture deliberately daemonizes forever. Linux's PID
      // namespace gives this test an owned cleanup mechanism; on macOS a test
      // must not leave an immortal process after best-effort workspace stop.
      if (platform === "linux") {
        const detached = fixture.sandbox.fork(
          path.join(path.dirname(fixture.entry), "detached.cjs"),
          {}
        );
        let finalOutput = "";
        detached.stdout?.on("data", (chunk) => {
          finalOutput += chunk;
        });
        await new Promise<void>((resolve, reject) => {
          const deadline = setTimeout(
            () => reject(new Error("Detached descendant prevented direct command exit")),
            2_000
          );
          detached.on("exit", (code) => {
            clearTimeout(deadline);
            expect(code).toBe(0);
            resolve();
          });
        });
        await new Promise<void>((resolve, reject) => {
          const deadline = setTimeout(
            () => reject(new Error("Inherited output pipe was not retired")),
            2_000
          );
          detached.stdout?.on("end", () => {
            clearTimeout(deadline);
            resolve();
          });
        });
        expect(finalOutput).toBe("final-output");
      }
      const first = fixture.sandbox.fork(fixture.entry, {});
      const firstMessage = await message(first);
      const second = fixture.sandbox.fork(fixture.entry, {});
      const secondMessage = await message(second);
      expect(firstMessage).toMatchObject({
        own: fixture.id,
        hostDenied: true,
        siblingDenied: true,
        ambientSecret: null,
        anchorRenameDenied: true,
        inputWriteDenied: true,
        hardlinkWriteDenied: true,
        symlinkHostReadDenied: true,
        descendant: 0,
      });
      expect(firstMessage).toMatchObject({ networkConnected: true });
      expect(secondMessage).toEqual(firstMessage);
      const changed = message(first);
      first.postMessage({ write: "shared-by-commands" });
      expect(await changed).toEqual({ value: "shared-by-commands" });
      const read = message(second);
      second.postMessage({ read: true });
      expect(await read).toEqual({ value: "shared-by-commands" });
      const exited = new Promise((resolve) => first.on("exit", resolve));
      expect(first.kill()).toBe(true);
      await exited;
      const survivor = message(second);
      second.postMessage({ read: true });
      expect(await survivor).toEqual({ value: "shared-by-commands" });
      observations.push({ second, sandbox: fixture.sandbox });
    }
    const linked = message(observations[0]!.second);
    observations[0]!.second.postMessage({ links: true });
    expect(await linked).toEqual({ value: "shared-by-commands" });
    expect(await observations[0]!.sandbox.stop()).toEqual({
      launcherExited: true,
      descendantCleanup: "unverified",
    });
    expect(() => fixtures[0]!.sandbox.fork(fixtures[0]!.entry, {})).toThrow("not running");
    const remaining = message(observations[1]!.second);
    observations[1]!.second.postMessage({ read: true });
    expect(await remaining).toEqual({ value: "shared-by-commands" });
    const prior = fixtures[0]!;
    const restarted = await WorkspaceSandbox.start(
      {
        ...prior.policy,
        owner: { ...prior.policy.owner, incarnation: "restart" },
      },
      prior.launch
    );
    sandboxes.push(restarted);
    expect(await message(restarted.fork(prior.entry, {}))).toMatchObject({
      own: "shared-by-commands",
      hostDenied: true,
      siblingDenied: true,
      anchorRenameDenied: true,
    });
    expect(hostConnections).toBeGreaterThan(0);
  }, 20_000);
});
