import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { processGroupAlive, terminateOwnedProcessTree } from "../../scripts/owned-process-tree.mjs";
import { captureOwnedProcessIdentity, observeOwnedProcess } from "./ownedProcessIdentity.js";
import { vi } from "vitest";

describe.runIf(process.platform === "linux" || process.platform === "darwin")(
  "owned process identity",
  () => {
    it.each([false, true])(
      "retires an IPC-owned service and its worker after abrupt owner death (detached worker: %s)",
      async (detached) => {
        const lifetimeModule = fileURLToPath(
          new URL("../../scripts/owned-process-tree.mjs", import.meta.url)
        );
        const serviceCode = `
        const { bindProcessLifetimeToParent } = await import(${JSON.stringify(lifetimeModule)});
        bindProcessLifetimeToParent();
        const { spawn } = await import('node:child_process');
        const worker = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { detached: ${detached}, stdio: 'ignore' });
        process.send({ service: process.pid, worker: worker.pid });
        setInterval(()=>{},1000);
      `;
        const ownerCode = `
        const { spawn } = require('node:child_process');
        const service = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(serviceCode)}], { detached: true, stdio: ['ignore','ignore','inherit','ipc'] });
        service.on('message', message => process.send(message));
        setInterval(()=>{},1000);
      `;
        const owner = spawn(process.execPath, ["-e", ownerCode], {
          detached: true,
          stdio: ["ignore", "ignore", "inherit", "ipc"],
        });
        let servicePid: number | undefined;
        let workerPid: number | undefined;
        try {
          const ready = await new Promise<{ service: number; worker: number }>(
            (resolve, reject) => {
              owner.once("message", (message) =>
                resolve(message as { service: number; worker: number })
              );
              owner.once("error", reject);
              owner.once("exit", () => reject(new Error("fixture owner exited before readiness")));
            }
          );
          servicePid = ready.service;
          workerPid = ready.worker;
          expect(processGroupAlive(servicePid)).toBe(true);
          owner.kill("SIGKILL");
          await vi.waitFor(
            () => {
              expect(processGroupAlive(servicePid!)).toBe(false);
              if (detached) expect(processGroupAlive(workerPid!)).toBe(false);
            },
            { timeout: 5000 }
          );
        } finally {
          if (owner.pid) await terminateOwnedProcessTree(owner.pid, { termTimeoutMs: 0 });
          for (const pid of [servicePid, detached ? workerPid : undefined]) {
            if (pid && processGroupAlive(pid)) process.kill(-pid, "SIGKILL");
          }
        }
      }
    );

    it("fences process-tree termination to the captured birth identity", async () => {
      const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
        detached: true,
        stdio: "ignore",
      });
      if (child.pid === undefined) throw new Error("fixture child has no PID");
      const identity = captureOwnedProcessIdentity(child.pid);
      expect(observeOwnedProcess(identity)).toBe("owned");

      await expect(
        terminateOwnedProcessTree(child.pid, {
          identity: { ...identity, startCoordinate: `${identity.startCoordinate}-forged` },
        })
      ).rejects.toMatchObject({ code: "EOWNERSHIP" });
      expect(observeOwnedProcess(identity)).toBe("owned");

      await expect(terminateOwnedProcessTree(child.pid, { identity })).resolves.toMatchObject({
        gone: true,
      });
      expect(observeOwnedProcess(identity)).toBe("absent");
    });
  }
);
