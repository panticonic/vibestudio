// @ts-expect-error Script modules are plain .mjs and intentionally untyped.
import { runPairServer } from "../scripts/cli/lib/pair-server.mjs";
// @ts-expect-error Script modules are plain .mjs and intentionally untyped.
import { parseHubReadyPayload } from "../scripts/cli/lib/hub-ready.mjs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeChild extends EventEmitter {
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

const fixedCode = (label: string) => label.padEnd(32, "_").slice(0, 32);
const READY_CODE = fixedCode("PAIRING_READY_CODE");
const READY_QR_CODE = fixedCode("PAIRING_READY_QR_CODE");
const CUSTOM_CODE = fixedCode("PAIRING_CUSTOM_CODE");
const REMOTE_CODE = fixedCode("PAIRING_REMOTE_CODE");
const REMOTE_QR_CODE = fixedCode("PAIRING_REMOTE_QR_CODE");
const SERVER_ID = `srv_${"S".repeat(24)}`;
const SERVER_BOOT_ID = `boot_${"B".repeat(24)}`;

function invite(room: string, fp: string, sig: string, code: string) {
  const params =
    `room=${encodeURIComponent(room)}&fp=${encodeURIComponent(fp)}&code=${encodeURIComponent(code)}` +
    `&sig=${encodeURIComponent(sig)}&v=2&ice=all`;
  return {
    room,
    fp,
    sig,
    code,
    v: 2 as const,
    ice: "all" as const,
    deepLink: `vibestudio://connect?${params}`,
    pairUrl: `https://vibestudio.app/pair#${params}`,
    expiresInMs: 60_000,
    expiresAt: 2_000_000_000_000,
    serverId: SERVER_ID,
    serverBootId: SERVER_BOOT_ID,
  };
}

