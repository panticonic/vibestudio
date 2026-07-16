import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVerifiedCaller, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import type { DeviceCredentialEntry, StoredRemote } from "./deviceCredentialStore.js";

const mocks = vi.hoisted(() => ({
  app: {
    relaunch: vi.fn(),
    exit: vi.fn(),
    getPath: vi.fn(() => "/tmp/vibestudio-remote-cred-test"),
  },
  safeStorage: {
    encryptString: vi.fn((value: string) => Buffer.from(value, "utf8")),
    decryptString: vi.fn((value: Buffer) => value.toString("utf8")),
    isEncryptionAvailable: vi.fn(() => true),
  },
  store: {
    value: null as StoredRemote | null,
    saveError: null as Error | null,
    clearError: null as Error | null,
  },
}));

vi.mock("electron", () => ({ app: mocks.app, safeStorage: mocks.safeStorage }));
vi.mock("./deviceCredentialStore.js", () => ({
  loadStoredRemotePairing: () => mocks.store.value,
  loadDeviceCredentialByWorkspaceId: () => null,
  saveDeviceCredential: (value: DeviceCredentialEntry) => {
    if (mocks.store.saveError) throw mocks.store.saveError;
    if (value.transport === "webrtc") mocks.store.value = value as StoredRemote;
  },
  clearStoredRemotePairing: () => {
    if (mocks.store.clearError) throw mocks.store.clearError;
    mocks.store.value = null;
  },
}));

const shellCtx: ServiceContext = { caller: createVerifiedCaller("shell", "shell") };
const SELF_DEVICE_ID = `dev_${"d".repeat(24)}`;
const NEXT_DEVICE_ID = `dev_${"n".repeat(24)}`;
const NEXT_REFRESH_TOKEN = "n".repeat(43);
const sampleStored: StoredRemote = {
  serverId: `srv_${"s".repeat(24)}`,
  transport: "webrtc",
  controlPairing: {
    room: "room-control",
    fp: "AA".repeat(32),
    sig: "wss://sig.example/",
    v: 2,
    ice: "all",
  },
  workspacePairing: {
    room: "room-abc",
    fp: "AA".repeat(32),
    sig: "wss://sig.example/",
    v: 2,
    ice: "all",
  },
  deviceId: SELF_DEVICE_ID,
  refreshToken: "r".repeat(43),
  workspaceName: "main",
  pairedAt: 123,
};

function serverClient(call = vi.fn()) {
  return { isConnected: () => true, call } as never;
}

