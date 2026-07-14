import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSpectroliteApp } from "./createApp";

const runtimeMocks = vi.hoisted(() => {
  const stateArgs = { current: {} as Record<string, unknown> };
  return {
    stateArgs,
    getStateArgs: vi.fn(() => stateArgs.current),
    setStateArgs: vi.fn(async (updates: Record<string, unknown>) => {
      stateArgs.current = { ...stateArgs.current, ...updates };
    }),
    listFiles: vi.fn(),
    readFile: vi.fn(),
    edit: vi.fn(),
    pushStatus: vi.fn(),
    pendingMerge: vi.fn(),
    contextStatus: vi.fn(),
    subscribeHead: vi.fn(),
    subscribeWorking: vi.fn(),
    reopen: vi.fn(),
  };
});

const sessionMocks = vi.hoisted(() => ({
  start: vi.fn(async () => undefined),
  dispose: vi.fn(),
  onVaultSelected: vi.fn(),
}));

vi.mock("@workspace/runtime", () => ({
  contextId: "vault-17f36vgxu4emp",
  rpc: {},
  panel: {
    slotId: "panel:spectrolite",
    reopen: runtimeMocks.reopen,
    stateArgs: {
      get: runtimeMocks.getStateArgs,
      set: runtimeMocks.setStateArgs,
    },
  },
  vcs: {
    listFiles: runtimeMocks.listFiles,
    readFile: runtimeMocks.readFile,
    edit: runtimeMocks.edit,
    pushStatus: runtimeMocks.pushStatus,
    pendingMerge: runtimeMocks.pendingMerge,
    contextStatus: runtimeMocks.contextStatus,
    subscribeHead: runtimeMocks.subscribeHead,
    subscribeWorking: runtimeMocks.subscribeWorking,
  },
}));

vi.mock("./sessionController", () => ({
  SessionController: vi.fn(() => sessionMocks),
}));

describe("createSpectroliteApp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeMocks.stateArgs.current = {
      repoRoot: "/projects/fresh/",
      pendingStarterDoc: { path: "Welcome.mdx", content: "# Welcome\n" },
    };
    runtimeMocks.listFiles.mockResolvedValue([]);
    runtimeMocks.readFile.mockResolvedValue(null);
    runtimeMocks.edit.mockResolvedValue({
      head: "ctx:vault-fresh",
      stateHash: "state:1",
      committed: false,
      status: "uncommitted",
      editSeq: 1,
      changedPaths: ["projects/fresh/Welcome.mdx"],
    });
    runtimeMocks.pushStatus.mockResolvedValue([
      {
        repoPath: "projects/fresh",
        ahead: 0,
        uncommitted: 1,
        diverged: false,
        deleted: false,
        files: [],
      },
    ]);
    runtimeMocks.pendingMerge.mockResolvedValue(null);
    runtimeMocks.contextStatus.mockResolvedValue([]);
    runtimeMocks.subscribeHead.mockReturnValue(() => undefined);
    runtimeMocks.subscribeWorking.mockReturnValue(() => undefined);
    runtimeMocks.reopen.mockResolvedValue({ id: "panel:spectrolite", title: "Spectrolite" });
  });

  it("creates a pending starter doc after the panel is bound to the vault context", async () => {
    const app = createSpectroliteApp();

    app.start();

    await vi.waitFor(() => {
      expect(runtimeMocks.edit).toHaveBeenCalledWith({
        edits: [
          {
            kind: "create",
            path: "projects/fresh/Welcome.mdx",
            content: { kind: "text", text: "# Welcome\n" },
          },
        ],
      });
    });
    expect(app.store.getState().activePath).toBe("Welcome.mdx");
    expect(runtimeMocks.setStateArgs).toHaveBeenCalledWith({
      openPath: "Welcome.mdx",
      pendingStarterDoc: null,
    });
  });

  it("refreshes publish state when durable working edits advance", async () => {
    const workingAdvances: Array<() => void> = [];
    runtimeMocks.subscribeWorking.mockImplementation((_head: string, cb: () => void) => {
      workingAdvances.push(cb);
      return () => undefined;
    });
    const app = createSpectroliteApp();

    app.start();
    await vi.waitFor(() => {
      expect(runtimeMocks.pushStatus).toHaveBeenCalledTimes(1);
    });

    runtimeMocks.pushStatus.mockClear();
    const onWorkingAdvance = workingAdvances[0];
    if (!onWorkingAdvance) throw new Error("subscribeWorking did not capture a callback");
    onWorkingAdvance();

    await vi.waitFor(() => {
      expect(runtimeMocks.pushStatus).toHaveBeenCalledWith(["projects/fresh"]);
    });
  });

  it("rebinds before starting sessions or touching VCS when mounted on a transient context", async () => {
    runtimeMocks.stateArgs.current = {
      channelName: "kb-existing",
      installedAgents: [
        {
          agentId: "SilentAgentWorker",
          handle: "scribe",
          key: "scribe-1",
          source: "workers/silent-agent-worker",
          className: "SilentAgentWorker",
        },
      ],
      openPath: "E2E.mdx",
      pendingStarterDoc: { path: "Welcome.mdx", content: "# Welcome\n" },
      repoRoot: "/projects/default/",
    };
    const app = createSpectroliteApp();

    app.start();

    expect(app.store.getState().vaultPendingPath).toBe("projects/default");
    expect(runtimeMocks.reopen).toHaveBeenCalledWith({
      contextId: "vault-105vpdx90wm7j",
      stateArgs: {
        channelName: "kb-existing",
        installedAgents: runtimeMocks.stateArgs.current["installedAgents"],
        openPath: "E2E.mdx",
        pendingStarterDoc: { path: "Welcome.mdx", content: "# Welcome\n" },
        repoRoot: "projects/default",
      },
    });
    expect(sessionMocks.start).not.toHaveBeenCalled();
    expect(runtimeMocks.edit).not.toHaveBeenCalled();
    expect(runtimeMocks.listFiles).not.toHaveBeenCalled();
    expect(runtimeMocks.subscribeHead).not.toHaveBeenCalled();
    expect(runtimeMocks.subscribeWorking).not.toHaveBeenCalled();
  });

  it("keeps a failed initial context move gated and lets the user retry", async () => {
    runtimeMocks.stateArgs.current = {
      repoRoot: "projects/default",
      openPath: "E2E.mdx",
    };
    runtimeMocks.reopen
      .mockRejectedValueOnce(new Error("context service unavailable"))
      .mockResolvedValueOnce({ id: "panel:spectrolite", title: "Spectrolite" });
    const app = createSpectroliteApp();

    app.start();
    await vi.waitFor(() => {
      expect(app.store.getState().vaultError).toBe(
        "Couldn't open this vault: context service unavailable"
      );
    });
    expect(app.store.getState().vaultPendingPath).toBe("projects/default");
    expect(sessionMocks.start).not.toHaveBeenCalled();

    app.retryVaultBinding();
    await vi.waitFor(() => expect(runtimeMocks.reopen).toHaveBeenCalledTimes(2));
    expect(app.store.getState().vaultError).toBeNull();
    expect(sessionMocks.start).not.toHaveBeenCalled();
  });
});
