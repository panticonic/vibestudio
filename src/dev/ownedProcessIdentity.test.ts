import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { terminateOwnedProcessTree } from "../../scripts/owned-process-tree.mjs";
import { captureOwnedProcessIdentity, observeOwnedProcess } from "./ownedProcessIdentity.js";

describe.runIf(process.platform === "linux" || process.platform === "darwin")(
  "owned process identity",
  () => {
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