describe("remoteCredService", () => {
  beforeEach(() => {
    mocks.app.relaunch.mockClear();
    mocks.app.exit.mockClear();
    mocks.store.value = null;
    mocks.store.saveError = null;
    mocks.store.clearError = null;
  });

  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("contains only desktop-local credential and connection operations", async () => {
    const { createRemoteCredService } = await import("./remoteCredService.js");
    const methods = createRemoteCredService({}).methods;
    expect(methods).not.toHaveProperty("pairDevice");
    expect(methods).not.toHaveProperty("listDevices");
    expect(methods).not.toHaveProperty("revokeDevice");
  });

  it("reports live connectivity independently from a stored remote pairing", async () => {
    const { createRemoteCredService } = await import("./remoteCredService.js");
    await expect(
      createRemoteCredService({ getServerClient: () => serverClient() }).handler(
        shellCtx,
        "getCurrent",
        []
      )
    ).resolves.toMatchObject({ connected: true, configured: false, isActive: false });
  });

  it("reports a stored pairing as active only while its server session is live", async () => {
    mocks.store.value = sampleStored;
    const { createRemoteCredService } = await import("./remoteCredService.js");
    const active = createRemoteCredService({
      getServerClient: () => serverClient(),
      getConnectionMode: () => "remote",
    });
    await expect(active.handler(shellCtx, "getCurrent", [])).resolves.toMatchObject({
      connected: true,
      configured: true,
      isActive: true,
      deviceId: SELF_DEVICE_ID,
      workspaceName: "main",
    });

    const inactive = createRemoteCredService({});
    await expect(inactive.handler(shellCtx, "getCurrent", [])).resolves.toMatchObject({
      connected: false,
      configured: true,
      isActive: false,
    });
  });

  it("persists fresh and rotated WebRTC device credentials", async () => {
    const { persistRotatedRemoteCredential, saveStoredRemote } =
      await import("./remoteCredService.js");
    saveStoredRemote(sampleStored);
    expect(mocks.store.value).toEqual(sampleStored);
    persistRotatedRemoteCredential({
      deviceId: NEXT_DEVICE_ID,
      refreshToken: NEXT_REFRESH_TOKEN,
    });
    expect(mocks.store.value).toMatchObject({
      deviceId: NEXT_DEVICE_ID,
      refreshToken: NEXT_REFRESH_TOKEN,
    });
  });

  it("persists the exact workspace reach while retaining the stable control pairing", async () => {
    mocks.store.value = sampleStored;
    const { persistStoredRemoteWorkspaceRoute } = await import("./remoteCredService.js");
    const persisted = persistStoredRemoteWorkspaceRoute({
      workspace: "second",
      workspaceId: "ws_second",
      running: true,
      serverUrl: "https://hub.example.test/w/second",
      workspaceReach: {
        room: `room_${"w".repeat(24)}`,
        fp: "CC".repeat(32),
        sig: "wss://sig.example/",
        v: 2,
        ice: "all",
      },
      serverId: sampleStored.serverId,
      serverBootId: `boot_${"b".repeat(24)}`,
    });

    expect(persisted).toBe(true);
    expect(mocks.store.value).toMatchObject({
      workspaceName: "second",
      controlPairing: sampleStored.controlPairing,
      workspacePairing: { room: `room_${"w".repeat(24)}`, fp: "CC".repeat(32), ice: "all" },
    });
  });

  it("refuses to persist a workspace route for another server", async () => {
    mocks.store.value = sampleStored;
    const { persistStoredRemoteWorkspaceRoute } = await import("./remoteCredService.js");

    expect(() =>
      persistStoredRemoteWorkspaceRoute({
        workspace: "second",
        workspaceId: "ws_second",
        running: true,
        serverUrl: "https://hub.example.test/w/second",
        workspaceReach: {
          room: `room_${"w".repeat(24)}`,
          fp: "CC".repeat(32),
          sig: "wss://sig.example/",
          v: 2,
          ice: "all",
        },
        serverId: `srv_${"x".repeat(24)}`,
        serverBootId: `boot_${"b".repeat(24)}`,
      })
    ).toThrow(/server identity/);
    expect(mocks.store.value).toEqual(sampleStored);
  });

  it("keeps the live session usable on save failures but surfaces explicit clear failures", async () => {
    const { clearStoredRemotePairing, persistRotatedRemoteCredential, saveStoredRemote } =
      await import("./remoteCredService.js");
    mocks.store.saveError = new Error("disk full");
    expect(() => saveStoredRemote(sampleStored)).not.toThrow();

    mocks.store.saveError = null;
    mocks.store.value = sampleStored;
    mocks.store.saveError = new Error("keychain unavailable");
    expect(() =>
      persistRotatedRemoteCredential({
        deviceId: NEXT_DEVICE_ID,
        refreshToken: NEXT_REFRESH_TOKEN,
      })
    ).not.toThrow();

    mocks.store.clearError = new Error("permission denied");
    expect(() => clearStoredRemotePairing()).toThrow(/permission denied/);
    expect(mocks.store.value).toEqual(sampleStored);
  });

  it("can disable credential persistence for isolated transport harnesses", async () => {
    vi.stubEnv("VIBESTUDIO_DISABLE_REMOTE_CRED_PERSISTENCE", "1");
    const { saveStoredRemote } = await import("./remoteCredService.js");
    saveStoredRemote(sampleStored);
    expect(mocks.store.value).toBeNull();
  });

  it("validates a pairing link before relaunching into it", async () => {
    const { createRemoteCredService } = await import("./remoteCredService.js");
    const service = createRemoteCredService({});
    await expect(service.handler(shellCtx, "pair", [{ link: "not-a-link" }])).resolves.toEqual({
      ok: false,
      error: "invalid-link",
      message: expect.any(String),
    });
    expect(mocks.app.relaunch).not.toHaveBeenCalled();

    const link =
      `vibestudio://connect?room=room-abc&fp=${"AA".repeat(32)}` +
      `&code=${"B".repeat(32)}&sig=wss%3A%2F%2Fsig.example%2F&v=2&ice=all`;
    await expect(service.handler(shellCtx, "pair", [{ link }])).resolves.toEqual({ ok: true });
    expect(mocks.app.relaunch).toHaveBeenCalledWith({
      args: expect.arrayContaining([expect.stringMatching(/^vibestudio:\/\/connect\?/)]),
    });
    expect(mocks.app.exit).toHaveBeenCalledWith(0);
  });

  it("clears the persisted pairing explicitly", async () => {
    mocks.store.value = sampleStored;
    const { createRemoteCredService, loadStoredRemotePairing } =
      await import("./remoteCredService.js");
    const service = createRemoteCredService({});
    await expect(service.handler(shellCtx, "clear", [])).resolves.toEqual({ ok: true });
    expect(loadStoredRemotePairing()).toBeNull();
  });
});
