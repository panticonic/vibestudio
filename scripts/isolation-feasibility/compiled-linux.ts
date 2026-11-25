import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { ownedEntry, retireOnAbort } from "../lib/owned-entry.mjs";
import {
  compileExecution,
  type ExecutionPolicy,
} from "../../packages/process-adapter/src/isolation/index.js";

if (process.platform !== "linux")
  throw new Error("This conformance experiment requires native Linux");
await ownedEntry(
  async ({ ownership, signal, scratchRoot }) => {
    const root = scratchRoot!;
    const children = new Set<ChildProcess>();
    try {
      const hostCanary = path.join(root, "host-only");
      await fs.writeFile(hostCanary, "host-secret", { mode: 0o600 });
      const results = await Promise.all(
        ["A", "B"].map(async (id) => {
          const privateRoot = path.join(root, id);
          const input = path.join(privateRoot, "input");
          const home = path.join(privateRoot, "state", "home");
          await fs.mkdir(input, { recursive: true, mode: 0o700 });
          await fs.mkdir(path.join(home, "tmp"), { recursive: true, mode: 0o700 });
          await fs.writeFile(path.join(input, "value"), id);
          const script = `const fs=require('fs');const cp=require('child_process');
      const assert=require('assert/strict');
      assert.equal(fs.readFileSync(${JSON.stringify(path.join(input, "value"))},'utf8'),${JSON.stringify(id)});
      assert.throws(()=>fs.writeFileSync(${JSON.stringify(path.join(input, "value"))},'bad'),{code:'EROFS'});
      assert.throws(()=>fs.readFileSync(${JSON.stringify(hostCanary)}),{code:'ENOENT'});
      assert.throws(()=>fs.readFileSync(${JSON.stringify(path.join(root, id === "A" ? "B" : "A", "input", "value"))}),{code:'ENOENT'});
      assert.equal(process.env.ISOLATION_PARENT_SECRET,undefined);
      fs.writeFileSync(process.env.HOME+'/result','private');
      const child=cp.spawnSync(process.execPath,['-e',${JSON.stringify(`require('assert/strict').throws(()=>require('fs').readFileSync(${JSON.stringify(hostCanary)}),{code:'ENOENT'})`)}]);
      assert.equal(child.status,0); console.log('passed');`;
          const policy: ExecutionPolicy = {
            version: 1,
            owner: {
              workspaceId: `workspace-${id}`,
              contextId: "context",
              runtimeId: `job-${id}`,
              incarnation: "1",
              executionDigest: "fixture",
            },
            privateRoot,
            executable: "/usr/bin/node",
            args: ["-e", script],
            cwd: input,
            home,
            environment: { PATH: "/usr/bin:/bin" },
            read: ["/usr", input],
            write: [path.join(privateRoot, "state")],
            sockets: [],
          };
          const launch = compileExecution(policy, {
            platform: "linux",
            launcher: "/usr/bin/bwrap",
          });
          signal.throwIfAborted();
        const owned = ownership.spawn(launch.command, launch.args, {
            kill: "immediate",
            cwd: launch.cwd,
            env: launch.environment,
            stdio: ["ignore", "pipe", "pipe"],
          });
          const child = owned.child;
          retireOnAbort(ownership, signal, owned);
          children.add(child);
          let output = "";
          let error = "";
          child.stdout?.on("data", (chunk) => (output += chunk));
          child.stderr?.on("data", (chunk) => (error += chunk));
          const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
          const code = await new Promise<number | null>((resolve, reject) => {
            child.once("error", reject);
            child.once("close", (code) => {
              children.delete(child);
              resolve(code);
            });
          }).finally(() => clearTimeout(timer));
          assert.equal(code, 0, error);
          assert.equal(output.trim(), "passed");
          return { id, passed: true };
        })
      );
      console.log(JSON.stringify({ compiledLinuxConformance: results }));
    } finally {
      await Promise.all(
        [...children].map(
          (child) =>
            new Promise<void>((resolve) => {
              child.once("close", () => resolve());
              child.kill("SIGKILL");
            })
        )
      );
    }
  },
  { scratchPrefix: "vibestudio-compiled-isolation-" }
);
