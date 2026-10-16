import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalFeed, type DeviceOperations } from "@vibestudio/shared/deviceDriver";
import type { ClientLaunchResult, ClientListing } from "@vibestudio/workspace-contracts/clients";
import { ChangeSignal } from "../../../hosts/terminal/clientLaunchGate.js";
import {
  binDirectoryOf,
  createTerminalDevice,
  type TerminalDevicePorts,
} from "./terminalDevice.js";

let root: string;
let home: string;
let bin: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-device-"));
  home = path.join(root, "home");
  bin = binDirectoryOf(home);
  fs.mkdirSync(bin, { recursive: true });
  // A stand-in `vibestudio`: `open <id>` greets, then waits for `q`.
  fs.writeFileSync(
    path.join(bin, "vibestudio"),
    `#!/bin/sh\nif [ "$1" = "open" ]; then printf 'Hello %s\\n' "$2"; read key; printf 'bye\\n'; exit 0; fi\necho "args: $*"\n`,
    { mode: 0o755 }
  );
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const listing = (id: string, buildKey: string): ClientListing =>
  ({
    source: `clients/${id}`,
    id,
    runtime: "terminal",
    title: id,
    hostAbi: "1",
    status: "available",
    isDefault: false,
    trusted: false,
    intents: [{ name: "ask", kind: "background", handler: "svc#ask", params: { text: "text" } }],
    activeBuildKey: buildKey,
    canRollback: false,
  }) as ClientListing;

function fixture(overrides: Partial<TerminalDevicePorts["clients"]> = {}) {
  const state = {
    listings: [listing("chat", "b1")] as ClientListing[],
    shims: {} as Record<string, { clientId: string; command: string }>,
  };
  const changes = new ChangeSignal();
  const feed = new ApprovalFeed(async () => []);
  const ports: TerminalDevicePorts = {
    clients: {
      list: async () => state.listings,
      launch: async (id): Promise<ClientLaunchResult> => {
        const found = state.listings.find((l) => l.id === id);
        if (!found) return { state: "unavailable", reason: "no such client" };
        return {
          state: "ready",
          client: {
            source: found.source,
            id,
            runtime: "terminal",
            title: id,
            buildKey: found.activeBuildKey!,
            executionDigest: "0".repeat(64),
            effectiveVersion: "1",
            hostAbi: "1",
            artifacts: [],
            grantedCapabilities: ["device-session"],
            deniedOptional: [],
          } as never,
        };
      },
      invokeIntent: async () => ({ text: "hi" }),
      ...overrides,
    },
    bootId: async () => "boot-1",
    changes,
    approvals: { feed, resolve: async () => undefined },
    hostState: {
      read: () => ({
        schemaVersion: 1,
        shims: state.shims,
        develop: {},
        commands: {},
        clients: {},
      }),
    },
  };
  const device = createTerminalDevice(ports, {
    home,
    env: { HOME: home, PATH: `${bin}:${process.env["PATH"] ?? ""}` },
  });
  const signal = new AbortController().signal;
  const op = <K extends keyof Required<DeviceOperations>>(
    name: K,
    args: Parameters<Required<DeviceOperations>[K]>[0]
  ): ReturnType<Required<DeviceOperations>[K]> =>
    (device.ops[name] as (a: unknown, s: AbortSignal) => never)(args, signal);
  return { device, state, changes, op };
}

