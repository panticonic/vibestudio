// @ts-expect-error Script modules are plain .mjs and intentionally untyped.
import { parsePairArgs, runPairServer } from "../scripts/cli/lib/pair-server.mjs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConnectDeepLink, createConnectPairUrl } from "@vibestudio/shared/connect";

class FakeChild extends EventEmitter {
  pid = 43210;
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill = vi.fn((signal?: NodeJS.Signals | string) => {
    this.killed = true;
    this.emit("exit", null, signal ?? "SIGTERM");
    return true;
  });
}

const config = {
  commandName: "pair-test",
  usage: ["pair-test"],
  logPrefix: "pair-test",
  portEnv: ["VIBESTUDIO_PAIR_TEST_PORT"],
  devEnv: "VIBESTUDIO_PAIR_TEST_DEV",
  bannerTitle: "Pair Test",
  deepLinkLabel: "Deep link",
  instructions: "Pair from test.",
};

function invite() {
  const pairing = {
    endpointId: "ab".repeat(32),
    relays: ["https://relay.example/"],
    v: 4 as const,
    code: "C".repeat(32),
    exp: 4_000_000_000_000,
  };
  return {
    ...pairing,
    deepLink: createConnectDeepLink(pairing),
    pairUrl: createConnectPairUrl(pairing),
    expiresInMs: 60_000,
    expiresAt: pairing.exp,
    serverId: `srv_${"S".repeat(24)}`,
    serverBootId: `boot_${"B".repeat(24)}`,
  };
}

function ready(rootInvite: ReturnType<typeof invite> | null) {
  return {
    mode: "hub",
    gatewayUrl: "http://127.0.0.1:3456",
    rootInvite,
    serverId: `srv_${"S".repeat(24)}`,
    serverBootId: `boot_${"B".repeat(24)}`,
    gatewayPort: 3456,
    pid: 4242,
    version: "0.1.0-test",
    buildId: "a".repeat(64),
    workspaces: [],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("pair-server runner", () => {
  it("accepts only explicit canonical unique HTTPS relays", () => {
    expect(parsePairArgs(["--relay-url", "https://relay.example/"], config).relayUrls).toEqual([
      "https://relay.example/",
    ]);
    expect(() => parsePairArgs(["--relay-url", "http://relay.example/"], config)).toThrow(
      /canonical HTTPS/
    );
    expect(() =>
      parsePairArgs(
        ["--relay-url", "https://relay.example/", "--relay-url", "https://relay.example/"],
        config
      )
    ).toThrow(/unique/);
    expect(() => parsePairArgs(["--host", "0.0.0.0"], config)).toThrow(
      /gateway binds loopback only/
    );
  });

  it("passes the ordered relay set to the Iroh server environment", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const child = new FakeChild();
    const operation = runPairServer(
      config,
      ["--relay-url", "https://one.example/", "--relay-url", "https://two.example/"],
      {
        prepareSourceServer: () => undefined,
        spawnServer({ env, serverArgs }: { env: NodeJS.ProcessEnv; serverArgs: string[] }) {
          expect(env.VIBESTUDIO_HOST).toBe("127.0.0.1");
          expect(env.VIBESTUDIO_IROH_RELAYS).toBe("https://one.example/,https://two.example/");
          expect(serverArgs).toContain("--ready-file");
          queueMicrotask(() => child.emit("exit", 0, null));
          return child;
        },
        onChildExit: () => true,
      }
    );
    await operation;
  });

  it("prints Endpoint ID and relays from the authoritative ready invite", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const child = new FakeChild();
    let readyFile = "";
    const operation = runPairServer(config, [], {
      prepareSourceServer: () => undefined,
      spawnServer({ serverArgs }: { serverArgs: string[] }) {
        readyFile = serverArgs[serverArgs.indexOf("--ready-file") + 1]!;
        setTimeout(() => fs.writeFileSync(readyFile, JSON.stringify(ready(invite()))), 10);
        return child;
      },
      onChildExit: () => true,
    });
    await vi.waitFor(() => {
      const output = log.mock.calls.map((call) => String(call[0])).join("\n");
      expect(output).toContain(`Endpoint ID: ${"ab".repeat(32)}`);
      expect(output).toContain("Relays:      https://relay.example/");
    });
    child.emit("exit", 0, null);
    await operation;
  });
});
