import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTerminalDelivery, terminalHostDescriptor } from "./clientDelivery.js";
import { importClientModule } from "./terminalHost.js";

const PROGRAM = "export async function run() { return { kind: 'quit' }; }\n";
const integrityOf = (text: string) => `sha256-${createHash("sha256").update(text).digest("hex")}`;
const ROUTE = "/_a/build-1/index.mjs";
const DIGEST = "e".repeat(64);

function ready(overrides: { hostAbi?: string; integrity?: string } = {}) {
  return {
    state: "ready",
    client: {
      source: "clients/chat-terminal",
      id: "chat",
      runtime: "terminal",
      title: "Chat",
      buildKey: "build-1",
      executionDigest: DIGEST,
      effectiveVersion: "1",
      hostAbi: overrides.hostAbi ?? "terminal-host-1",
      artifacts: [
        {
          path: "index.mjs",
          role: "primary",
          contentType: "text/javascript",
          integrity: overrides.integrity ?? integrityOf(PROGRAM),
        },
      ],
      grantedCapabilities: ["device-session"],
      deniedOptional: [],
    },
  };
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function harness(options: { served?: string; launch?: unknown } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-delivery-test-"));
  roots.push(root);
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const device = {
    call: vi.fn(async (method: string, args: unknown[] = []) => {
      calls.push({ method, args });
      if (method === "clients.launch") return options.launch ?? ready();
      if (method === "auth.grantClientPrincipal") {
        return {
          connectionGrant: "one-use",
          expiresAt: 1,
          principalId: "client:chat:terminal:dev_1",
          deviceId: "dev_1",
          serverId: "srv",
          serverBootId: "boot",
          workspaceId: "ws_system",
        };
      }
      throw new Error(`unexpected call ${method}`);
    }),
    stream: vi.fn(async () => new Response(options.served ?? PROGRAM, { status: 200 })),
  };
  const delivery = createTerminalDelivery({
    device: device as never,
    hostVersion: "1.2.3",
    cacheRoot: path.join(root, "cache"),
  });
  return { delivery, device, calls, root };
}

describe("terminal client delivery", () => {
  it("fetches into the verified cache, imports that file, and binds the grant to the exact build", async () => {
    const { delivery, device, calls, root } = harness();
    const state = await delivery.launcher.launch({ default: true });
    expect(state.state).toBe("ready");
    if (state.state !== "ready") return;
    const { launched } = state;
    // The launch asked for this host's descriptor.
    expect(calls[0]).toMatchObject({
      method: "clients.launch",
      args: [{ host: terminalHostDescriptor("1.2.3"), select: { default: true } }],
    });
    expect(device.stream).toHaveBeenCalledWith("main", "gateway.fetch", [
      { path: ROUTE, method: "GET" },
    ]);
    // The principal is requested for the build that was verified, nothing else.
    expect(calls.find((call) => call.method === "auth.grantClientPrincipal")?.args).toEqual([
      { source: "clients/chat-terminal", buildKey: "build-1", executionDigest: DIGEST },
    ]);
    expect(launched.grant.connectionGrant).toBe("one-use");
    // The program is imported from the cache under its own name; no scratch file exists.
    const entry = launched.artifacts[0]!;
    expect(path.basename(entry.handle)).toBe("index.mjs");
    expect(entry.handle.startsWith(path.join(root, "cache"))).toBe(true);
    const module = await importClientModule(launched);
    await expect(module.run({} as never)).resolves.toEqual({ kind: "quit" });
  });

  it("never imports bytes that do not match the integrity the server sealed", async () => {
    const tampered = "export async function run() { process.exit(1); }\n";
    const { delivery, calls, root } = harness({ served: tampered });
    await expect(delivery.launcher.launch({ default: true })).rejects.toMatchObject({
      code: "integrity-mismatch",
    });
    // Nothing was stored, and no principal was ever requested for the build.
    const stored = fs.existsSync(path.join(root, "cache"))
      ? fs.readdirSync(path.join(root, "cache")).filter((name) => !name.startsWith("."))
      : [];
    expect(stored).toEqual([]);
    expect(calls.some((call) => call.method === "auth.grantClientPrincipal")).toBe(false);
  });

  it("checks the host ABI before downloading or granting anything", async () => {
    const { delivery, device, calls } = harness({ launch: ready({ hostAbi: "terminal-host-9" }) });
    await expect(delivery.launcher.launch({ default: true })).rejects.toMatchObject({
      code: "host-abi-mismatch",
    });
    expect(device.stream).not.toHaveBeenCalled();
    expect(calls.some((call) => call.method === "auth.grantClientPrincipal")).toBe(false);
  });

  it("claims only capabilities the terminal host implements", () => {
    const descriptor = terminalHostDescriptor("1.0.0");
    expect(descriptor.host).toBe("terminal");
    expect(descriptor.runtimes).toEqual({ terminal: "terminal-host-1" });
    expect(descriptor.capabilities).toEqual(
      expect.arrayContaining(["device-session", "clipboard", "local-files", "notifications"])
    );
    expect(descriptor.capabilities).not.toContain("integration.install");
    expect(descriptor.capabilities).not.toContain("tray");
  });
});
