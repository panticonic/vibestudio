import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { OwnedProcessGroup } from "@vibestudio/shared/ownedProcessGroup";
import {
  captureOwnedProcessIdentity,
  observeOwnedProcessGroup,
  type OwnedProcessIdentity,
} from "@vibestudio/shared/ownedProcessIdentity";

it.skipIf(process.platform !== "linux")(
  "keeps the explicit stop lease until native work and storage retire",
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), "vs-parent-stop-test-"));
    const root = join(scratch, "state");
    const entry = join(scratch, "entry.mjs");
    const receipt = join(scratch, "retired.json");
    await mkdir(root);
    const require = createRequire(import.meta.url);
    const url = (file: string) => JSON.stringify(pathToFileURL(resolve(file)).href);
    await writeFile(
      entry,
      `
    import { spawn } from "node:child_process";
    import { once } from "node:events";
    import { writeFile } from "node:fs/promises";
    import { runParentOwnedMain } from ${url("scripts/lib/parent-owned-main.mjs")};
    import { tsImport } from ${url(require.resolve("tsx/esm/api"))};
    const { createDevelopmentClientLifetime } = await tsImport(${JSON.stringify(resolve("scripts/development-client-lifecycle.ts"))}, import.meta.url);
    await runParentOwnedMain(async signal => {
      const lifetime = createDevelopmentClientLifetime(${JSON.stringify(root)});
      const work = lifetime.acquire(() => spawn(process.execPath, ["-e", "console.log('ready'); setInterval(() => {}, 1000)"], { detached: true, stdio: ["ignore", "pipe", "inherit"] }));
      try {
        await once(work.stdout, "data");
        console.log(JSON.stringify({ ready: true, ownerPid: process.pid, workPid: work.pid }));
        await new Promise(done => { if (signal.aborted) done(); else signal.addEventListener("abort", done, { once: true }); });
      } finally {
        if (!process.connected) throw new Error("Explicit cancellation revoked the cleanup lease");
        await lifetime.close();
        await writeFile(${JSON.stringify(receipt)}, JSON.stringify({ retired: true, leaseConnected: process.connected }));
      }
    });
  `
    );
    const launcher = spawn(process.execPath, [entry], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const launcherOwner = OwnedProcessGroup.create(launcher);
    const identities: OwnedProcessIdentity[] = [];
    let errors = "";
    launcher.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    try {
      const ready = await new Promise<{ ownerPid: number; workPid: number }>(
        (resolveReady, reject) => {
          let output = "";
          launcher.stdout.on("data", (chunk) => {
            output += chunk;
            for (const line of output.split("\n")) {
              if (line.startsWith('{"ready":true,')) resolveReady(JSON.parse(line));
            }
          });
          launcher.once("error", reject);
          launcher.once("exit", (code) => reject(new Error(`Launcher exited ${code}: ${errors}`)));
        }
      );
      identities.push(
        ...[ready.ownerPid, ready.workPid].map((pid) => captureOwnedProcessIdentity(pid))
      );
      const exited = once(launcher, "exit");
      launcher.kill("SIGTERM");
      expect(await exited).toEqual([0, null]);
      expect(errors).not.toContain("unsettled top-level await");
      const { readFile } = await import("node:fs/promises");
      expect(JSON.parse(await readFile(receipt, "utf8"))).toEqual({
        retired: true,
        leaseConnected: true,
      });
      expect(identities.map((identity) => observeOwnedProcessGroup(identity))).toEqual([
        "absent",
        "absent",
      ]);
      await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await launcherOwner.retire("SIGKILL");
      await Promise.all(
        identities.map((identity) => OwnedProcessGroup.adopt(identity).retire("SIGKILL"))
      );
      await rm(scratch, { recursive: true, force: true });
    }
  },
  20_000
);

it.skipIf(process.platform !== "linux")(
  "retires real secret-service groups and storage after SIGKILL of their launcher",
  async () => {
    // The actual DBus AF_UNIX address includes this path and is limited to 108 bytes.
    const scratch = await mkdtemp(join(tmpdir(), "pl-"));
    const root = join(scratch, "state");
    const entry = join(scratch, "entry.mjs");
    await mkdir(root);
    const url = (file: string) => JSON.stringify(pathToFileURL(resolve(file)).href);
    const require = createRequire(import.meta.url);
    await writeFile(
      entry,
      `
    import { runParentOwnedMain } from ${url("scripts/lib/parent-owned-main.mjs")};
    import { startEphemeralLinuxSecretService } from ${url("scripts/lib/linux-secret-service.mjs")};
    import { tsImport } from ${url(require.resolve("tsx/esm/api"))};
    const { createDevelopmentClientLifetime } = await tsImport(${JSON.stringify(resolve("scripts/development-client-lifecycle.ts"))}, import.meta.url);
    await runParentOwnedMain(async signal => {
      const lifetime = createDevelopmentClientLifetime(${JSON.stringify(root)});
      const helpers = [];
      let secretService;
      const stop = () => lifetime.requestStop();
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
      try {
        secretService = await startEphemeralLinuxSecretService(${JSON.stringify(root)}, start => {
          const child = lifetime.acquire(start); helpers.push(child); return child;
        }, lifetime.retireChild, { signal });
        const pids = helpers.filter(child => child.exitCode === null).map(child => child.pid);
        console.log(JSON.stringify({ ready: true, ownerPid: process.pid, pids, runtimeDir: secretService.env.XDG_RUNTIME_DIR }));
        await new Promise(done => { if (signal.aborted) done(); else signal.addEventListener("abort", done, { once: true }); });
      } finally {
        signal.removeEventListener("abort", stop);
        await secretService?.dispose();
        await lifetime.close();
      }
    });
  `
    );
    const launcher = spawn(process.execPath, [entry], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const launcherOwner = OwnedProcessGroup.create(launcher);
    const identities: OwnedProcessIdentity[] = [];
    try {
      const ready = await new Promise<{ ownerPid: number; pids: number[]; runtimeDir: string }>(
        (resolveReady, reject) => {
          let output = "";
          let errors = "";
          launcher.stderr.on("data", (chunk) => {
            errors += chunk;
          });
          launcher.stdout.on("data", (chunk) => {
            output += chunk;
            for (const line of output.split("\n")) {
              if (line.startsWith('{"ready":true,')) resolveReady(JSON.parse(line));
            }
          });
          launcher.once("error", reject);
          launcher.once("exit", (code) => reject(new Error(`Launcher exited ${code}: ${errors}`)));
        }
      );
      expect(ready.pids).toHaveLength(2);
      identities.push(
        ...[ready.ownerPid, ...ready.pids].map((pid) => captureOwnedProcessIdentity(pid))
      );
      const exited = once(launcher, "exit");
      launcher.kill("SIGKILL");
      await exited;
      await expect
        .poll(() => identities.map((identity) => observeOwnedProcessGroup(identity)), {
          timeout: 12_000,
        })
        .toEqual(["absent", "absent", "absent"]);
      await expect(access(dirname(ready.runtimeDir))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await launcherOwner.retire("SIGKILL");
      await Promise.all(
        identities.map((identity) => OwnedProcessGroup.adopt(identity).retire("SIGKILL"))
      );
      await rm(scratch, { recursive: true, force: true });
    }
  },
  20_000
);
