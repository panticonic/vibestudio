import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createConnectDeepLink, createConnectPairUrl } from "@vibestudio/shared/connect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadCliCredentials, saveCliCredentials } from "../cli/credentialStore.js";
import { ConnectionError } from "../cli/output.js";
import { bootstrapInstanceCli, bootstrapInstanceCliFromDevice } from "./bootstrapInstanceCli.js";

const roots: string[] = [];
const reach = (byte: string) => ({
  endpointId: byte.repeat(32),
  relays: ["https://relay.example/"],
  v: 5 as const,
});

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("bootstrapInstanceCliFromDevice", () => {
  it("routes a saved private identity without publishing it in hub readiness", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-cli-private-"));
    roots.push(root);
    const credentialFile = path.join(root, "credentials.json");
    const serverId = `srv_${"S".repeat(24)}`;
    const serverBootId = `boot_${"B".repeat(24)}`;
    saveCliCredentials(
      {
        schemaVersion: 5,
        kind: "device",
        transport: "local",
        pairedAt: 123,
        url: "http://127.0.0.1:5000/_workspace/private-old-name",
        workspaceId: "ws_private",
        workspaceName: "private-old-name",
        serverId,
        deviceId: `dev_${"C".repeat(24)}`,
        refreshToken: "R".repeat(43),
      },
      credentialFile
    );
    const call = vi.fn(async (method, args) => {
      expect({ method, args }).toEqual({
        method: "hubControl.routeWorkspace",
        args: [{ workspaceId: "ws_private" }],
      });
      return {
        workspace: "private-new-name",
        workspaceId: "ws_private",
        running: true,
        serverUrl: "http://127.0.0.1:5000/_r/ws/private-new-name",
        workspaceReach: reach("cc"),
        serverId,
        serverBootId,
      };
    });
    const close = vi.fn(async () => undefined);
    await expect(
      bootstrapInstanceCli(
        {
          gatewayUrl: "http://127.0.0.1:5000",
          serverId,
          serverBootId,
          workspaces: [],
          mode: "hub",
          rootInvite: null,
          gatewayPort: 5000,
          pid: 1,
          version: "0.1.33",
          buildId: "a".repeat(64),
        },
        { credentialFile, rpcClient: () => ({ call, close }) }
      )
    ).resolves.toEqual({
      status: "existing",
      workspaceName: "private-new-name",
      workspaceId: "ws_private",
    });
    expect(loadCliCredentials(credentialFile)).toMatchObject({ workspaceId: "ws_private" });
    expect(close).toHaveBeenCalledOnce();
  });
  it("reconciles an existing CLI device onto the current ephemeral workspace route", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-cli-reconcile-"));
    roots.push(root);
    const credentialFile = path.join(root, "credentials.json");
    const serverId = `srv_${"S".repeat(24)}`;
    const existingDeviceId = `dev_${"C".repeat(24)}`;
    saveCliCredentials(
      {
        schemaVersion: 5,
        kind: "device",
        url: "http://127.0.0.1:5000/_workspace/dev",
        workspaceId: "ws_dev_retired",
        workspaceName: "dev",
        serverId,
        deviceId: existingDeviceId,
        refreshToken: "R".repeat(43),
        transport: "local",
        pairedAt: 123,
      },
      credentialFile
    );
    const rpcClient = vi.fn((credential: { deviceId: string }) => ({
      call: vi.fn(async (method: string, args: unknown[]) => {
        expect(credential.deviceId).toBe(existingDeviceId);
        expect({ method, args }).toEqual({
          method: "hubControl.routeWorkspace",
          args: [{ workspaceId: "ws_dev_current" }],
        });
        return {
          workspace: "dev",
          workspaceId: "ws_dev_current",
          running: true,
          serverUrl: "http://127.0.0.1:5000/_r/ws/dev",
          workspaceReach: reach("cc"),
          serverId,
          serverBootId: `boot_${"B".repeat(24)}`,
        };
      }),
      close: vi.fn(async () => undefined),
    }));
    const fetchMock = vi.fn();

    await expect(
      bootstrapInstanceCliFromDevice(
        {
          gatewayUrl: "http://127.0.0.1:5000",
          serverId,
          workspaceId: "ws_dev_current",
          workspaceName: "dev",
          deviceId: `dev_${"A".repeat(24)}`,
          refreshToken: "Q".repeat(43),
        },
        { credentialFile, fetch: fetchMock as typeof fetch, rpcClient }
      )
    ).resolves.toEqual({
      status: "existing",
      workspaceName: "dev",
      workspaceId: "ws_dev_current",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(rpcClient).toHaveBeenCalledOnce();
    expect(loadCliCredentials(credentialFile)).toMatchObject({
      workspaceId: "ws_dev_current",
      workspaceName: "dev",
      deviceId: existingDeviceId,
      pairedAt: 123,
      transport: "local",
    });
  });

  it("uses an authenticated device invite when the root invite has already been consumed", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-cli-bootstrap-"));
    roots.push(root);
    const credentialFile = path.join(root, "credentials.json");
    const serverId = `srv_${"S".repeat(24)}`;
    const serverBootId = `boot_${"B".repeat(24)}`;
    const pairing = {
      ...reach("aa"),
      code: "D".repeat(21) + "A",
    };
    const invite = {
      ...pairing,
      deepLink: createConnectDeepLink(pairing),
      pairUrl: createConnectPairUrl(pairing),
      expiresInMs: 2_000_000_000_000 - Date.now(),
      expiresAt: 2_000_000_000_000,
      serverId,
      serverBootId,
    };
    const calls: Array<{ deviceId: string; method: string; args: unknown[] }> = [];
    const rpcClient = vi.fn((credential: { deviceId: string }) => ({
      call: vi.fn(async (method: string, args: unknown[]) => {
        calls.push({ deviceId: credential.deviceId, method, args });
        if (method === "hubControl.pairDevice") {
          return { pairing: invite };
        }
        if (method === "hubControl.ensureUserWorkspaces") {
          return {
            personal: { workspaceId: "ws_personal" },
            system: { workspaceId: "ws_system" },
          };
        }
        return {
          workspace: "system-ws_system",
          workspaceId: "ws_system",
          running: true,
          serverUrl: "http://127.0.0.1:5000/_r/ws/system-ws_system",
          workspaceReach: reach("bb"),
          serverId,
          serverBootId,
        };
      }),
      close: vi.fn(async () => undefined),
    }));
    const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        code: pairing.code,
        label: "Vibestudio development CLI",
      });
      return Response.json({
        deviceId: `dev_${"C".repeat(24)}`,
        refreshToken: "R".repeat(43),
        workspaceId: "ws_dev",
      });
    });

    await expect(
      bootstrapInstanceCliFromDevice(
        {
          gatewayUrl: "http://127.0.0.1:5000",
          serverId,
          workspaceId: "ws_dev",
          workspaceName: "dev",
          deviceId: `dev_${"A".repeat(24)}`,
          refreshToken: "Q".repeat(43),
        },
        { credentialFile, fetch: fetchMock as typeof fetch, rpcClient }
      )
    ).resolves.toEqual({
      status: "paired",
      workspaceName: "system-ws_system",
      workspaceId: "ws_system",
    });

    // The account's own workspaces are prepared first and System is opened —
    // where the account's tooling lives, and what a desktop client routes its
    // own connection to. The invite's workspace is a preference, not the
    // shape of the account.
    expect(calls).toEqual([
      {
        deviceId: `dev_${"A".repeat(24)}`,
        method: "hubControl.pairDevice",
        args: [{ workspace: "dev" }],
      },
      {
        deviceId: `dev_${"C".repeat(24)}`,
        method: "hubControl.ensureUserWorkspaces",
        args: [],
      },
      {
        deviceId: `dev_${"C".repeat(24)}`,
        method: "hubControl.routeWorkspace",
        args: [{ workspaceId: "ws_system" }],
      },
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(loadCliCredentials(credentialFile)).toMatchObject({
      serverId,
      workspaceId: "ws_system",
      workspaceName: "system-ws_system",
      deviceId: `dev_${"C".repeat(24)}`,
      transport: "local",
    });
  });

  it("opens Personal when the instance selects it, not the account's default System", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-cli-personal-"));
    roots.push(root);
    const credentialFile = path.join(root, "credentials.json");
    const serverId = `srv_${"S".repeat(24)}`;
    const serverBootId = `boot_${"B".repeat(24)}`;
    const pairing = { ...reach("aa"), code: "D".repeat(21) + "A" };
    const invite = {
      ...pairing,
      deepLink: createConnectDeepLink(pairing),
      pairUrl: createConnectPairUrl(pairing),
      expiresInMs: 2_000_000_000_000 - Date.now(),
      expiresAt: 2_000_000_000_000,
      serverId,
      serverBootId,
    };
    const routed: unknown[] = [];
    const rpcClient = vi.fn(() => ({
      call: vi.fn(async (method: string, args: unknown[]) => {
        if (method === "hubControl.ensureUserWorkspaces") {
          return {
            personal: { workspaceId: "ws_personal" },
            system: { workspaceId: "ws_system" },
          };
        }
        routed.push(args[0]);
        return {
          workspace: "personal-ws_personal",
          workspaceId: "ws_personal",
          running: true,
          serverUrl: "http://127.0.0.1:5000/_r/ws/personal-ws_personal",
          workspaceReach: reach("bb"),
          serverId,
          serverBootId,
        };
      }),
      close: vi.fn(async () => undefined),
    }));
    const fetchMock = vi.fn(async () =>
      Response.json({ deviceId: `dev_${"E".repeat(24)}`, refreshToken: "R".repeat(43) })
    );

    await expect(
      bootstrapInstanceCli(
        {
          gatewayUrl: "http://127.0.0.1:5000",
          serverId,
          serverBootId,
          workspaces: [],
          mode: "hub",
          rootInvite: invite,
          gatewayPort: 5000,
          pid: 1,
          version: "0.1.33",
          buildId: "a".repeat(64),
        },
        {
          credentialFile,
          workspace: "personal",
          fetch: fetchMock as unknown as typeof fetch,
          rpcClient,
        }
      )
    ).resolves.toEqual({
      status: "paired",
      workspaceName: "personal-ws_personal",
      workspaceId: "ws_personal",
    });
    expect(routed).toEqual([{ workspaceId: "ws_personal" }]);
    expect(loadCliCredentials(credentialFile)).toMatchObject({ workspaceId: "ws_personal" });
  });

  it("reuses the issued device credential when a cold workspace route times out once", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-cli-bootstrap-retry-"));
    roots.push(root);
    const credentialFile = path.join(root, "credentials.json");
    const serverId = `srv_${"S".repeat(24)}`;
    const serverBootId = `boot_${"B".repeat(24)}`;
    const pairing = {
      ...reach("aa"),
      code: "D".repeat(21) + "A",
    };
    const invite = {
      ...pairing,
      deepLink: createConnectDeepLink(pairing),
      pairUrl: createConnectPairUrl(pairing),
      expiresInMs: 2_000_000_000_000 - Date.now(),
      expiresAt: 2_000_000_000_000,
      serverId,
      serverBootId,
    };
    let routeAttempts = 0;
    const routedDeviceIds: string[] = [];
    const rpcClient = vi.fn((credential: { deviceId: string }) => ({
      call: vi.fn(async (method: string) => {
        if (method === "hubControl.pairDevice") return { pairing: invite };
        if (method === "hubControl.ensureUserWorkspaces") {
          return {
            personal: { workspaceId: "ws_personal" },
            system: { workspaceId: "ws_dev" },
          };
        }
        routedDeviceIds.push(credential.deviceId);
        routeAttempts += 1;
        if (routeAttempts === 1) throw new ConnectionError("workspace is still starting");
        return {
          workspace: "dev",
          workspaceId: "ws_dev",
          running: true,
          serverUrl: "http://127.0.0.1:5000/_r/ws/dev",
          workspaceReach: reach("bb"),
          serverId,
          serverBootId,
        };
      }),
      close: vi.fn(async () => undefined),
    }));
    const fetchMock = vi.fn(async () =>
      Response.json({
        deviceId: `dev_${"C".repeat(24)}`,
        refreshToken: "R".repeat(43),
        workspaceId: "ws_dev",
      })
    );

    await expect(
      bootstrapInstanceCliFromDevice(
        {
          gatewayUrl: "http://127.0.0.1:5000",
          serverId,
          workspaceId: "ws_dev",
          workspaceName: "dev",
          deviceId: `dev_${"A".repeat(24)}`,
          refreshToken: "Q".repeat(43),
        },
        { credentialFile, fetch: fetchMock as typeof fetch, rpcClient }
      )
    ).resolves.toEqual({ status: "paired", workspaceName: "dev", workspaceId: "ws_dev" });

    expect(routeAttempts).toBe(2);
    expect(routedDeviceIds).toEqual([`dev_${"C".repeat(24)}`, `dev_${"C".repeat(24)}`]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
