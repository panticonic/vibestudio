// @ts-expect-error Script modules are plain .mjs and intentionally untyped.
import {
  deploy,
  main,
  parseArgs,
  REQUIRED_NODE_VERSION,
  showManagedPairing,
} from "../scripts/cli/remote-deploy.mjs";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createConnectDeepLink,
  createConnectPairUrl,
  derivePairingRoom,
  PAIRING_PROTOCOL_VERSION,
} from "@vibestudio/shared/connect";

type RunCall = {
  command: string;
  args: string[];
  options?: { input?: string };
};

function sshScripts(calls: RunCall[]): string[] {
  return calls.filter((call) => call.command === "ssh").map((call) => call.options?.input ?? "");
}

function managedReady(rootInvite: Record<string, unknown> | null) {
  return {
    mode: "hub",
    gatewayUrl: "http://127.0.0.1:3030",
    rootInvite,
    serverId: `srv_${"S".repeat(24)}`,
    serverBootId: `boot_${"B".repeat(24)}`,
    gatewayPort: 3030,
    pid: 4242,
    version: "0.1.11-test",
    buildId: "a".repeat(64),
    workspaces: [{ workspaceId: "ws_default", name: "default", lastOpened: 1, running: true }],
  };
}

function managedInvite() {
  const coordinates = {
    room: derivePairingRoom("M".repeat(32)),
    fp: "AB".repeat(32),
    sig: "wss://signal.test/",
    code: "M".repeat(32),
    exp: 4_000_000_000_000,
    v: PAIRING_PROTOCOL_VERSION,
    ice: "all" as const,
  };
  return {
    ...coordinates,
    deepLink: createConnectDeepLink(coordinates),
    pairUrl: createConnectPairUrl(coordinates),
    expiresInMs: 60_000,
    expiresAt: coordinates.exp,
    serverId: `srv_${"S".repeat(24)}`,
    serverBootId: `boot_${"B".repeat(24)}`,
  };
}

