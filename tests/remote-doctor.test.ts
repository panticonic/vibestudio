// @ts-expect-error Script modules are plain .mjs and intentionally untyped.
import {
  checkDeployedUnit,
  checkSignaling,
  gatewayPortFromUnit,
  inspectIdentity,
  runDoctor,
  signalingRoomWsUrl,
} from "../scripts/cli/remote-doctor.mjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

class FakeSocket extends EventEmitter {
  terminate = vi.fn();
  close = vi.fn();
}

function tmpFile(name: string, content: string, mode = 0o600): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-doctor-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, { mode });
  fs.chmodSync(file, mode);
  return file;
}

const IDENTITY_PEM =
  "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n" +
  "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("remote-doctor", () => {
  it("dials a per-room ws URL with role=answerer (never the endpoint root)", () => {
    const url = new URL(signalingRoomWsUrl("https://signal.example/", "abc-123"));
    expect(url.protocol).toBe("wss:");
    expect(url.pathname).toBe("/room/abc-123");
    expect(url.searchParams.get("role")).toBe("answerer");
  });

  it("converts http signaling to ws for the room probe", () => {
    const url = new URL(signalingRoomWsUrl("http://127.0.0.1:8787/", "room1234"));
    expect(url.protocol).toBe("ws:");
    expect(url.pathname).toBe("/room/room1234");
  });

  it("reports signaling reachable when the room socket opens", async () => {
    const socket = new FakeSocket();
    let dialed = "";
    const factory = (u: string) => {
      dialed = u;
      queueMicrotask(() => socket.emit("open"));
      return socket;
    };
    const result = await checkSignaling("wss://signal.example/", factory);
    expect(result.ok).toBe(true);
    expect(dialed).toContain("/room/");
    expect(dialed).toContain("role=answerer");
  });

  it("reports signaling unreachable on socket error", async () => {
    const socket = new FakeSocket();
    const factory = () => {
      queueMicrotask(() => socket.emit("error", new Error("ECONNREFUSED")));
      return socket;
    };
    const result = await checkSignaling("wss://signal.example/", factory);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/cannot connect/);
  });

  it("passes a well-formed 0600 identity file", () => {
    const file = tmpFile("identity.pem", IDENTITY_PEM, 0o600);
    const result = inspectIdentity(file);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("cert+key");
  });

  it("fails a group/world-readable identity file", () => {
    const file = tmpFile("identity.pem", IDENTITY_PEM, 0o644);
    const result = inspectIdentity(file);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/group\/world accessible/);
  });

  it("fails a missing identity file", () => {
    const result = inspectIdentity("/nonexistent/vibestudio/identity.pem");
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/missing/);
  });

  it("fails an identity file that lacks the private key", () => {
    const file = tmpFile(
      "identity.pem",
      "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
      0o600
    );
    const result = inspectIdentity(file);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/certificate and private key/);
  });

  it("parses the gateway port out of a unit ExecStart line", () => {
    const unit = "[Service]\nExecStart=/home/u/.npm/bin/vibestudio remote serve --port 3040\n";
    expect(gatewayPortFromUnit(unit)).toBe(3040);
    expect(gatewayPortFromUnit("[Service]\nExecStart=/x/vibestudio remote serve\n")).toBeNull();
  });

  it("skips (does not fail) the systemd-unit check when no unit is deployed", async () => {
    const { unit, port } = await checkDeployedUnit(
      undefined,
      "/nonexistent/vibestudio-server.service"
    );
    expect(unit.skipped).toBe(true);
    expect(unit.ok).toBe(true);
    expect(port).toBeNull();
  });

  it("checks unit active state and parses the port when a unit exists", async () => {
    const unitPath = tmpFile(
      "vibestudio-server.service",
      "[Service]\nExecStart=/x/vibestudio remote serve --port 3055\n"
    );
    const spawnImpl = { spawnSync: () => ({ status: 0, stdout: "active\n", stderr: "" }) };
    const { unit, port } = await checkDeployedUnit(spawnImpl, unitPath);
    expect(unit.ok).toBe(true);
    expect(unit.skipped).toBeUndefined();
    expect(port).toBe(3055);
  });

  it("runDoctor aggregates checks and ignores skipped ones for the overall verdict", async () => {
    const identity = tmpFile("identity.pem", IDENTITY_PEM, 0o600);
    const socket = new FakeSocket();
    const result = await runDoctor(
      { signalUrl: "wss://signal.example/", identity },
      {
        require: () => ({}), // node-datachannel stub loads
        unitPath: "/nonexistent/unit.service", // → skipped
        wsFactory: () => {
          queueMicrotask(() => socket.emit("open"));
          return socket;
        },
      }
    );
    expect(result.ok).toBe(true);
    expect(
      result.checks.some(
        (c: { name: string; skipped?: boolean }) => c.name === "systemd-unit" && c.skipped
      )
    ).toBe(true);
    expect(
      result.checks.some((c: { name: string; ok: boolean }) => c.name === "identity" && c.ok)
    ).toBe(true);
    expect(
      result.checks.some(
        (c: { name: string; skipped?: boolean }) => c.name === "identity" && !c.skipped
      )
    ).toBe(true);
    expect(
      result.checks.some((c: { name: string; ok: boolean }) => c.name === "signaling" && c.ok)
    ).toBe(true);
  });
});