function hubReady(
  rootInvites: { desktop: ReturnType<typeof invite>; mobile: ReturnType<typeof invite> } | null
) {
  return {
    mode: "hub",
    gatewayUrl: "http://127.0.0.1:3456",
    connectUrl: "http://127.0.0.1:3456",
    rootInvites,
    serverId: SERVER_ID,
    serverBootId: SERVER_BOOT_ID,
    gatewayPort: 3456,
    pid: 4242,
    version: "0.1.0-test",
    workspaces: [],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("pair-server runner", () => {
  beforeEach(() => {
    vi.stubEnv("VIBESTUDIO_WEBRTC_SIGNAL_URL", "wss://signal.test");
  });

  it("prints the WebRTC pairing banner from the structured ready file", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const child = new FakeChild();
    let readyFile = "";

    runPairServer(config, ["--port", "3456"], {
      spawnServer({ serverArgs }: { serverArgs: string[] }) {
        const readyIndex = serverArgs.indexOf("--ready-file");
        readyFile = serverArgs[readyIndex + 1] ?? "";
        setTimeout(() => {
          const fp = "4f8b2a1c9d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a";
          fs.writeFileSync(
            readyFile,
            JSON.stringify(
              hubReady({
                desktop: invite(
                  "room-ready-7f3a9c2b",
                  fp,
                  "wss://signal.vibestudio.dev",
                  READY_CODE
                ),
                mobile: invite(
                  "room-mobile-7f3a9c2b",
                  fp,
                  "wss://signal.vibestudio.dev",
                  READY_QR_CODE
                ),
              })
            )
          );
        }, 10);
        return child;
      },
      onChildExit: () => true,
    });

    await waitFor(() => logText(logSpy).includes(READY_CODE));
    const output = logText(logSpy);
    expect(output).toContain("Pair Test");
    expect(output).toContain("Room:");
    expect(output).toContain("room-ready-7f3a9c2b");
    expect(output).toContain("Fingerprint:");
    expect(output).toContain("4f8b2a1c9d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a");
    expect(output).toContain("Signaling:");
    expect(output).toContain("wss://signal.vibestudio.dev");
    expect(output).toMatch(new RegExp(`Pair code:\\s+${READY_CODE}`));
    expect(output).toMatch(new RegExp(`QR code:\\s+${READY_QR_CODE}`));
    expect(output).toContain(
      `https://vibestudio.app/pair#room=room-ready-7f3a9c2b&fp=4f8b2a1c9d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a&code=${READY_CODE}&sig=wss%3A%2F%2Fsignal.vibestudio.dev&v=2&ice=all`
    );
    expect(output).toContain("room-mobile-7f3a9c2b");
    expect(output).toContain(READY_QR_CODE);
    expect(output).toContain("Pair from test.");

    child.emit("exit", 0, null);
    expect(fs.existsSync(path.dirname(readyFile))).toBe(false);
  });

  it("polls a custom server --ready-file instead of an unused generated file", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const child = new FakeChild();
    const readyDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-pair-custom-"));
    const readyFile = path.join(readyDir, "server-ready.json");
    try {
      runPairServer(config, ["--port", "3456"], {
        buildServerArgs() {
          return ["dist/server.mjs", "--ready-file", readyFile];
        },
        spawnServer({ serverArgs }: { serverArgs: string[] }) {
          expect(serverArgs).toEqual(["dist/server.mjs", "--ready-file", readyFile]);
          setTimeout(() => {
            const fp = "aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00ee11ff22aa33bb44cc55dd66";
            const rootInvite = invite(
              "room-custom-1a2b3c4d",
              fp,
              "ws://127.0.0.1:8787",
              CUSTOM_CODE
            );
            fs.writeFileSync(
              readyFile,
              JSON.stringify(hubReady({ desktop: rootInvite, mobile: rootInvite }))
            );
          }, 10);
          return child;
        },
        onChildExit: () => true,
      });

      await waitFor(() => logText(logSpy).includes(CUSTOM_CODE));
      const output = logText(logSpy);
      expect(output).toMatch(new RegExp(`Pair code:\\s+${CUSTOM_CODE}`));
      expect(output).toContain(
        `https://vibestudio.app/pair#room=room-custom-1a2b3c4d&fp=aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00ee11ff22aa33bb44cc55dd66&code=${CUSTOM_CODE}&sig=ws%3A%2F%2F127.0.0.1%3A8787&v=2&ice=all`
      );
      child.emit("exit", 0, null);
      expect(fs.existsSync(readyDir)).toBe(true);
    } finally {
      fs.rmSync(readyDir, { recursive: true, force: true });
    }
  });

  it("retries when an atomic ready-file replacement races the poll", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const child = new FakeChild();
    const originalReadFileSync = fs.readFileSync.bind(fs);
    let readyFile = "";
    let injectedMissingRead = false;

    vi.spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (String(file) === readyFile && !injectedMissingRead) {
        injectedMissingRead = true;
        const error = new Error("ready file replaced during open") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return originalReadFileSync(file, ...(args as [BufferEncoding]));
    }) as typeof fs.readFileSync);

    runPairServer(config, ["--port", "3456"], {
      spawnServer({ serverArgs }: { serverArgs: string[] }) {
        readyFile = serverArgs[serverArgs.indexOf("--ready-file") + 1] ?? "";
        setTimeout(() => {
          const current = invite(
            "room-ready-replacement",
            "12".repeat(32),
            "wss://signal.test",
            READY_CODE
          );
          fs.writeFileSync(
            readyFile,
            JSON.stringify(hubReady({ desktop: current, mobile: current }))
          );
        }, 10);
        return child;
      },
      onChildExit: () => true,
    });

    await waitFor(() => logText(logSpy).includes(READY_CODE));
    expect(injectedMissingRead).toBe(true);
    expect(child.kill).not.toHaveBeenCalled();
    child.emit("exit", 0, null);
  });

  it("passes remote-serve readiness gates through to the server and prints the pairing banner", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const child = new FakeChild();
    let readyFile = "";

    runPairServer(
      {
        ...config,
        commandName: "vibestudio remote serve",
        requireMobileReady: true,
        requireElectronReady: true,
      },
      ["--port", "3456"],
      {
        spawnServer({ serverArgs }: { serverArgs: string[] }) {
          expect(serverArgs).toContain("--require-mobile-ready");
          expect(serverArgs).toContain("--require-electron-ready");
          const readyIndex = serverArgs.indexOf("--ready-file");
          readyFile = serverArgs[readyIndex + 1] ?? "";
          setTimeout(() => {
            const fp = "11aa22bb33cc44dd55ee66ff77001122334455667788990011223344556677ab";
            fs.writeFileSync(
              readyFile,
              JSON.stringify(
                hubReady({
                  desktop: invite(
                    "room-remote-9z8y7x6w",
                    fp,
                    "wss://signal.example.org",
                    REMOTE_CODE
                  ),
                  mobile: invite(
                    "room-remote-mobile",
                    fp,
                    "wss://signal.example.org",
                    REMOTE_QR_CODE
                  ),
                })
              )
            );
          }, 10);
          return child;
        },
        onChildExit: () => true,
      }
    );

    await waitFor(() => logText(logSpy).includes(REMOTE_CODE));
    const output = logText(logSpy);
    expect(output).toContain("Signaling:");
    expect(output).toContain("wss://signal.example.org");
    expect(output).toMatch(new RegExp(`Pair code:\\s+${REMOTE_CODE}`));
    expect(output).toContain(
      `https://vibestudio.app/pair#room=room-remote-9z8y7x6w&fp=11aa22bb33cc44dd55ee66ff77001122334455667788990011223344556677ab&code=${REMOTE_CODE}&sig=wss%3A%2F%2Fsignal.example.org&v=2&ice=all`
    );
    expect(output).toContain("room-remote-mobile");
    expect(output).toContain(REMOTE_QR_CODE);

    child.emit("exit", 0, null);
  });

  it("rejects raw server flag forwarding", () => {
    expect(() =>
      runPairServer(config, ["--", "--workspace", "dev"], {
        spawnServer() {
          throw new Error("should not spawn");
        },
      })
    ).toThrow(/Raw server flag forwarding is unsupported/);
  });

  it("rejects every retired pairing-server flag as an unknown argument", () => {
    for (const argv of [
      ["--gateway-port", "3456"],
      ["--ephemeral"],
      ["--workspace", "dev"],
      ["--workspace-dir", "/tmp/dev"],
      ["--host", "0.0.0.0"],
      ["--protocol", "https"],
      ["--public-url", "https://server.test"],
      ["--require-public-url"],
      ["--no-init"],
    ]) {
      expect(() =>
        runPairServer(config, argv, {
          spawnServer() {
            throw new Error("should not spawn");
          },
        })
      ).toThrow(/^(?:Unknown argument:|.*no longer supported)/);
    }
  });

  it("uses the hosted signaling endpoint when no signaling flag/env/config is present", () => {
    vi.stubEnv("VIBESTUDIO_WEBRTC_SIGNAL_URL", "");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const child = new FakeChild();
    const spawnServer = vi.fn(({ env }: { env: NodeJS.ProcessEnv }) => {
      expect(env.VIBESTUDIO_WEBRTC_SIGNAL_URL).toBe("wss://signal.vibestudio.app/");
      return child;
    });

    runPairServer(config, ["--port", "3456"], { spawnServer, onChildExit: () => true });
    expect(spawnServer).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "Signaling: wss://signal.vibestudio.app/ (default)"
    );
    child.emit("exit", 0, null);
  });

  it("passes the validated signaling endpoint through to the server env", () => {
    vi.stubEnv("VIBESTUDIO_WEBRTC_SIGNAL_URL", "wss://configured.signal.test");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const child = new FakeChild();

    runPairServer(config, ["--port", "3456"], {
      spawnServer({ env }: { env: NodeJS.ProcessEnv }) {
        expect(env.VIBESTUDIO_WEBRTC_SIGNAL_URL).toBe("wss://configured.signal.test/");
        setTimeout(() => child.emit("exit", 0, null), 10);
        return child;
      },
      onChildExit: () => true,
    });
  });

  it("binds the gateway to loopback and accepts an explicit readiness path", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const child = new FakeChild();
    const readyFile = path.join(os.tmpdir(), "vibestudio-pair-explicit-ready.json");

    runPairServer(config, ["--ready-file", readyFile, "--signaling-url", "wss://signal.test"], {
      spawnServer({ env, serverArgs }: { env: NodeJS.ProcessEnv; serverArgs: string[] }) {
        expect(env.VIBESTUDIO_HOST).toBe("127.0.0.1");
        expect(env.VIBESTUDIO_WEBRTC_SIGNAL_URL).toBe("wss://signal.test/");
        expect(serverArgs[serverArgs.indexOf("--bind-host") + 1]).toBe("127.0.0.1");
        expect(serverArgs[serverArgs.indexOf("--ready-file") + 1]).toBe(readyFile);
        return child;
      },
      onChildExit: () => true,
    });

    child.emit("exit", 0, null);
  });

  it("lets --signal-url override the signaling env and validates cleartext loopback use", () => {
    vi.stubEnv("VIBESTUDIO_WEBRTC_SIGNAL_URL", "wss://env.signal.test");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const child = new FakeChild();

    runPairServer(config, ["--port", "3456", "--signal-url", "ws://127.0.0.1:8787"], {
      spawnServer({ env }: { env: NodeJS.ProcessEnv }) {
        expect(env.VIBESTUDIO_WEBRTC_SIGNAL_URL).toBe("ws://127.0.0.1:8787/");
        setTimeout(() => child.emit("exit", 0, null), 10);
        return child;
      },
      onChildExit: () => true,
    });
  });

  it("rejects non-loopback cleartext signaling before spawning", () => {
    const spawnServer = vi.fn(() => new FakeChild());

    expect(() =>
      runPairServer(config, ["--port", "3456", "--signal-url", "http://example.org"], {
        spawnServer,
      })
    ).toThrow(/Cleartext signaling is only allowed for loopback/);
    expect(spawnServer).not.toHaveBeenCalled();
  });

  it("rejects the removed pre-hub ready-file shape instead of scraping stdout", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const child = new FakeChild();
    let readyFile = "";

    runPairServer(config, ["--port", "3456"], {
      spawnServer({ serverArgs }: { serverArgs: string[] }) {
        readyFile = serverArgs[serverArgs.indexOf("--ready-file") + 1] ?? "";
        setTimeout(() => {
          fs.writeFileSync(readyFile, JSON.stringify({ pairingCode: "OLD", pairing: {} }));
        }, 10);
        return child;
      },
      onChildExit: () => true,
    });

    await waitFor(() => child.kill.mock.calls.length > 0);
    expect(logText(errorSpy)).toMatch(/unsupported fields|missing fields/);
  });

  it("rejects unknown nested invite fields and mismatched pairing links", () => {
    const current = invite(
      "room-strict-contract",
      "AA".repeat(32),
      "wss://signal.test",
      READY_CODE
    );
    const valid = hubReady({ desktop: current, mobile: current });
    expect(parseHubReadyPayload(valid)).toEqual(valid);
    expect(() =>
      parseHubReadyPayload({
        ...valid,
        rootInvites: {
          ...valid.rootInvites,
          desktop: { ...current, serverUrl: "https://legacy.example" },
        },
      })
    ).toThrow(/unsupported fields/);
    expect(() =>
      parseHubReadyPayload({
        ...valid,
        rootInvites: {
          ...valid.rootInvites,
          desktop: { ...current, room: "room-different" },
        },
      })
    ).toThrow(/does not match the invite coordinates/);
  });

  it("uses the live TypeScript server entry when requested", async () => {
    vi.stubEnv("VIBESTUDIO_SERVER_ENTRY", "live");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const child = new FakeChild();
    const prepareSourceServer = vi.fn();

    runPairServer(config, ["--port", "3456"], {
      prepareSourceServer,
      spawnServer({
        serverArgs,
        invocation,
      }: {
        serverArgs: string[];
        invocation: { command: string; args: string[] };
      }) {
        expect(serverArgs[0]).toBe("src/server/index.ts");
        expect(invocation.command).toBe(process.execPath);
        expect(invocation.args).toEqual(["--import", "tsx", ...serverArgs]);
        setTimeout(() => child.emit("exit", 0, null), 10);
        return child;
      },
      onChildExit: () => true,
    });

    await waitFor(() => child.listenerCount("exit") > 0);
    expect(prepareSourceServer).toHaveBeenCalledTimes(1);
    child.emit("exit", 0, null);
  });
});

function logText(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls
    .flat()
    .map((value) => String(value))
    .join("\n");
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition");
}
