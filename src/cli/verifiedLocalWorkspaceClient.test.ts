import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliCredentials } from "./credentialStore.js";
import { saveSystemTestTarget, systemTestTargetPath } from "./systemTestStore.js";

const rpc = vi.hoisted(() => ({
  call: vi.fn(),
  close: vi.fn(async () => undefined),
  constructions: [] as Array<{ credentials: unknown; policy: unknown }>,
}));

vi.mock("@vibestudio/direct-client", () => ({
  RpcClient: class {
    constructor(credentials: unknown, policy: unknown) {
      rpc.constructions.push({ credentials, policy });
    }
    call = rpc.call;
    close = rpc.close;
  },
}));

const credentials = {
  schemaVersion: 3,
  kind: "device",
  url: "webrtc://workspace-room/_workspace/dev",
  workspaceName: "dev",
  serverId: "srv_local",
  deviceId: "dev_local",
  refreshToken: "refresh_local",
} as CliCredentials;

function saveTarget(overrides: Record<string, unknown> = {}): void {
  saveSystemTestTarget({
    schemaVersion: 1,
    pairedUrl: credentials.url,
    workspaceName: credentials.workspaceName,
    serverUrl: "http://127.0.0.1:3030",
    serverId: credentials.serverId,
    serverBootId: "boot_local",
    workspaceId: "ws_local",
    verifiedAt: 1,
    ...overrides,
  });
}

describe("verified local workspace CLI route", () => {
  let root = "";

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-local-cli-route-"));
    vi.stubEnv("XDG_CONFIG_HOME", path.join(root, ".config"));
    vi.stubEnv("XDG_STATE_HOME", path.join(root, ".state"));
    rpc.call.mockReset();
    rpc.close.mockClear();
    rpc.constructions = [];
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("revalidates and pins a matching doctor route for concurrent CLI processes", async () => {
    saveTarget();
    rpc.call.mockResolvedValue({
      serverId: "srv_local",
      serverBootId: "boot_local",
      workspaceId: "ws_local",
    });
    const { resolveVerifiedLocalWorkspaceClient } =
      await import("./verifiedLocalWorkspaceClient.js");

    const resolution = await resolveVerifiedLocalWorkspaceClient(credentials);

    expect(resolution.local?.target.serverUrl).toBe("http://127.0.0.1:3030");
    expect(rpc.call).toHaveBeenCalledWith("auth.getConnectionInfo", []);
    expect(rpc.constructions).toEqual([
      {
        credentials: {
          url: "http://127.0.0.1:3030",
          deviceId: "dev_local",
          refreshToken: "refresh_local",
        },
        policy: {
          expectedHost: { serverId: "srv_local", workspaceId: "ws_local" },
          clientLabel: "Vibestudio local CLI side-channel",
        },
      },
    ]);
  });

  it("retires a stale incarnation route and reports why WebRTC fallback is needed", async () => {
    saveTarget();
    rpc.call.mockResolvedValue({
      serverId: "srv_local",
      serverBootId: "boot_restarted",
      workspaceId: "ws_local",
    });
    const { resolveVerifiedLocalWorkspaceClient } =
      await import("./verifiedLocalWorkspaceClient.js");

    const resolution = await resolveVerifiedLocalWorkspaceClient(credentials);

    expect(resolution.local).toBeNull();
    expect(resolution.unavailableReason).toContain("no longer matches");
    expect(rpc.close).toHaveBeenCalledOnce();
    expect(fs.existsSync(systemTestTargetPath())).toBe(false);
  });

  it("ignores a cached route belonging to another paired workspace", async () => {
    saveTarget({ workspaceName: "other" });
    const { resolveVerifiedLocalWorkspaceClient } =
      await import("./verifiedLocalWorkspaceClient.js");

    const resolution = await resolveVerifiedLocalWorkspaceClient(credentials);

    expect(resolution).toEqual({ local: null });
    expect(rpc.constructions).toEqual([]);
  });
});
