import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createOwnedProcessLifetime } from "../scripts/development-client-lifecycle.js";
import { processTreeAlive } from "../scripts/owned-process-tree.mjs";

it("joins a leased server and releases its database after its wrapper exits", async () => {
  const root = await mkdtemp(join(tmpdir(), "vs-server-parent-lease-"));
  const databasePath = join(root, "identity.db");
  const lifetime = createOwnedProcessLifetime();
  const leaseModule = new URL("../scripts/owned-process-tree.mjs", import.meta.url).href;
  const workspace = `
    const { DatabaseSync } = require("node:sqlite");
    const database = new DatabaseSync(${JSON.stringify(databasePath)});
    database.exec("CREATE TABLE identity (id TEXT)");
    console.log(process.pid);
    setInterval(() => {}, 1000);
  `;
  const hub = `
    import { spawn } from "node:child_process";
    import { bindProcessLifetimeToParent } from ${JSON.stringify(leaseModule)};
    bindProcessLifetimeToParent();
    spawn(process.execPath, ["-e", ${JSON.stringify(workspace)}], {
      stdio: ["ignore", "inherit", "inherit"],
    });
  `;
  const wrapper = `
    import { spawn } from "node:child_process";
    import { bindProcessLifetimeToParent } from ${JSON.stringify(leaseModule)};
    bindProcessLifetimeToParent();
    const hub = spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(hub)}], {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "inherit", "ipc"],
    });
    hub.stdout.once("data", (pid) => process.send({ hub: hub.pid, workspace: Number(String(pid).trim()) }));
  `;
  try {
    const child = lifetime.acquire(() =>
      spawn(process.execPath, ["--input-type=module", "-e", wrapper], {
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      })
    );
    const [receipt] = await once(child, "message", { signal: AbortSignal.timeout(10_000) });
    expect(processTreeAlive(receipt.hub)).toBe(true);
    expect(processTreeAlive(receipt.workspace)).toBe(true);
    await lifetime.retire();
    expect(processTreeAlive(receipt.hub)).toBe(false);
    expect(processTreeAlive(receipt.workspace)).toBe(false);
    // Windows refuses this while any descendant retains the native SQLite handle.
    await rm(databasePath);
  } finally {
    await lifetime.retire();
    await rm(root, { recursive: true, force: true });
  }
});