describe("terminal device", () => {
  it("launches the CLI in a PTY, reads its screen, types to it and reports how it closed", async () => {
    const f = fixture();
    try {
      const launched = await f.op("launch", { id: "chat" });
      if (launched.state !== "ready") throw new Error("not ready");
      expect(launched.instance).toMatchObject({ clientId: "chat", buildKey: "b1" });
      expect(
        await f.op("waitForText", { surfaceId: launched.surfaceId, text: "Hello chat" })
      ).toContain("Hello chat");
      const info = await f.op("surfaceInfo", { surfaceId: launched.surfaceId });
      expect(info).toMatchObject({
        grantedCapabilities: ["device-session"],
        pendingBuildKey: null,
        closed: null,
      });
      expect((await f.op("identities", {})).instances).toHaveLength(1);
      await f.op("sendKeys", { surfaceId: launched.surfaceId, keys: "q\r" });
      const closed = await f.op("waitForClosed", { surfaceId: launched.surfaceId });
      expect(closed.reason).toContain("exit code 0");
      expect(closed.reason).toContain("bye");
      expect((await f.op("identities", {})).instances).toHaveLength(0);
    } finally {
      await f.device.close();
    }
  });

  it("rejects a text wait when the program ends without showing it", async () => {
    const f = fixture();
    try {
      const launched = await f.op("launch", { id: "chat" });
      if (launched.state !== "ready") throw new Error("not ready");
      const waiting = f.op("waitForText", { surfaceId: launched.surfaceId, text: "never shown" });
      await f.op("sendKeys", { surfaceId: launched.surfaceId, keys: "q\r" });
      await expect(waiting).rejects.toMatchObject({ code: "ETERMINALENDED" });
    } finally {
      await f.device.close();
    }
  });

  it("answers an unavailable client without starting a PTY", async () => {
    const f = fixture({
      launch: async () => ({
        state: "unavailable",
        reason: "needs camera",
        missing: { capabilities: ["camera"] },
      }),
    });
    try {
      expect(await f.op("launch", { id: "chat" })).toEqual({
        state: "unavailable",
        reason: "needs camera",
        missing: { capabilities: ["camera"] },
      });
      expect((await f.op("identities", {})).instances).toHaveLength(0);
    } finally {
      await f.device.close();
    }
  });

  it("waits for a launch that is still preparing on the next clients:changed", async () => {
    let preparing = true;
    const f = fixture({
      launch: async (id) =>
        preparing
          ? { state: "preparing", phase: "build", reason: "building" }
          : ({ state: "unavailable", reason: `done ${id}` } as ClientLaunchResult),
    });
    try {
      const launching = f.op("launch", { id: "chat" });
      await Promise.resolve();
      preparing = false;
      f.changes.bump();
      expect(await launching).toMatchObject({ state: "unavailable", reason: "done chat" });
    } finally {
      await f.device.close();
    }
  });

  it("settles waitForListing on clients:changed, and waitForBuildChange on the new active build", async () => {
    const f = fixture();
    try {
      const present = f.op("waitForListing", { id: "extra", present: true });
      f.state.listings.push(listing("extra", "x1"));
      f.changes.bump();
      expect(await present).toMatchObject({ id: "extra" });

      const launched = await f.op("launch", { id: "chat" });
      if (launched.state !== "ready") throw new Error("not ready");
      const changed = f.op("waitForBuildChange", {
        surfaceId: launched.surfaceId,
        fromBuildKey: "b1",
      });
      f.state.listings[0] = listing("chat", "b2");
      f.changes.bump();
      expect(await changed).toMatchObject({ buildKey: "b2" });
      expect(await f.op("surfaceInfo", { surfaceId: launched.surfaceId })).toMatchObject({
        pendingBuildKey: null,
      });

      const gone = f.op("waitForListing", { id: "extra", present: false });
      f.state.listings.splice(1, 1);
      f.changes.bump();
      expect(await gone).toBeNull();
    } finally {
      await f.device.close();
    }
  });

  it("reports a background intent's keys and its failure code", async () => {
    const f = fixture();
    expect(await f.op("invokeIntent", { id: "chat", intent: "ask" })).toEqual({
      ok: true,
      text: "hi",
      fields: ["text"],
    });
    const failing = fixture({
      invokeIntent: async () => {
        throw Object.assign(new Error("bad param"), { code: "EINVAL" });
      },
    });
    expect(await failing.op("invokeIntent", { id: "chat", intent: "ask" })).toEqual({
      ok: false,
      code: "EINVAL",
      message: "bad param",
    });
  });

  it("runs a shell command with the device's PATH and reports its output", async () => {
    const f = fixture();
    expect(await f.op("shell", { commandLine: "vibestudio chat ask" })).toEqual({
      exitCode: 0,
      output: "args: chat ask\n",
      stderr: "",
    });
    expect(await f.op("binDirectory", {})).toBe(bin);
  });

  it("keeps a command's stdout apart from its diagnostics on stderr", async () => {
    const f = fixture();
    expect(await f.op("shell", { commandLine: "echo trace >&2; echo answer" })).toEqual({
      exitCode: 0,
      output: "answer\n",
      stderr: "trace\n",
    });
  });

  it("tracks launcher shims and settles their removal on the bin directory's file events", async () => {
    const f = fixture();
    fs.writeFileSync(path.join(bin, "chat"), "#!/bin/sh\n");
    f.state.shims["chat"] = { clientId: "chat", command: "open chat" };
    const installed = await f.op("installLauncher", { id: "chat" });
    expect(installed).toEqual({ clientId: "chat", kind: "shim", path: path.join(bin, "chat") });
    expect(await f.op("integrationArtifacts", {})).toEqual([installed]);
    const removed = f.op("waitForArtifactsRemoved", { clientId: "chat" });
    fs.rmSync(path.join(bin, "chat"));
    await removed;
    expect(await f.op("integrationArtifacts", {})).toEqual([]);
  });
});
