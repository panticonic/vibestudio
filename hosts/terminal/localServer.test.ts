import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalServerStartError, localServerPaths, startLocalServer } from "./localServer.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A stand-in hub: logs, publishes its ready file, and runs until SIGTERM. */
const FAKE_SERVER = `
import fs from "node:fs";
const readyFile = process.argv[process.argv.indexOf("--ready-file") + 1];
console.log("fake hub starting");
console.error("fake hub diagnostics");
if (process.env.FAKE_HUB_FAIL) {
  console.error("fake hub cannot bind");
  process.exit(3);
}
process.on("SIGTERM", () => {
  console.log("fake hub stopping");
  process.exit(0);
});
if (process.env.FAKE_HUB_PREPARING) {
  const temporary = process.env.FAKE_HUB_PREPARING + ".preparing";
  fs.writeFileSync(temporary, JSON.stringify({ pid: process.pid }));
  fs.renameSync(temporary, process.env.FAKE_HUB_PREPARING);
} else {
  fs.writeFileSync(readyFile, JSON.stringify({ mode: "hub", pid: process.pid }));
}
setInterval(() => {}, 1000);
`;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-local-server-"));
  roots.push(root);
  const artifacts = path.join(root, "dist");
  fs.mkdirSync(artifacts);
  fs.writeFileSync(path.join(artifacts, "server.mjs"), FAKE_SERVER);
  return { root, artifacts, stateRoot: path.join(root, "state") };
}

describe("startLocalServer", () => {
  it.each([false, true])(
    "cancels and joins startup before retaining=%s can release ownership",
    async (retain) => {
      const { root, artifacts, stateRoot } = fixture();
      const preparing = path.join(root, "preparing.json");
      const controller = new AbortController();
      let watcher: fs.FSWatcher;
      const published = new Promise<void>((resolve, reject) => {
        watcher = fs.watch(root, () => {
          if (!fs.existsSync(preparing)) return;
          watcher.close();
          resolve();
        });
        watcher.on("error", reject);
      });
      const starting = startLocalServer({
        hostArtifactRoot: artifacts,
        appRoot: root,
        env: { ...process.env, FAKE_HUB_PREPARING: preparing },
        retain,
        stateRoot,
        signal: controller.signal,
      });
      void starting.catch(() => undefined);
      try {
        await published;
        const { pid } = JSON.parse(fs.readFileSync(preparing, "utf8")) as { pid: number };
        controller.abort(new Error("user cancelled startup"));
        await expect(starting).rejects.toThrow(/before it was ready/);
        expect(() => process.kill(pid, 0)).toThrow();
      } finally {
        watcher!.close();
        controller.abort(new Error("test finished"));
        await starting.catch(() => undefined);
      }
    }
  );
  it("keeps server output in the log, resolves on the ready file, and joins on stop", async () => {
    const { root, artifacts, stateRoot } = fixture();
    const server = await startLocalServer({
      hostArtifactRoot: artifacts,
      appRoot: root,
      env: process.env,
      retain: false,
      stateRoot,
    });
    expect(server.ready).toMatchObject({ mode: "hub", pid: server.pid });
    expect(server.logFile).toBe(localServerPaths(stateRoot).logFile);
    expect(server.retained).toBe(false);
    await server.stop();
    await expect(server.exited).resolves.toMatch(/exited/);
    const log = fs.readFileSync(server.logFile, "utf8");
    expect(log).toContain("fake hub starting");
    expect(log).toContain("fake hub diagnostics");
    expect(log).toContain("fake hub stopping");
    expect(() => process.kill(server.pid, 0)).toThrow();
  });

  it("reports a server that exits before readiness with its log path", async () => {
    const { root, artifacts, stateRoot } = fixture();
    const failure = startLocalServer({
      hostArtifactRoot: artifacts,
      appRoot: root,
      env: { ...process.env, FAKE_HUB_FAIL: "1" },
      retain: false,
      stateRoot,
    });
    await expect(failure).rejects.toBeInstanceOf(LocalServerStartError);
    await expect(failure).rejects.toThrow(localServerPaths(stateRoot).logFile);
    expect(fs.readFileSync(localServerPaths(stateRoot).logFile, "utf8")).toContain(
      "fake hub cannot bind"
    );
  });

  it("leaves a retained server running after its owner stops caring", async () => {
    const { root, artifacts, stateRoot } = fixture();
    const server = await startLocalServer({
      hostArtifactRoot: artifacts,
      appRoot: root,
      env: process.env,
      retain: true,
      stateRoot,
    });
    try {
      expect(server.retained).toBe(true);
      await server.stop();
      expect(() => process.kill(server.pid, 0)).not.toThrow();
    } finally {
      process.kill(server.pid, "SIGTERM");
      await server.exited;
    }
  });

  it("explains a missing server build", async () => {
    const { root, stateRoot } = fixture();
    await expect(
      startLocalServer({
        hostArtifactRoot: path.join(root, "nowhere"),
        appRoot: root,
        env: process.env,
        retain: false,
        stateRoot,
      })
    ).rejects.toThrow("pnpm start:terminal");
  });
});
