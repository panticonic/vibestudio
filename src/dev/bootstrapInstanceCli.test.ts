import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createConnectDeepLink, createConnectPairUrl } from "@vibestudio/shared/connect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadCliCredentials } from "../cli/credentialStore.js";
import { ConnectionError } from "../cli/output.js";
import { bootstrapInstanceCliFromDevice } from "./bootstrapInstanceCli.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("bootstrapInstanceCliFromDevice", () => {
  it("uses an authenticated device invite when the root invite has already been consumed", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-cli-bootstrap-"));
    roots.push(root);
    const credentialFile = path.join(root, "credentials.json");
    const serverId = `srv_${"S".repeat(24)}`;
    const serverBootId = `boot_${"B".repeat(24)}`;
    const pairing = {
      room: "development-cli",
      fp: "AA".repeat(32),
      sig: "wss://signal.example/",
      code: "D".repeat(32),
      v: 2 as const,
      ice: "all" as const,
    };
    const invite = {
      ...pairing,
      deepLink: createConnectDeepLink(pairing),
      pairUrl: createConnectPairUrl(pairing),
      expiresInMs: 60_000,
      expiresAt: Date.now() + 60_000,
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
        return {
          workspace: "dev",
          workspaceId: "ws_dev",
          running: true,
          serverUrl: "http://127.0.0.1:5000/_r/ws/dev",
          workspaceReach: {
            room: "workspace-dev",
            fp: "BB".repeat(32),
            sig: "wss://signal.example/",
            v: 2,
            ice: "all",
          },
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
          workspaceName: "dev",
          deviceId: `dev_${"A".repeat(24)}`,
          refreshToken: "Q".repeat(43),
        },
        { credentialFile, fetch: fetchMock as typeof fetch, rpcClient }
      )
    ).resolves.toEqual({ status: "paired", workspaceName: "dev" });

    expect(calls).toEqual([
      {
        deviceId: `dev_${"A".repeat(24)}`,
        method: "hubControl.pairDevice",
        args: [{ workspace: "dev" }],
      },
      {
        deviceId: `dev_${"C".repeat(24)}`,
        method: "hubControl.routeWorkspace",
        args: [{ workspaceId: "ws_dev" }],
      },
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(loadCliCredentials(credentialFile)).toMatchObject({
      serverId,
      workspaceId: "ws_dev",
      workspaceName: "dev",
      deviceId: `dev_${"C".repeat(24)}`,
      controlPairing: { room: "development-cli" },
      workspacePairing: { room: "workspace-dev" },
    });
  });

  it("reuses the issued device credential when a cold workspace route times out once", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-cli-bootstrap-retry-"));
    roots.push(root);
    const credentialFile = path.join(root, "credentials.json");
    const serverId = `srv_${"S".repeat(24)}`;
    const serverBootId = `boot_${"B".repeat(24)}`;
    const pairing = {
      room: "development-cli",
      fp: "AA".repeat(32),
      sig: "wss://signal.example/",
      code: "D".repeat(32),
      v: 2 as const,
      ice: "all" as const,
    };
    const invite = {
      ...pairing,
      deepLink: createConnectDeepLink(pairing),
      pairUrl: createConnectPairUrl(pairing),
      expiresInMs: 60_000,
      expiresAt: Date.now() + 60_000,
      serverId,
      serverBootId,
    };
    let routeAttempts = 0;
    const routedDeviceIds: string[] = [];
    const rpcClient = vi.fn((credential: { deviceId: string }) => ({
      call: vi.fn(async (method: string) => {
        if (method === "hubControl.pairDevice") return { pairing: invite };
        routedDeviceIds.push(credential.deviceId);
        routeAttempts += 1;
        if (routeAttempts === 1) throw new ConnectionError("workspace is still starting");
        return {
          workspace: "dev",
          workspaceId: "ws_dev",
          running: true,
          serverUrl: "http://127.0.0.1:5000/_r/ws/dev",
          workspaceReach: {
            room: "workspace-dev",
            fp: "BB".repeat(32),
            sig: "wss://signal.example/",
            v: 2,
            ice: "all",
          },
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
          workspaceName: "dev",
          deviceId: `dev_${"A".repeat(24)}`,
          refreshToken: "Q".repeat(43),
        },
        { credentialFile, fetch: fetchMock as typeof fetch, rpcClient }
      )
    ).resolves.toEqual({ status: "paired", workspaceName: "dev" });

    expect(routeAttempts).toBe(2);
    expect(routedDeviceIds).toEqual([`dev_${"C".repeat(24)}`, `dev_${"C".repeat(24)}`]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