describe("remote-deploy CLI", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses deploy options without mutating the caller's argv", () => {
    const argv = ["deploy@example.test", "--port", "3035"];

    expect(parseArgs(argv)).toMatchObject({
      verb: "deploy",
      target: "deploy@example.test",
      port: "3035",
    });
    expect(argv).toEqual(["deploy@example.test", "--port", "3035"]);
  });

  it("enforces the package Node engine, writes the service, and runs diagnostics", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const calls: RunCall[] = [];
    const run = vi.fn(async (command: string, args: string[], options?: { input?: string }) => {
      calls.push({ command, args, options });
    });

    await deploy(
      {
        verb: "deploy",
        target: "deploy@example.test",
        artifact: null,
        signalUrl: "wss://signal.example.test",
        port: "3035",
        help: false,
      },
      { run }
    );

    expect(calls.every((call) => call.command === "ssh")).toBe(true);
    expect(calls.every((call) => call.args.length === 4)).toBe(true);
    expect(calls.every((call) => call.args[0] === "deploy@example.test")).toBe(true);
    expect(calls.every((call) => call.args.slice(1).join(" ") === "bash -l -s")).toBe(true);

    const [preflight, install, service, postStart] = sshScripts(calls);
    expect(REQUIRED_NODE_VERSION).toEqual([22, 19, 0]);
    expect(preflight).toContain("Node.js 22.19.0+");
    expect(preflight).toContain("actual[1]===required[1]");
    expect(preflight).toContain("systemctl --user --version");
    expect(preflight).toContain("loginctl enable-linger");
    expect(install).toContain("npm install -g '@panticonic/vibestudio-server@");
    expect(service).toContain("cat > $HOME/.config/systemd/user/vibestudio-server.service");
    expect(service).toContain("UMask=0077");
    expect(service).toContain("StartLimitBurst=5");
    expect(service).toContain(
      'remote serve --port 3035 --ready-file "%h/.config/vibestudio/server-auth/hub-ready.json"'
    );
    expect(service).not.toContain("VIBESTUDIO_WEBRTC_IDENTITY");
    expect(service).toContain(
      'Environment="VIBESTUDIO_WEBRTC_SIGNAL_URL=wss://signal.example.test"\nExecStart=__NODE_BIN__ __VIBESTUDIO_ENTRY__ remote serve --port 3035'
    );
    expect(service).toContain("node_bin=$(command -v node)");
    expect(service).toContain("vibestudio_bin=$(command -v vibestudio)");
    expect(service).toContain('vibestudio_entry=$(readlink -f "$vibestudio_bin")');
    expect(service).toContain(
      'sed -i "s|__NODE_BIN__|$node_bin|g; s|__VIBESTUDIO_ENTRY__|$vibestudio_entry|g" $HOME/.config/systemd/user/vibestudio-server.service'
    );
    expect(service).not.toContain('Environment="PATH=');
    expect(service).toContain("systemctl --user restart vibestudio-server.service");
    expect(service).toContain("fetch('http://127.0.0.1:3035/healthz')");
    expect(service).toContain("fetch('http://127.0.0.1:3035/_workspace/default/healthz')");
    expect(service).toContain("the failed service was stopped");
    expect(postStart).not.toContain("journalctl");
    expect(postStart).toContain(
      '"$node_bin" "$vibestudio_entry" remote doctor --signal-url \'wss://signal.example.test\''
    );
    expect(postStart).toContain(
      '"$node_bin" "$vibestudio_entry" remote doctor --signal-url \'wss://signal.example.test\' --workspace default'
    );
    expect(postStart).toContain('"$node_bin" "$vibestudio_entry" remote deploy pairing local');
  });

  it("rejects the removed deployment-time workspace flag", () => {
    expect(() => parseArgs(["deploy@example.test", "--workspace", "notes"])).toThrow(
      /Unknown argument/
    );
  });

  it("validates deployment ports and signaling values before SSH", () => {
    expect(() => parseArgs(["deploy@example.test", "--port", "0"])).toThrow(/1 to 65535/);
    expect(() =>
      parseArgs(["deploy@example.test", "--signal-url", "wss://user:secret@signal.test"])
    ).toThrow(/must not contain credentials/);
    expect(() =>
      parseArgs(["deploy@example.test", "--signal-url", "wss://signal.test\nINJECTED"])
    ).toThrow(/control characters/);
  });

  it("rejects SSH option injection and parses destructive purge explicitly", () => {
    expect(() => parseArgs(["-oProxyCommand=bad"])).not.toThrow();
    expect(parseArgs(["remove", "deploy@example.test", "--purge"])).toMatchObject({
      verb: "remove",
      purge: true,
    });
  });

  it("routes status through the mocked SSH runner", async () => {
    const calls: RunCall[] = [];

    await main(["status", "deploy@example.test"], {
      run: async (command: string, args: string[], options?: { input?: string }) => {
        calls.push({ command, args, options });
      },
    });

    expect(calls).toEqual([
      {
        command: "ssh",
        args: ["deploy@example.test", "bash", "-l", "-s"],
        options: { input: "systemctl --user --no-pager status vibestudio-server.service" },
      },
    ]);
  });

  it("deploys this computer through the same service lifecycle without SSH", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const calls: RunCall[] = [];
    const run = vi.fn(async (command: string, args: string[], options?: { input?: string }) => {
      calls.push({ command, args, options });
    });

    await deploy(
      {
        verb: "deploy",
        target: "local",
        artifact: null,
        signalUrl: null,
        port: "3030",
        help: false,
      },
      { run }
    );

    expect(calls).toHaveLength(4);
    expect(calls.every((call) => call.command === "bash")).toBe(true);
    expect(calls.every((call) => call.args.join(" ") === "-l -s")).toBe(true);
    const scripts = calls.map((call) => call.options?.input ?? "");
    expect(scripts[1]).toContain("npm install -g '@panticonic/vibestudio-server@");
    expect(scripts[2]).toContain("vibestudio-server.service");
    expect(scripts[3]).toContain("remote doctor");
  });

  it("manages the local service without requiring an SSH daemon", async () => {
    const calls: RunCall[] = [];

    await main(["status", "local"], {
      run: async (command: string, args: string[], options?: { input?: string }) => {
        calls.push({ command, args, options });
      },
    });

    expect(calls).toEqual([
      {
        command: "bash",
        args: ["-l", "-s"],
        options: { input: "systemctl --user --no-pager status vibestudio-server.service" },
      },
    ]);
  });

  it("shows local managed pairing without routing through SSH", async () => {
    const show = vi.fn(async () => undefined);

    await main(["pairing", "local"], { showManagedPairing: show });

    expect(show).toHaveBeenCalledOnce();
  });

  it("shows remote managed pairing through the installed target CLI", async () => {
    const calls: RunCall[] = [];

    await main(["pairing", "deploy@example.test"], {
      run: async (command: string, args: string[], options?: { input?: string }) => {
        calls.push({ command, args, options });
      },
    });

    const [script] = sshScripts(calls);
    expect(script).toContain('"$node_bin" "$vibestudio_entry" remote deploy pairing local');
  });

  it("prints only a live protected invite from a ready default workspace", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-managed-pairing-"));
    const readyFile = path.join(root, "hub-ready.json");
    const payload = managedReady(managedInvite());
    fs.writeFileSync(readyFile, JSON.stringify(payload), { mode: 0o600 });
    const fetchImpl = vi.fn(async (input: URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/healthz") {
        return new Response(
          JSON.stringify({
            ok: true,
            mode: "hub",
            serverId: payload.serverId,
            serverBootId: payload.serverBootId,
            pid: payload.pid,
            buildId: payload.buildId,
          })
        );
      }
      return new Response(JSON.stringify({ ok: true }));
    });

    await expect(showManagedPairing({ readyFile, fetchImpl })).resolves.toMatchObject({
      serverBootId: payload.serverBootId,
    });
    expect(log).toHaveBeenCalledWith(
      "  One-time:   Pairs one device; accepted links cannot be replayed."
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("rejects overexposed managed pairing state", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-managed-pairing-"));
    const readyFile = path.join(root, "hub-ready.json");
    fs.writeFileSync(readyFile, JSON.stringify(managedReady(managedInvite())), { mode: 0o644 });

    await expect(showManagedPairing({ readyFile })).rejects.toThrow(/unsafe permissions/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("purges only workspace reaches and preserves the stable hub identity epoch", async () => {
    const calls: RunCall[] = [];

    await main(["remove", "deploy@example.test", "--purge"], {
      run: async (command: string, args: string[], options?: { input?: string }) => {
        calls.push({ command, args, options });
      },
    });

    const [script] = sshScripts(calls);
    expect(script).toContain("workspaces -maxdepth 4 -type d -path '*/reach/webrtc'");
    expect(script).not.toContain("server-auth/webrtc");
    expect(script).not.toContain("server-auth/identity.db");
    expect(script).toContain("hub pairing remains valid");
    expect(script).toContain("re-route workspaces");
    expect(script).not.toContain("must re-pair");
  });

  it("returns a non-zero process status when the direct CLI has no target", () => {
    const result = spawnSync(
      process.execPath,
      [path.join(process.cwd(), "scripts", "cli", "remote-deploy.mjs")],
      { encoding: "utf8" }
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("vibestudio remote deploy");
  });
});
