import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { describe, expect, it, vi } from "vitest";
import { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import type { EntityKind } from "@vibestudio/shared/runtime/entitySpec";
import { createVcsService } from "./vcsService.js";

function panelCaller(id = "panel-source") {
  return createVerifiedCaller(id, "panel", {
    callerId: id,
    callerKind: "panel",
    repoPath: "panels/source",
    effectiveVersion: "version-1",
  });
}

function agentCaller(entityId: string, contextId: string) {
  return createVerifiedCaller(`agent:${entityId}`, "agent", null, {
    entityId,
    contextId,
    channelId: "chan-1",
    agentId: `agent:${entityId}`,
    userId: "usr_test",
  });
}

function entityCacheWithContext(
  callerId: string,
  contextId: string,
  kind: EntityKind = "panel"
): EntityCache {
  const entityCache = new EntityCache();
  entityCache._onActivate({
    id: callerId,
    kind,
    source: { repoPath: "panels/source", effectiveVersion: "version-1" },
    contextId,
    key: callerId,
    createdAt: Date.now(),
    status: "active",
    cleanupComplete: true,
  });
  return entityCache;
}

describe("vcsService", () => {
  describe("status / write authorization", () => {
    it("rejects explicit foreign heads for context-bound callers", async () => {
      // The head-write gate is shared by every write method; exercise it
      // through `merge`. merge({ source, head? }) pulls the source INTO the
      // named ctx head, so `head` is the head being written — a foreign one is
      // rejected before the source is even resolved.
      const mergeHeads = vi.fn();
      const service = createVcsService({
        workspaceVcs: { mergeHeads } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      await expect(
        service.handler({ caller: panelCaller() }, "merge", [{ source: "main", head: "ctx:ctx-2" }])
      ).rejects.toThrow("Callers may only write their own context head (ctx:ctx-1)");
      expect(mergeHeads).not.toHaveBeenCalled();
    });

    it("allows shell callers to read an explicit head's status", async () => {
      const statusHead = vi.fn(async () => ({
        stateHash: "state:abc",
        dirty: true,
        added: ["panels/source/index.ts"],
        removed: [],
        changed: [],
      }));
      const service = createVcsService({
        workspaceVcs: { statusHead } as never,
      });
      const shell = createVerifiedCaller("shell:dev_cli", "shell");

      // Per-repo status(repoArg, headArg?): read an explicit head on a repo.
      const result = await service.handler({ caller: shell }, "status", [
        "panels/source",
        "ctx:ctx-1",
      ]);

      expect(statusHead).toHaveBeenCalledWith("ctx:ctx-1", "panels/source");
      expect(result).toMatchObject({ stateHash: "state:abc", dirty: true });
    });

    it("scopes status to a repo when a repoPath is given", async () => {
      const statusHead = vi.fn(async () => ({
        stateHash: "state:abc",
        dirty: false,
        added: [],
        removed: [],
        changed: [],
      }));
      const service = createVcsService({
        workspaceVcs: { statusHead } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      // repoArg only → defaults the head to the caller's own context head.
      await service.handler({ caller: panelCaller() }, "status", ["panels/source"]);

      expect(statusHead).toHaveBeenCalledWith("ctx:ctx-1", "panels/source");
    });

    it("agent status defaults to the host-verified bound context", async () => {
      const statusHead = vi.fn(async () => ({
        stateHash: "state:agent",
        dirty: false,
        added: [],
        removed: [],
        changed: [],
      }));
      const service = createVcsService({
        workspaceVcs: { statusHead } as never,
        entityCache: new EntityCache(),
      });

      await service.handler({ caller: agentCaller("ent-agent", "ctx-agent") }, "status", [
        "panels/source",
      ]);

      expect(statusHead).toHaveBeenCalledWith("ctx:ctx-agent", "panels/source");
    });

    it("agent status fails closed when the verified binding is missing", async () => {
      const statusHead = vi.fn();
      const service = createVcsService({
        workspaceVcs: { statusHead } as never,
        entityCache: new EntityCache(),
      });

      await expect(
        service.handler({ caller: createVerifiedCaller("agent:ent-agent", "agent") }, "status", [
          "panels/source",
        ])
      ).rejects.toThrow(/agent caller has no entity binding/);
      expect(statusHead).not.toHaveBeenCalled();
    });

    it("resolveHead defaults to the caller's context head when the arg is omitted", async () => {
      const resolveHead = vi.fn(async () => "state:ctxhead");
      const service = createVcsService({
        workspaceVcs: { resolveHead } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      const result = await service.handler({ caller: panelCaller() }, "resolveHead", [
        undefined,
        "panels/source",
      ]);

      expect(resolveHead).toHaveBeenCalledWith("ctx:ctx-1", "panels/source");
      expect(result).toEqual({ head: "ctx:ctx-1", stateHash: "state:ctxhead" });
    });

    it("resolveHead still resolves an explicit ref", async () => {
      const resolveHead = vi.fn(async () => "state:mainhead");
      const service = createVcsService({
        workspaceVcs: { resolveHead } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      const result = await service.handler({ caller: panelCaller() }, "resolveHead", [
        "main",
        "panels/source",
      ]);

      expect(resolveHead).toHaveBeenCalledWith("main", "panels/source");
      expect(result).toEqual({ head: "main", stateHash: "state:mainhead" });
    });

    it("allows resolveHead for a foreign context the caller owns/forked", async () => {
      const resolveHead = vi.fn(async () => "state:foreign");
      const service = createVcsService({
        workspaceVcs: { resolveHead } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
        listOwnedContexts: async () => ({ contexts: [{ contextId: "ctx-2" }] }),
      });

      const result = await service.handler({ caller: panelCaller() }, "resolveHead", [
        "ctx:ctx-2",
        "panels/source",
      ]);

      expect(resolveHead).toHaveBeenCalledWith("ctx:ctx-2", "panels/source");
      expect(result).toEqual({ head: "ctx:ctx-2", stateHash: "state:foreign" });
    });

    it("denies resolveHead for an unowned foreign context", async () => {
      const resolveHead = vi.fn();
      const service = createVcsService({
        workspaceVcs: { resolveHead } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
        listOwnedContexts: async () => ({ contexts: [] }),
      });

      await expect(
        service.handler({ caller: panelCaller() }, "resolveHead", ["ctx:ctx-2", "panels/source"])
      ).rejects.toThrow("is not owned or forked");
      expect(resolveHead).not.toHaveBeenCalled();
    });

    it("allows context callers to inspect a foreign head they own/forked", async () => {
      // WS-2 tightened cross-context reads to DENY-not-prompt: a context caller
      // may inspect a FOREIGN ctx head ONLY when the runtime ownership/lineage
      // registry authorizes it (a child it owns or a fork off it). Here ctx-1
      // owns/forked ctx-2, so the explicit-head read is allowed.
      const statusHead = vi.fn(async () => ({
        stateHash: "state:foreign",
        dirty: false,
        added: [],
        removed: [],
        changed: [],
      }));
      const service = createVcsService({
        workspaceVcs: { statusHead } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
        listOwnedContexts: async () => ({ contexts: [{ contextId: "ctx-2" }] }),
      });

      const result = await service.handler({ caller: panelCaller() }, "status", [
        "panels/source",
        "ctx:ctx-2",
      ]);

      expect(statusHead).toHaveBeenCalledWith("ctx:ctx-2", "panels/source");
      expect(result).toMatchObject({ stateHash: "state:foreign", dirty: false });
    });

    it("denies context callers inspecting an unowned foreign head", async () => {
      // The dual of the test above: without an ownership/lineage grant, a
      // foreign ctx head read is DENIED (thrown, never prompted). This is the
      // intended tighter WS-2 rule — the old permissive "any explicit head is
      // inspectable" allowance is gone.
      const statusHead = vi.fn();
      const service = createVcsService({
        workspaceVcs: { statusHead } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
        listOwnedContexts: async () => ({ contexts: [] }),
      });

      await expect(
        service.handler({ caller: panelCaller() }, "status", ["panels/source", "ctx:ctx-2"])
      ).rejects.toThrow("is not owned or forked");
      expect(statusHead).not.toHaveBeenCalled();
    });

    it("allows an entity to inspect a child context through its recorded owner edge", async () => {
      const contextStatus = vi.fn(async () => []);
      const listOwnedContexts = vi.fn(async ({ contextId }: { contextId: string }) => ({
        contexts:
          contextId === "ctx-parent"
            ? [
                {
                  contextId: "ctx-child",
                  kind: "lifecycle" as const,
                  ownerEntityId: "do:agent",
                },
              ]
            : [],
      }));
      const service = createVcsService({
        workspaceVcs: { contextStatus } as never,
        entityCache: entityCacheWithContext("do:agent", "ctx-current", "do"),
        listOwnedContexts,
      });

      await service.handler({ caller: createVerifiedCaller("do:agent", "do") }, "contextStatus", [
        { contextId: "ctx-child", ownerContextId: "ctx-parent" },
      ]);

      expect(listOwnedContexts).toHaveBeenCalledWith({ contextId: "ctx-parent" });
      expect(contextStatus).toHaveBeenCalledWith("ctx-child");
    });

    it("denies owner-context hints when the caller does not own the edge", async () => {
      const contextStatus = vi.fn();
      const service = createVcsService({
        workspaceVcs: { contextStatus } as never,
        entityCache: entityCacheWithContext("do:agent", "ctx-current", "do"),
        listOwnedContexts: async ({ contextId }) => ({
          contexts:
            contextId === "ctx-parent"
              ? [
                  {
                    contextId: "ctx-child",
                    kind: "lifecycle" as const,
                    ownerEntityId: "do:x",
                  },
                ]
              : [],
        }),
      });

      await expect(
        service.handler({ caller: createVerifiedCaller("do:agent", "do") }, "contextStatus", [
          { contextId: "ctx-child", ownerContextId: "ctx-parent" },
        ])
      ).rejects.toThrow("is not owned or forked");
      expect(contextStatus).not.toHaveBeenCalled();
    });

    it("rejects an invalid repo path arg to status", async () => {
      const statusHead = vi.fn();
      const service = createVcsService({
        workspaceVcs: { statusHead } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      // "root" is a single-segment, non-flat-section path → not a valid repo.
      await expect(service.handler({ caller: panelCaller() }, "status", ["root"])).rejects.toThrow(
        /Invalid workspace repo path/
      );
      expect(statusHead).not.toHaveBeenCalled();
    });

    it("rejects non-state-hash diff args with actionable VCS guidance", async () => {
      const diffStates = vi.fn();
      const service = createVcsService({
        workspaceVcs: { diffStates } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      await expect(
        service.handler({ caller: panelCaller() }, "diff", ["main", "state:abc"])
      ).rejects.toThrow("vcs.diff expects left to be a GAD state hash");
      expect(diffStates).not.toHaveBeenCalled();
    });

    it("routes diff through the content-store diffStates (not the gad DO)", async () => {
      const diffStates = vi.fn(async () => ({ added: [], removed: [], changed: [] }));
      const service = createVcsService({
        workspaceVcs: { diffStates } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      const result = await service.handler({ caller: panelCaller() }, "diff", [
        "state:aaa",
        "state:bbb",
      ]);

      expect(diffStates).toHaveBeenCalledWith("state:aaa", "state:bbb");
      expect(result).toEqual({ added: [], removed: [], changed: [] });
    });

    it("composes a buildable workspace state from a repo state", async () => {
      const workspaceViewWithRepoAt = vi.fn(async () => "state:workspace");
      const service = createVcsService({
        workspaceVcs: { repositories: { workspaceViewWithRepoAt } } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      const result = await service.handler({ caller: panelCaller() }, "workspaceViewWithRepoAt", [
        "panels/source",
        "state:repo",
      ]);

      expect(workspaceViewWithRepoAt).toHaveBeenCalledWith("panels/source", "state:repo");
      expect(result).toEqual({ stateHash: "state:workspace" });
    });

    it("rejects non-state refs when composing a workspace state", async () => {
      const workspaceViewWithRepoAt = vi.fn();
      const service = createVcsService({
        workspaceVcs: { repositories: { workspaceViewWithRepoAt } } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      await expect(
        service.handler({ caller: panelCaller() }, "workspaceViewWithRepoAt", [
          "panels/source",
          "ctx:ctx-1",
        ])
      ).rejects.toThrow("vcs.workspaceViewWithRepoAt expects stateHash to be a GAD state hash");
      expect(workspaceViewWithRepoAt).not.toHaveBeenCalled();
    });
  });

  describe("merge authorization", () => {
    // New model: `merge({ source, repoPaths?, head? })` RECONCILES — it pulls a
    // SOURCE (`main` or a context you own/forked) INTO the target ctx head (a
    // merge commit per repo), never INTO main. `head` is the head being
    // written; main as a target is rejected outright.
    function mergeService(opts: { entityCache?: EntityCache } = {}) {
      const mergeHeads = vi.fn(async () => ({
        status: "merged" as const,
        stateHash: "state:merged",
        conflicts: [],
        mergeable: "clean" as const,
        upstreamCommits: [],
      }));
      const service = createVcsService({
        workspaceVcs: { mergeHeads } as never,
        ...(opts.entityCache ? { entityCache: opts.entityCache } : {}),
      });
      return { service, mergeHeads };
    }

    it("rejects targeting the main head (merge pulls main into a ctx head)", async () => {
      const { service, mergeHeads } = mergeService({
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      // A panel naming an explicit `main` target: the write-head gate first
      // confines the panel to its own ctx head, so it never reaches main.
      await expect(
        service.handler({ caller: panelCaller() }, "merge", [{ source: "main", head: "main" }])
      ).rejects.toThrow("Callers may only write their own context head (ctx:ctx-1)");
      expect(mergeHeads).not.toHaveBeenCalled();
    });

    it("rejects a contextless panel caller whose implicit target is main", async () => {
      const { service, mergeHeads } = mergeService({ entityCache: new EntityCache() });

      await expect(
        service.handler({ caller: panelCaller() }, "merge", [{ source: "main" }])
      ).rejects.toThrow("vcs head writes require a context");
      expect(mergeHeads).not.toHaveBeenCalled();
    });

    it("rejects a panel caller reconciling into another context's head", async () => {
      const { service, mergeHeads } = mergeService({
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      await expect(
        service.handler({ caller: panelCaller() }, "merge", [
          { source: "main", head: "ctx:ctx-other" },
        ])
      ).rejects.toThrow("Callers may only write their own context head (ctx:ctx-1)");
      expect(mergeHeads).not.toHaveBeenCalled();
    });

    it("allows a panel caller to pull main into its own context head", async () => {
      const { service, mergeHeads } = mergeService({
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      // Omit head → defaults to the caller's own ctx head; source is main.
      // merge returns one result per repo.
      const result = (await service.handler({ caller: panelCaller() }, "merge", [
        { source: "main", repoPaths: ["panels/source"] },
      ])) as Array<{ repoPath: string; status: string }>;

      // mergeHeads(targetCtxHead, "main", { actor, repoPath }) — main pulled INTO ctx.
      expect(mergeHeads).toHaveBeenCalledWith(
        "ctx:ctx-1",
        "main",
        expect.objectContaining({
          actor: { id: "panel-source", kind: "panel" },
          repoPath: "panels/source",
        })
      );
      expect(result[0]!.status).toBe("merged");
    });

    it("does NOT pass a main-advance context into merge (a ctx reconcile never advances main)", async () => {
      const approve = vi.fn(async () => {});
      const mergeHeads = vi.fn(async () => ({
        status: "merged" as const,
        stateHash: "state:merged",
        conflicts: [],
        mergeable: "clean" as const,
        upstreamCommits: [],
      }));
      const service = createVcsService({
        workspaceVcs: { mergeHeads } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
        mainAdvanceGate: {
          approve,
          approveRepoDeletion: vi.fn(async () => {}),
        },
      });

      await service.handler({ caller: panelCaller() }, "merge", [
        { source: "main", repoPaths: ["panels/source"] },
      ]);

      const [, , mergeOpts] = mergeHeads.mock.calls[0] as unknown as [
        string,
        string,
        Record<string, unknown>,
      ];
      // No main-advance context threads through a ctx-head reconcile.
      expect(mergeOpts).not.toHaveProperty("mainAdvance");
      expect(approve).not.toHaveBeenCalled();
    });

    it("lets a privileged shell caller reconcile an explicit ctx head", async () => {
      const { service, mergeHeads } = mergeService();
      const caller = createVerifiedCaller("shell:dev_cli", "shell");

      const result = (await service.handler({ caller }, "merge", [
        { source: "main", head: "ctx:ctx-1", repoPaths: ["panels/source"] },
      ])) as Array<{ repoPath: string; status: string }>;

      expect(mergeHeads).toHaveBeenCalledWith(
        "ctx:ctx-1",
        "main",
        expect.objectContaining({ repoPath: "panels/source" })
      );
      expect(result[0]!.status).toBe("merged");
    });
  });

  describe("adoptImportedRepo surface removed (finding 2)", () => {
    it("no longer resolves — git import publishes through the gated DO import path", async () => {
      const adoptMainFromStore = vi.fn(async () => {});
      const service = createVcsService({
        workspaceVcs: { adoptMainFromStore } as never,
      });
      const extension = createVerifiedCaller("@workspace-extensions/git-bridge", "extension");

      await expect(
        service.handler({ caller: extension }, "adoptImportedRepo", ["projects/bgkit"])
      ).rejects.toThrow(/Unknown vcs method: adoptImportedRepo/);
      expect(adoptMainFromStore).not.toHaveBeenCalled();
    });
  });

  describe("abortMerge authorization", () => {
    it("rejects abortMerge on main because pending merges only live on context heads", async () => {
      const abortMerge = vi.fn(async () => ({ aborted: true }));
      const approve = vi.fn(async () => {});
      const service = createVcsService({
        workspaceVcs: { abortMerge } as never,
        mainAdvanceGate: {
          approve,
          approveRepoDeletion: vi.fn(async () => {}),
        },
      });
      const shell = createVerifiedCaller("shell:dev_cli", "shell");

      await expect(
        service.handler({ caller: shell }, "abortMerge", ["panels/source", "main"])
      ).rejects.toThrow(/main is a pure ref.*pending merges live on ctx:\*/s);

      expect(abortMerge).not.toHaveBeenCalled();
      expect(approve).not.toHaveBeenCalled();
    });

    it("defaults pendingMerge(repoPath) to the caller's own context head", async () => {
      const pendingMerge = vi.fn(async () => null);
      const service = createVcsService({
        workspaceVcs: { pendingMerge } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      await service.handler({ caller: panelCaller() }, "pendingMerge", ["panels/source"]);

      expect(pendingMerge).toHaveBeenCalledWith("ctx:ctx-1", "panels/source");
    });
  });

  describe("ergonomic VCS reads", () => {
    it("resolves a bare path through the workspace's declared default repo", async () => {
      const contextRepoState = vi.fn(async () => "state:repo");
      const readFile = vi.fn(async () => ({
        content: { kind: "text" as const, text: "hello\n" },
        stateHash: "state:repo",
        contentHash: "blob:hello",
        mode: 0o644,
        size: 6,
      }));
      const service = createVcsService({
        workspaceVcs: { contextRepoState, readFile } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
        getDefaultRepo: () => "projects/notes",
      });

      const result = await service.handler({ caller: panelCaller() }, "readFile", [
        { path: "note.txt" },
      ]);

      expect(contextRepoState).toHaveBeenCalledWith("ctx-1", "projects/notes");
      expect(readFile).toHaveBeenCalledWith("state:repo", "note.txt");
      expect(result).toMatchObject({ content: { kind: "text", text: "hello\n" } });
    });

    it("requires a declared base for a bare tracked path", async () => {
      const service = createVcsService({
        workspaceVcs: {} as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      await expect(
        service.handler({ caller: panelCaller() }, "readFile", [{ path: "note.txt" }])
      ).rejects.toThrow(/does not declare defaultRepo/i);
    });

    it("accepts an explicit repo-relative address on the caller's current head", async () => {
      const contextRepoState = vi.fn(async () => "state:repo");
      const readFile = vi.fn(async () => ({
        content: { kind: "text" as const, text: "hello\n" },
        stateHash: "state:repo",
        contentHash: "blob:hello",
        mode: 0o644,
        size: 6,
      }));
      const service = createVcsService({
        workspaceVcs: { contextRepoState, readFile } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      await service.handler({ caller: panelCaller() }, "readFile", [
        { path: "note.txt", repoPath: "projects/default" },
      ]);

      expect(contextRepoState).toHaveBeenCalledWith("ctx-1", "projects/default");
      expect(readFile).toHaveBeenCalledWith("state:repo", "note.txt");
    });

    it("accepts a repo-scoped historical file address", async () => {
      const readFile = vi.fn(async () => ({
        content: { kind: "text" as const, text: "old\n" },
        stateHash: "state:old",
        contentHash: "blob:old",
        mode: 0o644,
        size: 4,
      }));
      const service = createVcsService({
        workspaceVcs: { readFile } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      await service.handler({ caller: panelCaller() }, "readFile", [
        { path: "note.txt", repoPath: "meta", ref: "state:old" },
      ]);

      expect(readFile).toHaveBeenCalledWith("state:old", "note.txt", "meta");
    });

    it("accepts an explicit repo-scoped file listing", async () => {
      const contextRepoState = vi.fn(async () => "state:repo");
      const listFiles = vi.fn(async () => []);
      const service = createVcsService({
        workspaceVcs: { contextRepoState, listFiles } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      await service.handler({ caller: panelCaller() }, "listFiles", [
        { repoPath: "projects/default" },
      ]);

      expect(contextRepoState).toHaveBeenCalledWith("ctx-1", "projects/default");
      expect(listFiles).toHaveBeenCalledWith("state:repo");
    });
  });

  describe("edit authorization (working edits, not commits)", () => {
    it("treats an identical retried create as an idempotent write", async () => {
      const contextRepoState = vi.fn(async () => "state:working");
      const readFile = vi.fn(async () => ({
        content: { kind: "text" as const, text: "already here\n" },
        stateHash: "state:working",
        contentHash: "blob:same",
        mode: 0o644,
        size: 13,
      }));
      const recordEdit = vi.fn(async () => ({
        head: "ctx:ctx-1",
        stateHash: "state:working",
        committed: false as const,
        status: "uncommitted" as const,
        editSeq: 2,
        changedPaths: [],
      }));
      const service = createVcsService({
        workspaceVcs: { contextRepoState, readFile, recordEdit } as never,
        entityCache: entityCacheWithContext("do:agent", "ctx-1", "do"),
      });

      await service.handler({ caller: createVerifiedCaller("do:agent", "do") }, "edit", [
        {
          repoPath: "meta",
          edits: [{ kind: "create", path: "note.txt", content: "already here\n" }],
        },
      ]);

      expect(recordEdit).toHaveBeenCalledWith(
        expect.objectContaining({
          repoPath: "meta",
          edits: [
            {
              kind: "write",
              path: "note.txt",
              content: { kind: "text", text: "already here\n" },
            },
          ],
        })
      );
      expect(contextRepoState).toHaveBeenCalledWith("ctx-1", "meta");
      expect(readFile).toHaveBeenCalledWith("state:working", "note.txt", "meta");
    });

    it("creates the first files in a brand-new context repo without resolving a missing head", async () => {
      const contextRepoState = vi.fn(async () => null);
      const readFile = vi.fn();
      const recordEdit = vi.fn(async () => ({
        head: "ctx:ctx-1",
        stateHash: "state:first-working",
        committed: false as const,
        status: "uncommitted" as const,
        editSeq: 1,
        changedPaths: ["panels/new-panel/index.ts"],
      }));
      const service = createVcsService({
        workspaceVcs: { contextRepoState, readFile, recordEdit } as never,
        entityCache: entityCacheWithContext("do:agent", "ctx-1", "do"),
      });

      await service.handler({ caller: createVerifiedCaller("do:agent", "do") }, "edit", [
        {
          repoPath: "panels/new-panel",
          edits: [{ kind: "create", path: "index.ts", content: "export {};\n" }],
        },
      ]);

      expect(contextRepoState).toHaveBeenCalledWith("ctx-1", "panels/new-panel");
      expect(readFile).not.toHaveBeenCalled();
      expect(recordEdit).toHaveBeenCalledWith(
        expect.objectContaining({
          head: "ctx:ctx-1",
          repoPath: "panels/new-panel",
          edits: [
            {
              kind: "create",
              path: "index.ts",
              content: { kind: "text", text: "export {};\n" },
            },
          ],
        })
      );
    });

    it("routes a bare tracked filename through the declared default repo", async () => {
      const recordEdit = vi.fn(async () => ({
        head: "ctx:ctx-1",
        stateHash: "state:next",
        committed: false as const,
        status: "uncommitted" as const,
        editSeq: 1,
        changedPaths: ["projects/default/probe.txt"],
      }));
      const service = createVcsService({
        workspaceVcs: { recordEdit } as never,
        entityCache: entityCacheWithContext("do:agent", "ctx-1", "do"),
        getDefaultRepo: () => "projects/default",
      });

      await service.handler({ caller: createVerifiedCaller("do:agent", "do") }, "edit", [
        { edits: [{ path: "probe.txt", content: "tracked\n" }] },
      ]);

      expect(recordEdit).toHaveBeenCalledWith(
        expect.objectContaining({
          repoPath: "projects/default",
          edits: [
            {
              kind: "write",
              path: "probe.txt",
              content: { kind: "text", text: "tracked\n" },
            },
          ],
        })
      );
    });

    it("does not reinterpret a dotted repo root as a file in another repo", async () => {
      const recordEdit = vi.fn(async () => ({
        head: "ctx:ctx-1",
        stateHash: "state:next",
        committed: false as const,
        status: "uncommitted" as const,
        editSeq: 1,
        changedPaths: ["projects/default/.tmp-provenance-marker.txt"],
      }));
      const service = createVcsService({
        workspaceVcs: { recordEdit } as never,
        entityCache: entityCacheWithContext("do:agent", "ctx-1", "do"),
      });

      await expect(
        service.handler({ caller: createVerifiedCaller("do:agent", "do") }, "edit", [
          {
            edits: [
              {
                kind: "write",
                path: "projects/.tmp-provenance-marker.txt",
                content: { kind: "text", text: "probe\n" },
              },
            ],
          },
        ])
      ).rejects.toThrow(/names a workspace repo root/i);
      expect(recordEdit).not.toHaveBeenCalled();
    });

    it("canonicalizes a file-looking container-root path across inferred edits", async () => {
      const recordEdit = vi.fn(async () => ({
        head: "ctx:ctx-1",
        stateHash: "state:next",
        committed: false as const,
        status: "uncommitted" as const,
        editSeq: 1,
        changedPaths: ["projects/file-tools-smoke/file-tools-smoke.txt"],
      }));
      const service = createVcsService({
        workspaceVcs: { recordEdit } as never,
        entityCache: entityCacheWithContext("do:agent", "ctx-1", "do"),
      });

      await service.handler({ caller: createVerifiedCaller("do:agent", "do") }, "edit", [
        {
          edits: [
            {
              kind: "write",
              path: "projects/file-tools-smoke.txt",
              content: { kind: "text", text: "probe\n" },
            },
          ],
        },
      ]);

      expect(recordEdit).toHaveBeenCalledWith(
        expect.objectContaining({
          repoPath: "projects/file-tools-smoke",
          edits: [
            {
              kind: "write",
              path: "file-tools-smoke.txt",
              content: { kind: "text", text: "probe\n" },
            },
          ],
        })
      );
    });

    it("allows do callers to record a working edit on their own context head", async () => {
      // `edit` records an UNCOMMITTED working edit via recordEdit — no commit,
      // no build, not in vcs.log. The result is { committed:false, uncommitted }.
      const recordEdit = vi.fn(async () => ({
        head: "ctx:ctx-1",
        stateHash: "state:next",
        committed: false as const,
        status: "uncommitted" as const,
        editSeq: 1,
        changedPaths: ["panels/source/agent.txt"],
      }));
      const service = createVcsService({
        workspaceVcs: { recordEdit } as never,
        entityCache: entityCacheWithContext("do:agent", "ctx-1", "do"),
      });
      const caller = createVerifiedCaller("do:agent", "do");

      const result = (await service.handler({ caller }, "edit", [
        {
          baseStateHash: "state:base",
          edits: [
            {
              kind: "write",
              path: "panels/source/agent.txt",
              content: { kind: "text", text: "ok\n" },
            },
          ],
        },
      ])) as { committed: boolean; status: string; stateHash: string };

      expect(recordEdit).toHaveBeenCalledWith(
        expect.objectContaining({
          head: "ctx:ctx-1",
          baseStateHash: "state:base",
          actor: { id: "do:agent", kind: "do" },
          repoPath: "panels/source",
          edits: [
            {
              kind: "write",
              path: "agent.txt",
              content: { kind: "text", text: "ok\n" },
            },
          ],
        })
      );
      // No main-advance hook is threaded into a working edit.
      const [editArg] = recordEdit.mock.calls[0] as unknown as [Record<string, unknown>];
      expect(editArg).not.toHaveProperty("mainAdvance");
      expect(result.committed).toBe(false);
      expect(result.status).toBe("uncommitted");
      expect(result.stateHash).toBe("state:next");
    });

    it("allows agent callers to record a working edit on their bound context head", async () => {
      const recordEdit = vi.fn(async () => ({
        head: "ctx:ctx-agent",
        stateHash: "state:next",
        committed: false as const,
        status: "uncommitted" as const,
        editSeq: 1,
        changedPaths: ["panels/source/agent.txt"],
      }));
      const service = createVcsService({
        workspaceVcs: { recordEdit } as never,
        entityCache: new EntityCache(),
      });

      await service.handler({ caller: agentCaller("ent-agent", "ctx-agent") }, "edit", [
        {
          edits: [
            {
              kind: "write",
              path: "panels/source/agent.txt",
              content: { kind: "text", text: "ok\n" },
            },
          ],
        },
      ]);

      expect(recordEdit).toHaveBeenCalledWith(
        expect.objectContaining({
          head: "ctx:ctx-agent",
          actor: { id: "agent:ent-agent", kind: "agent" },
          repoPath: "panels/source",
        })
      );
    });

    it("normalizes documented shorthand edit ops before routing to WorkspaceVcs", async () => {
      const recordEdit = vi.fn(async () => ({
        head: "ctx:ctx-1",
        stateHash: "state:next",
        committed: false as const,
        status: "uncommitted" as const,
        editSeq: 1,
        changedPaths: ["projects/tmp-vcs-commit-smoke/note.txt"],
      }));
      const service = createVcsService({
        workspaceVcs: { recordEdit } as never,
        entityCache: entityCacheWithContext("do:agent", "ctx-1", "do"),
      });
      const caller = createVerifiedCaller("do:agent", "do");

      await service.handler({ caller }, "edit", [
        {
          edits: [
            {
              path: "projects/tmp-vcs-commit-smoke/note.txt",
              content: "temporary VCS commit smoke edit\n",
            },
          ],
        },
      ]);

      expect(recordEdit).toHaveBeenCalledWith(
        expect.objectContaining({
          repoPath: "projects/tmp-vcs-commit-smoke",
          edits: [
            {
              kind: "write",
              path: "note.txt",
              content: { kind: "text", text: "temporary VCS commit smoke edit\n" },
            },
          ],
        })
      );
    });

    it("resolves exact-text replacement shorthand against the current working state", async () => {
      const contextRepoState = vi.fn(async () => "state:working");
      const recordEdit = vi.fn(async () => ({
        head: "ctx:ctx-1",
        stateHash: "state:next",
        committed: false as const,
        status: "uncommitted" as const,
        editSeq: 1,
        changedPaths: ["note.txt"],
      }));
      const readFile = vi.fn(async () => ({
        content: { kind: "text" as const, text: "alpha\nunique old text\nomega\n" },
        stateHash: "state:working",
        contentHash: "blob:old",
        mode: 0o644,
        size: 28,
      }));
      const service = createVcsService({
        workspaceVcs: { contextRepoState, recordEdit, readFile } as never,
        entityCache: entityCacheWithContext("do:agent", "ctx-1", "do"),
      });

      await service.handler({ caller: createVerifiedCaller("do:agent", "do") }, "edit", [
        {
          edits: [
            {
              path: "projects/example/note.txt",
              oldText: "unique old text",
              newText: "replacement",
            },
          ],
        },
      ]);

      expect(contextRepoState).toHaveBeenCalledWith("ctx-1", "projects/example");
      expect(readFile).toHaveBeenCalledWith("state:working", "note.txt", "projects/example");
      expect(recordEdit).toHaveBeenCalledWith(
        expect.objectContaining({
          repoPath: "projects/example",
          edits: [
            {
              kind: "replace",
              path: "note.txt",
              hunks: [
                {
                  start: 6,
                  end: 21,
                  oldText: "unique old text",
                  newText: "replacement",
                },
              ],
            },
          ],
        })
      );
    });

    it("rejects a panel caller editing a foreign context head", async () => {
      const recordEdit = vi.fn();
      const service = createVcsService({
        workspaceVcs: { recordEdit } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      await expect(
        service.handler({ caller: panelCaller() }, "edit", [
          {
            head: "ctx:ctx-other",
            edits: [
              {
                kind: "write",
                path: "panels/source/a.txt",
                content: { kind: "text", text: "x\n" },
              },
            ],
          },
        ])
      ).rejects.toThrow("Callers may only write their own context head (ctx:ctx-1)");
      expect(recordEdit).not.toHaveBeenCalled();
    });

    it("rejects inferred edits that name a workspace repo root", async () => {
      const recordEdit = vi.fn();
      const service = createVcsService({
        workspaceVcs: { recordEdit } as never,
        entityCache: entityCacheWithContext("do:agent", "ctx-1", "do"),
      });
      const caller = createVerifiedCaller("do:agent", "do");

      await expect(
        service.handler({ caller }, "edit", [
          {
            edits: [
              {
                kind: "write",
                path: "projects/scratch",
                content: { kind: "text", text: "nope\n" },
              },
            ],
          },
        ])
      ).rejects.toThrow(/names a workspace repo root.*projects\/scratch\/README\.md/s);
      expect(recordEdit).not.toHaveBeenCalled();
    });

    it("rejects empty edit batches before calling WorkspaceVcs", async () => {
      const recordEdit = vi.fn();
      const service = createVcsService({
        workspaceVcs: { recordEdit } as never,
        entityCache: entityCacheWithContext("do:agent", "ctx-1", "do"),
      });
      const caller = createVerifiedCaller("do:agent", "do");

      await expect(
        service.handler({ caller }, "edit", [{ repoPath: "panels/source", edits: [] }])
      ).rejects.toThrow(/vcs\.edit requires at least one edit op.*no-op/s);
      expect(recordEdit).not.toHaveBeenCalled();
    });

    it("rejects scratch paths with an actionable tracking hint", async () => {
      const recordEdit = vi.fn();
      const service = createVcsService({
        workspaceVcs: { recordEdit } as never,
        entityCache: entityCacheWithContext("do:agent", "ctx-1", "do"),
      });
      const caller = createVerifiedCaller("do:agent", "do");

      await expect(
        service.handler({ caller }, "edit", [
          {
            edits: [
              {
                kind: "write",
                path: ".tmp/round-trip.txt",
                content: { kind: "text", text: "scratch\n" },
              },
            ],
          },
        ])
      ).rejects.toThrow(/scratch\/platform state.*outside VCS.*projects\/<name>/s);
      expect(recordEdit).not.toHaveBeenCalled();
    });

    it("rejects baseStateHash when one edit call routes to multiple repos", async () => {
      const recordEdit = vi.fn();
      const service = createVcsService({
        workspaceVcs: { recordEdit } as never,
        entityCache: entityCacheWithContext("do:agent", "ctx-1", "do"),
      });
      const caller = createVerifiedCaller("do:agent", "do");

      await expect(
        service.handler({ caller }, "edit", [
          {
            baseStateHash: "state:base",
            edits: [
              {
                kind: "write",
                path: "panels/source/a.txt",
                content: { kind: "text", text: "panel\n" },
              },
              {
                kind: "write",
                path: "workers/agent/index.ts",
                content: { kind: "text", text: "export default {};\n" },
              },
            ],
          },
        ])
      ).rejects.toThrow(/cannot enforce baseStateHash across multiple repos/);
      expect(recordEdit).not.toHaveBeenCalled();
    });

    it("routes dotted bare filenames through the declared default repo", async () => {
      const recordEdit = vi.fn(async () => ({
        head: "ctx:ctx-1",
        stateHash: "state:next",
        committed: false as const,
        status: "uncommitted" as const,
        editSeq: 1,
        changedPaths: ["projects/default/file-roundtrip-test.txt"],
      }));
      const service = createVcsService({
        workspaceVcs: { recordEdit } as never,
        entityCache: entityCacheWithContext("do:agent", "ctx-1", "do"),
        getDefaultRepo: () => "projects/default",
      });
      const caller = createVerifiedCaller("do:agent", "do");

      await service.handler({ caller }, "edit", [
        {
          edits: [
            {
              kind: "write",
              path: "file-roundtrip-test.txt",
              content: { kind: "text", text: "ok\n" },
            },
          ],
        },
      ]);
      expect(recordEdit).toHaveBeenCalledWith(
        expect.objectContaining({
          repoPath: "projects/default",
          edits: [expect.objectContaining({ path: "file-roundtrip-test.txt" })],
        })
      );
    });
  });

  describe("commit (fold working edits into a snapshot)", () => {
    it("commits the caller context's uncommitted edits per repo, requiring a message", async () => {
      const commit = vi.fn(async () => ({
        head: "ctx:ctx-1",
        stateHash: "state:snapshot",
        eventId: "evt-1",
        headHash: "h1",
        editCount: 2,
        status: "committed" as const,
        changedPaths: ["a.txt", "b.txt"],
      }));
      const contextStatus = vi.fn(async () => [
        {
          repoPath: "panels/source",
          forked: true,
          uncommitted: true,
          ahead: false,
          behind: false,
          deleted: false,
        },
      ]);
      const service = createVcsService({
        workspaceVcs: { commit, contextStatus } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      const result = (await service.handler({ caller: panelCaller() }, "commit", [
        { message: "snapshot a+b" },
      ])) as Array<{ repoPath: string; status: string; editCount: number }>;

      expect(commit).toHaveBeenCalledWith(
        expect.objectContaining({
          head: "ctx:ctx-1",
          repoPath: "panels/source",
          message: "snapshot a+b",
          actor: { id: "panel-source", kind: "panel" },
        })
      );
      expect(result).toHaveLength(1);
      expect(result[0]!.status).toBe("committed");
      expect(result[0]!.editCount).toBe(2);
    });

    it("rejects a commit with no message", async () => {
      const commit = vi.fn();
      const service = createVcsService({
        workspaceVcs: { commit } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      await expect(
        service.handler({ caller: panelCaller() }, "commit", [{ message: "   " }])
      ).rejects.toThrow(/message/);
      expect(commit).not.toHaveBeenCalled();
    });

    it("rejects a commit on the main head", async () => {
      const commit = vi.fn();
      const service = createVcsService({
        workspaceVcs: { commit } as never,
      });
      const shell = createVerifiedCaller("shell:dev_cli", "shell");

      await expect(
        service.handler({ caller: shell }, "commit", [{ message: "x", head: "main" }])
      ).rejects.toThrow(/main advances only via push/);
      expect(commit).not.toHaveBeenCalled();
    });

    it("rejects auto-commit when the context has no uncommitted VCS edits", async () => {
      const commit = vi.fn();
      const contextStatus = vi.fn(async () => []);
      const service = createVcsService({
        workspaceVcs: { commit, contextStatus } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      await expect(
        service.handler({ caller: panelCaller() }, "commit", [{ message: "nothing" }])
      ).rejects.toThrow(
        /refused to no-op: no uncommitted VCS working edits.*fs\.mktemp.*outside VCS/s
      );
      expect(commit).not.toHaveBeenCalled();
    });

    it("reports unchanged for an explicit repo with nothing to seal", async () => {
      const commit = vi.fn(async () => ({
        head: "ctx:ctx-1",
        stateHash: "state:same",
        eventId: null,
        headHash: null,
        editCount: 0,
        status: "unchanged" as const,
        changedPaths: [],
      }));
      const contextStatus = vi.fn(async () => [
        {
          repoPath: "panels/source",
          forked: true,
          uncommitted: false,
          ahead: true,
          behind: false,
          deleted: false,
        },
      ]);
      const service = createVcsService({
        workspaceVcs: { commit, contextStatus } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      const result = (await service.handler({ caller: panelCaller() }, "commit", [
        { message: "seal", repoPaths: ["panels/source"] },
      ])) as Array<{ repoPath: string; status: string }>;
      expect(result).toEqual([
        expect.objectContaining({ repoPath: "panels/source", status: "unchanged" }),
      ]);
      expect(commit).toHaveBeenCalledOnce();
    });

    it("rejects duplicate commit repoPaths before committing", async () => {
      const commit = vi.fn();
      const contextStatus = vi.fn(async () => []);
      const service = createVcsService({
        workspaceVcs: { commit, contextStatus } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      await expect(
        service.handler({ caller: panelCaller() }, "commit", [
          { message: "seal", repoPaths: ["panels/source", "panels/source"] },
        ])
      ).rejects.toThrow(/duplicate repo path\(s\): panels\/source/);
      expect(commit).not.toHaveBeenCalled();
    });

    it("rejects scratch commit excludes instead of silently ignoring them", async () => {
      const commit = vi.fn();
      const contextStatus = vi.fn(async () => [
        {
          repoPath: "panels/source",
          forked: true,
          uncommitted: true,
          ahead: false,
          behind: false,
          deleted: false,
        },
      ]);
      const service = createVcsService({
        workspaceVcs: { commit, contextStatus } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      await expect(
        service.handler({ caller: panelCaller() }, "commit", [
          { message: "seal", exclude: [".vibestudio/tmp/not-tracked.txt"] },
        ])
      ).rejects.toThrow(/vcs\.commit exclude.*scratch\/platform state.*outside VCS/s);
      expect(commit).not.toHaveBeenCalled();
    });

    it("rejects commit excludes that belong to repos outside the target set", async () => {
      const commit = vi.fn();
      const contextStatus = vi.fn(async () => [
        {
          repoPath: "panels/source",
          forked: true,
          uncommitted: true,
          ahead: false,
          behind: false,
          deleted: false,
        },
        {
          repoPath: "packages/other",
          forked: true,
          uncommitted: true,
          ahead: false,
          behind: false,
          deleted: false,
        },
      ]);
      const service = createVcsService({
        workspaceVcs: { commit, contextStatus } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      await expect(
        service.handler({ caller: panelCaller() }, "commit", [
          {
            message: "seal",
            repoPaths: ["panels/source"],
            exclude: ["packages/other/index.ts"],
          },
        ])
      ).rejects.toThrow(/exclude path .* belongs to packages\/other.*targets panels\/source/s);
      expect(commit).not.toHaveBeenCalled();
    });

    it("rejects explicit target repos that have no selected commit path", async () => {
      const commit = vi.fn();
      const contextStatus = vi.fn(async () => [
        {
          repoPath: "packages/selected",
          forked: true,
          uncommitted: true,
          ahead: false,
          behind: false,
          deleted: false,
        },
        {
          repoPath: "packages/unrelated",
          forked: true,
          uncommitted: true,
          ahead: false,
          behind: false,
          deleted: false,
        },
      ]);
      const service = createVcsService({
        workspaceVcs: { commit, contextStatus } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      await expect(
        service.handler({ caller: panelCaller() }, "commit", [
          {
            message: "seal selected file",
            repoPaths: ["packages/selected", "packages/unrelated"],
            paths: ["packages/selected/index.ts"],
          },
        ])
      ).rejects.toThrow(/packages\/unrelated.*no selected paths/s);
      expect(commit).not.toHaveBeenCalled();
    });

    it("preserves lower-layer unchanged as an explicit per-repo outcome", async () => {
      const commit = vi.fn(async () => ({
        head: "ctx:ctx-1",
        stateHash: "state:same",
        eventId: null,
        headHash: null,
        editCount: 0,
        status: "unchanged" as const,
        changedPaths: [],
      }));
      const contextStatus = vi.fn(async () => [
        {
          repoPath: "panels/source",
          forked: true,
          uncommitted: true,
          ahead: false,
          behind: false,
          deleted: false,
        },
      ]);
      const service = createVcsService({
        workspaceVcs: { commit, contextStatus } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      const result = (await service.handler({ caller: panelCaller() }, "commit", [
        { message: "seal" },
      ])) as Array<{ repoPath: string; status: string }>;
      expect(result).toEqual([
        expect.objectContaining({ repoPath: "panels/source", status: "unchanged" }),
      ]);
    });
  });

  describe("revert (lands as a working edit)", () => {
    it("infers the latest commit when the revert target is omitted", async () => {
      const readVcsLog = vi.fn(async () => [
        {
          seq: 4,
          envelopeId: "evt-latest",
          actor: {},
          summary: "latest",
          outputStateHash: "state:latest",
          appendedAt: new Date(0).toISOString(),
        },
      ]);
      const revert = vi.fn(async () => ({
        head: "ctx:ctx-1",
        stateHash: "state:reverted",
        committed: false as const,
        status: "uncommitted" as const,
        editSeq: 3,
        changedPaths: ["panels/source/a.txt"],
      }));
      const service = createVcsService({
        workspaceVcs: { readVcsLog, revert } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      await service.handler({ caller: panelCaller() }, "revert", [{ repoPath: "panels/source" }]);

      expect(readVcsLog).toHaveBeenCalledWith("panels/source", 1, "ctx:ctx-1");
      expect(revert).toHaveBeenCalledWith(
        expect.objectContaining({ target: { stateHash: undefined, eventId: "evt-latest" } })
      );
    });

    it("reverts a change as a working edit on the caller's own head", async () => {
      // revert now returns a VcsEditResult — a tracked WORKING edit, not a commit.
      const revert = vi.fn(async () => ({
        head: "ctx:ctx-1",
        stateHash: "state:reverted",
        committed: false as const,
        status: "uncommitted" as const,
        editSeq: 3,
        changedPaths: ["panels/source/a.txt"],
      }));
      const service = createVcsService({
        workspaceVcs: { revert } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      const result = (await service.handler({ caller: panelCaller() }, "revert", [
        { eventId: "evt-9", repoPath: "panels/source" },
      ])) as { committed: boolean; status: string };

      expect(revert).toHaveBeenCalledWith(
        expect.objectContaining({
          head: "ctx:ctx-1",
          target: { stateHash: undefined, eventId: "evt-9" },
          actor: { id: "panel-source", kind: "panel" },
          repoPath: "panels/source",
        })
      );
      expect(result.committed).toBe(false);
      expect(result.status).toBe("uncommitted");
    });

    it("rejects a revert onto a foreign context head", async () => {
      const revert = vi.fn();
      const service = createVcsService({
        workspaceVcs: { revert } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      await expect(
        service.handler({ caller: panelCaller() }, "revert", [
          { eventId: "evt-9", repoPath: "panels/source", head: "ctx:ctx-other" },
        ])
      ).rejects.toThrow("Callers may only write their own context head (ctx:ctx-1)");
      expect(revert).not.toHaveBeenCalled();
    });
  });

  describe("commit log compatibility", () => {
    it("exposes vcs.log through the host service on the caller's context head", async () => {
      const readVcsLog = vi.fn(async () => []);
      const service = createVcsService({
        workspaceVcs: { readVcsLog } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      await service.handler({ caller: panelCaller() }, "log", ["panels/source", 10]);

      expect(readVcsLog).toHaveBeenCalledWith("panels/source", 10, "ctx:ctx-1");
    });
  });

  describe("push status", () => {
    it("reports push status for the requested repos", async () => {
      const pushStatus = vi.fn(async () => ({
        repoPath: "panels/source",
        head: "ctx:ctx-1",
        headStateHash: "ctx-state",
        mainStateHash: "main-state",
        ahead: 2,
        uncommitted: 0,
        diverged: false,
        deleted: false,
        files: [
          { path: "a.mdx", kind: "changed" as const },
          { path: "b.mdx", kind: "added" as const },
        ],
      }));
      const service = createVcsService({
        workspaceVcs: { pushStatus } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      const result = (await service.handler({ caller: panelCaller() }, "pushStatus", [
        ["panels/source"],
      ])) as Array<{ ahead: number }>;

      expect(pushStatus).toHaveBeenCalledWith("panels/source", "ctx:ctx-1");
      expect(result[0]!.ahead).toBe(2);
    });
  });
});
