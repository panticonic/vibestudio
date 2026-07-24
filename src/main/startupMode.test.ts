/**
 * startupMode — local-vs-pending resolution + relaunch-arg builders.
 *
 * Remote startup (env URL / stored-remote credentials / TLS pins) was removed in
 * §8c — remote topology is now WebRTC, paired live via the remoteCred flow, not a
 * startup mode. So startup only resolves `local` vs `pending`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DEV_WEBRTC_REMOTE_ARG } from "./startupInvocation.js";

// Mocks must be set up before the startupMode module is imported, so we
// resetModules + re-import in each test.

const mockResolveWorkspaceName = vi.fn(() => null as string | null);
const mockIsDev = vi.fn(() => false);
const mockResolveLocalWorkspaceStartup = vi.fn((_opts?: unknown) => ({
  resolved: {
    wsDir: "/tmp/vibestudio-test-workspace",
    workspace: { config: { id: "test-workspace" } },
    name: "test-workspace",
    created: false,
  },
  isEphemeral: false,
}));

vi.mock("@vibestudio/workspace/loader", () => ({
  resolveWorkspaceName: () => mockResolveWorkspaceName(),
  resolveOrCreateWorkspace: () => {
    throw new Error("not used in these tests");
  },
}));

vi.mock("@vibestudio/workspace/startup", () => ({
  resolveLocalWorkspaceStartup: (opts: unknown) => mockResolveLocalWorkspaceStartup(opts),
}));

vi.mock("./paths.js", () => ({
  getAppRoot: () => "/tmp",
  getCentralConfigDirectory: () => "/tmp",
}));

vi.mock("./utils.js", () => ({ isDev: () => mockIsDev() }));

const ORIGINAL_ARGV = process.argv.slice();

function setArgv(args: string[]) {
  process.argv = [...ORIGINAL_ARGV.slice(0, 2), ...args];
}

function testCentralData() {
  return {} as never;
}

describe("resolveStartupMode interactive desktop policy", () => {
  let mod: typeof import("./startupMode.js");

  beforeEach(async () => {
    setArgv([]);
    mockResolveWorkspaceName.mockReset();
    mockResolveWorkspaceName.mockReturnValue(null);
    mockResolveLocalWorkspaceStartup.mockClear();
    mockIsDev.mockReset();
    mockIsDev.mockReturnValue(false);
    vi.resetModules();
    mod = await import("./startupMode.js");
  });

  afterEach(() => {
    setArgv([]);
  });

  it("launches the local default/last workspace by default", () => {
    expect(mod.resolveStartupMode(testCentralData(), { interactiveDesktop: true })).toMatchObject({
      kind: "local",
      connectionIntent: "resume-saved-remote",
      workspaceName: "test-workspace",
    });
  });

  it("launches the local workspace non-interactively (headless) when none is explicitly selected", () => {
    expect(mod.resolveStartupMode(testCentralData(), { interactiveDesktop: false })).toMatchObject({
      kind: "local",
      connectionIntent: "local",
      wsDir: "/tmp/vibestudio-test-workspace",
      workspaceId: "test-workspace",
    });
  });

  it("selects the canonical hub-owned ephemeral workspace in development", () => {
    mockIsDev.mockReturnValue(true);

    expect(mod.resolveStartupMode(testCentralData(), { interactiveDesktop: true })).toEqual({
      kind: "local",
      connectionIntent: "local",
      wsDir: "/tmp/workspaces/dev",
      workspaceName: "dev",
      workspaceId: "dev",
      isEphemeral: true,
      ephemeralLifecycle: "replace",
    });
    expect(mockResolveLocalWorkspaceStartup).not.toHaveBeenCalled();
  });

  it("opens the chooser only when explicitly requested via --choose-connection", () => {
    mockIsDev.mockReturnValue(true);
    setArgv([mod.CHOOSE_CONNECTION_ARG]);

    expect(mod.resolveStartupMode(testCentralData(), { interactiveDesktop: true })).toEqual({
      kind: "pending",
    });
    expect(mockResolveLocalWorkspaceStartup).not.toHaveBeenCalled();
  });

  it("opens the chooser when launched with a WebRTC pairing deep link", () => {
    mockIsDev.mockReturnValue(true);
    mockResolveWorkspaceName.mockReturnValue("default");
    setArgv([
      "--workspace",
      "default",
      "vibestudio://connect?room=room&fp=fp&code=code&sig=ws://127.0.0.1",
    ]);

    expect(mod.resolveStartupMode(testCentralData(), { interactiveDesktop: true })).toEqual({
      kind: "pending",
    });
    expect(mockResolveLocalWorkspaceStartup).not.toHaveBeenCalled();
  });

  it("does not treat WebRTC pairing deep links as a headless startup mode", () => {
    setArgv(["vibestudio://connect?room=room&fp=fp&code=code&sig=ws://127.0.0.1"]);

    expect(mod.resolveStartupMode(testCentralData(), { interactiveDesktop: false })).toMatchObject({
      kind: "local",
      wsDir: "/tmp/vibestudio-test-workspace",
    });
  });

  it("builds workspace switches without implicitly creating a missing workspace", () => {
    expect(mod.workspaceRelaunchArgs("default", ["--foo", "--workspace", "old"])).toEqual([
      "--foo",
      "--workspace",
      "default",
    ]);
  });

  it("builds chooser relaunch args that strip stale startup selections", () => {
    expect(
      mod.chooseConnectionRelaunchArgs([
        "--foo",
        "--workspace",
        "old",
        mod.WORKSPACE_CREATE_IF_MISSING_ARG,
        mod.EPHEMERAL_WORKSPACE_ARG,
        mod.CHOOSE_CONNECTION_ARG,
      ])
    ).toEqual(["--foo", mod.CHOOSE_CONNECTION_ARG]);
  });

  it("strips one-shot WebRTC dev pairing args from relaunch selectors", () => {
    expect(
      mod.workspaceRelaunchArgs("default", [
        "--foo",
        DEV_WEBRTC_REMOTE_ARG,
        "vibestudio://connect?room=room-1111&fp=bad&code=bad&sig=ws%3A%2F%2F127.0.0.1%3A8787",
        "vibestudio://panel?v=1&source=about%2Fserver-logs",
      ])
    ).toEqual(["--foo", "--workspace", "default"]);
  });

  it("builds relaunch args for the canonical hub-owned ephemeral workspace", () => {
    expect(
      mod.ephemeralWorkspaceRelaunchArgs([
        "--foo",
        "--workspace",
        "old",
        mod.EPHEMERAL_WORKSPACE_ARG,
      ])
    ).toEqual(["--foo", "--workspace", "dev", mod.EPHEMERAL_WORKSPACE_ARG]);
  });

  it("routes an --ephemeral-workspace relaunch through the hub-owned lifecycle", () => {
    mockResolveWorkspaceName.mockReturnValue("dev");
    setArgv(["--workspace", "dev", mod.EPHEMERAL_WORKSPACE_ARG]);

    expect(mod.resolveStartupMode(testCentralData(), { interactiveDesktop: true })).toEqual({
      kind: "local",
      connectionIntent: "local",
      wsDir: "/tmp/workspaces/dev",
      workspaceName: "dev",
      workspaceId: "dev",
      isEphemeral: true,
      ephemeralLifecycle: "resume",
    });
    expect(mockResolveLocalWorkspaceStartup).not.toHaveBeenCalled();
  });

  it("rejects non-canonical names tagged as ephemeral", () => {
    mockResolveWorkspaceName.mockReturnValue("dev-abc123");
    setArgv(["--workspace", "dev-abc123", mod.EPHEMERAL_WORKSPACE_ARG]);

    expect(() => mod.resolveStartupMode(testCentralData(), { interactiveDesktop: true })).toThrow(
      /canonical workspace "dev"/
    );
  });

  it("passes create-if-missing only for explicitly selected local workspace launches", () => {
    mockResolveWorkspaceName.mockReturnValue("default");
    setArgv(["--workspace", "default", mod.WORKSPACE_CREATE_IF_MISSING_ARG]);

    expect(mod.resolveStartupMode(testCentralData(), { interactiveDesktop: true })).toMatchObject({
      kind: "local",
      wsDir: "/tmp/vibestudio-test-workspace",
      workspaceId: "test-workspace",
    });
    expect(mockResolveLocalWorkspaceStartup).toHaveBeenLastCalledWith(
      expect.objectContaining({
        name: "default",
        init: true,
      })
    );

    mockResolveLocalWorkspaceStartup.mockClear();
    setArgv(["--workspace", "default"]);
    expect(mod.resolveStartupMode(testCentralData(), { interactiveDesktop: true })).toMatchObject({
      kind: "local",
    });
    expect(mockResolveLocalWorkspaceStartup).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ init: true })
    );
  });
});

describe("shouldRequestSingleInstanceLock", () => {
  it("does not lock local development launches", async () => {
    const mod = await import("./startupMode.js");

    expect(
      mod.shouldRequestSingleInstanceLock(
        {
          kind: "local",
          connectionIntent: "local",
          wsDir: "/workspace",
          workspaceName: "dev",
          workspaceId: "dev",
          isEphemeral: true,
          ephemeralLifecycle: "replace",
        },
        { isHeadlessHost: false, isDevelopment: true }
      )
    ).toBe(false);
  });

  it("keeps the lock for packaged local launches", async () => {
    const mod = await import("./startupMode.js");

    expect(
      mod.shouldRequestSingleInstanceLock(
        {
          kind: "local",
          connectionIntent: "resume-saved-remote",
          wsDir: "/workspace",
          workspaceName: "default",
          workspaceId: "default",
          isEphemeral: false,
          ephemeralLifecycle: null,
        },
        { isHeadlessHost: false, isDevelopment: false }
      )
    ).toBe(true);
  });

  it("keeps the lock for pending chooser launches so deep links route to the active shell", async () => {
    const mod = await import("./startupMode.js");

    expect(
      mod.shouldRequestSingleInstanceLock(
        { kind: "pending" },
        { isHeadlessHost: false, isDevelopment: true }
      )
    ).toBe(true);
  });

  it("does not lock headless hosts", async () => {
    const mod = await import("./startupMode.js");

    expect(
      mod.shouldRequestSingleInstanceLock(
        { kind: "pending" },
        { isHeadlessHost: true, isDevelopment: false }
      )
    ).toBe(false);
  });
});
