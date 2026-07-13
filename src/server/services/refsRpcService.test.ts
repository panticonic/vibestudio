import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { createProtectedRefStore, type RefGateBatch } from "./protectedRefStore.js";
import { createRefsRpcService } from "./refsRpcService.js";
import { VcsInvocationTable } from "./vcsInvocationTable.js";
import type { RefAdvanceGateContext } from "./mainAdvanceApproval.js";

const STATE_A = `state:${"a".repeat(64)}`;
const STATE_B = `state:${"b".repeat(64)}`;
const STATE_C = `state:${"c".repeat(64)}`;

const WRITER_ID = "do:workers/gad-store:GadStore:vcs";

function writerDoCaller(id = WRITER_ID) {
  return createVerifiedCaller(id, "do");
}

function panelCaller(id = "chat-1") {
  return createVerifiedCaller(id, "panel", {
    callerId: id,
    callerKind: "panel",
    repoPath: "panels/chat",
    effectiveVersion: "ev-1",
  });
}

describe("refsRpcService", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeService(opts: { writerIdentity?: string | null } = {}) {
    const statePath = fs.mkdtempSync(path.join(os.tmpdir(), "refs-service-"));
    tmpDirs.push(statePath);
    const gateBatches: RefGateBatch[] = [];
    const refs = createProtectedRefStore({
      statePath,
      gate: async (batch) => {
        gateBatches.push(batch);
      },
    });
    const invocations = new VcsInvocationTable();
    const service = createRefsRpcService({
      refs,
      invocations,
      getVcsWriterIdentity: () =>
        opts.writerIdentity === undefined ? WRITER_ID : opts.writerIdentity,
    });
    return { service, refs, invocations, gateBatches };
  }

  const oneAdvance = (
    repoPath = "packages/notes",
    expectedOld: string | null = null,
    next: string | null = STATE_A
  ) => [{ repoPath, expectedOld, next }];

  describe("reads", () => {
    it("readMain / listMains surface the store's records", async () => {
      const { service, refs } = makeService();
      await refs.seedMain({ repoPath: "packages/notes", value: STATE_A });
      const ctx = { caller: createVerifiedCaller("shell:dev_cli", "shell") } as never;

      expect(await service.handler(ctx, "readMain", ["packages/notes"])).toMatchObject({
        stateHash: STATE_A,
      });
      expect(await service.handler(ctx, "readMain", ["packages/other"])).toBeNull();
      expect(await service.handler(ctx, "listMains", [])).toHaveLength(1);
    });

    it("listMainRefLog surfaces the movement log over the RPC surface", async () => {
      const { service } = makeService();
      const ctx = { caller: createVerifiedCaller("shell:dev_cli", "shell") } as never;
      await service.handler({ caller: writerDoCaller() } as never, "updateMains", [
        { entries: oneAdvance(), operation: "push" },
      ]);
      const rows = (await service.handler(ctx, "listMainRefLog", [
        { repoPath: "packages/notes" },
      ])) as Array<{ operation: string; new: string | null }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ operation: "push", new: STATE_A });
    });
  });

  describe("single-writer policy", () => {
    it("admits the VCS-DO writer (matched by target identity) and gates the advance", async () => {
      const { service, refs, gateBatches } = makeService();
      const result = (await service.handler({ caller: writerDoCaller() } as never, "updateMains", [
        { entries: oneAdvance(), operation: "push" },
      ])) as { updated: Array<{ stateHash: string | null }> };

      expect(result.updated[0]).toMatchObject({ stateHash: STATE_A });
      expect(refs.readMain("packages/notes")?.stateHash).toBe(STATE_A);
      // Gated through the ref gate with a caller-kind context.
      expect(gateBatches).toHaveLength(1);
      const ctx = gateBatches[0]!.gateContext as RefAdvanceGateContext;
      expect(ctx.kind).toBe("caller");
    });

    it.each([
      ["panel", createVerifiedCaller("chat-1", "panel")],
      ["app", createVerifiedCaller("app-1", "app")],
      ["worker", createVerifiedCaller("w-1", "worker")],
      ["extension", createVerifiedCaller("ext-1", "extension")],
      ["shell", createVerifiedCaller("shell:dev", "shell")],
    ] as const)("rejects a %s caller with a structured policy error", async (_kind, caller) => {
      const { service, refs } = makeService();
      await expect(
        service.handler({ caller } as never, "updateMains", [
          { entries: oneAdvance(), operation: "push" },
        ])
      ).rejects.toMatchObject({ code: "EACCES" });
      expect(refs.readMain("packages/notes")).toBeNull();
    });

    it("rejects a DIFFERENT (non-writer) DO — identity, not runtime.kind", async () => {
      const { service } = makeService();
      await expect(
        service.handler(
          { caller: writerDoCaller("do:workers/evil:Fake:vcs") } as never,
          "updateMains",
          [{ entries: oneAdvance(), operation: "push" }]
        )
      ).rejects.toMatchObject({ code: "EACCES" });
    });

    it("rejects even the writer DO when no vcs binding exists (identity null)", async () => {
      const { service } = makeService({ writerIdentity: null });
      await expect(
        service.handler({ caller: writerDoCaller() } as never, "updateMains", [
          { entries: oneAdvance(), operation: "push" },
        ])
      ).rejects.toMatchObject({ code: "EACCES" });
    });
  });

  describe("on-behalf-of invocation tokens", () => {
    it("resolves a token to the originating principal (writer=DO, onBehalfOf=panel, via=DO)", async () => {
      const { service, invocations, gateBatches } = makeService();
      const upstream = panelCaller();
      const { token } = invocations.mint({ caller: upstream, via: WRITER_ID, method: "vcsPush" });

      await service.handler({ caller: writerDoCaller() } as never, "updateMains", [
        { entries: oneAdvance(), invocationToken: token, operation: "push" },
      ]);

      // Gate attribution is the RESOLVED upstream caller, not the DO.
      const ctx = gateBatches[0]!.gateContext as RefAdvanceGateContext;
      if (ctx.kind !== "caller") throw new Error("unreachable");
      expect(ctx.caller).toBe(upstream);
      expect(ctx.via).toBe(WRITER_ID);
    });

    it("chains an extension import's identity into the attribution (onBehalfOf=extension)", async () => {
      // §10 attribution: a git-bridge import publishes via the DO under an
      // extension-originated invocation token; the resolved principal is the
      // EXTENSION (its identity, not the DO's), threaded into the gate context.
      const { service, invocations, gateBatches } = makeService();
      const extension = createVerifiedCaller("git-bridge", "extension");
      const { token } = invocations.mint({
        caller: extension,
        via: WRITER_ID,
        method: "vcsImportPublish",
      });

      await service.handler({ caller: writerDoCaller() } as never, "updateMains", [
        { entries: oneAdvance(), invocationToken: token, operation: "push" },
      ]);

      const ctx = gateBatches[0]!.gateContext as RefAdvanceGateContext;
      if (ctx.kind !== "caller") throw new Error("unreachable");
      expect(ctx.caller).toBe(extension);
      expect(ctx.via).toBe(WRITER_ID);
    });

    it("may be presented on MULTIPLE attempts within the dispatch window (CAS retry)", async () => {
      const { service, invocations, gateBatches } = makeService();
      const upstream = panelCaller();
      const { token } = invocations.mint({ caller: upstream, via: WRITER_ID, method: "vcsPush" });

      await service.handler({ caller: writerDoCaller() } as never, "updateMains", [
        {
          entries: oneAdvance("packages/notes", null, STATE_A),
          invocationToken: token,
          operation: "push",
        },
      ]);
      // Second attempt re-uses the SAME token (still in flight); succeeds.
      await service.handler({ caller: writerDoCaller() } as never, "updateMains", [
        {
          entries: oneAdvance("packages/notes", STATE_A, STATE_B),
          invocationToken: token,
          operation: "push",
        },
      ]);

      expect(gateBatches).toHaveLength(2);
      for (const batch of gateBatches) {
        const ctx = batch.gateContext as RefAdvanceGateContext;
        if (ctx.kind !== "caller") throw new Error("unreachable");
        expect(ctx.caller).toBe(upstream);
      }
    });

    it("rejects a token minted for a different VCS writer identity", async () => {
      const { service, invocations } = makeService();
      const { token } = invocations.mint({
        caller: panelCaller(),
        via: "do:workers/gad-store:GadStore:other",
        method: "vcsPush",
      });

      await expect(
        service.handler({ caller: writerDoCaller() } as never, "updateMains", [
          { entries: oneAdvance(), invocationToken: token, operation: "push" },
        ])
      ).rejects.toThrow(/different VCS writer/);
    });

    it("rejects a token replayed AFTER the dispatch completes (release clears it)", async () => {
      const { service, invocations } = makeService();
      const { token, release } = invocations.mint({
        caller: panelCaller(),
        via: WRITER_ID,
        method: "vcsPush",
      });
      release();
      await expect(
        service.handler({ caller: writerDoCaller() } as never, "updateMains", [
          { entries: oneAdvance(), invocationToken: token, operation: "push" },
        ])
      ).rejects.toThrow(/invalid or expired invocation token/);
    });

    it("fails closed on a forged/foreign token — never silently attributes to the DO", async () => {
      const { service, refs } = makeService();
      await expect(
        service.handler({ caller: writerDoCaller() } as never, "updateMains", [
          { entries: oneAdvance(), invocationToken: "forged-token", operation: "push" },
        ])
      ).rejects.toThrow(/invalid or expired invocation token/);
      expect(refs.readMain("packages/notes")).toBeNull();
    });

    it("attributes to the DO itself when no token is presented (no inherited grants)", async () => {
      const { service, gateBatches } = makeService();
      await service.handler({ caller: writerDoCaller() } as never, "updateMains", [
        { entries: oneAdvance(), operation: "push" },
      ]);
      const ctx = gateBatches[0]!.gateContext as RefAdvanceGateContext;
      if (ctx.kind !== "caller") throw new Error("unreachable");
      expect(ctx.caller.runtime.id).toBe(WRITER_ID);
      expect(ctx.via).toBeUndefined();
    });

    it("captures the resolved attribution into the main-ref log (writer=DO, onBehalfOf=panel)", async () => {
      const { service, refs, invocations } = makeService();
      const upstream = panelCaller();
      const { token } = invocations.mint({ caller: upstream, via: WRITER_ID, method: "vcsPush" });

      await service.handler({ caller: writerDoCaller() } as never, "updateMains", [
        { entries: oneAdvance(), invocationToken: token, operation: "push", reason: "landed" },
      ]);

      const rows = refs.listMainRefLog("packages/notes");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        operation: "push",
        reason: "landed",
        writer: WRITER_ID,
        old: null,
        new: STATE_A,
      });
      expect((rows[0]!.onBehalfOf as { runtime: { id: string } }).runtime.id).toBe("chat-1");
    });

    it("logs a no-token advance attributed to the DO itself (writer === onBehalfOf)", async () => {
      const { service, refs } = makeService();
      await service.handler({ caller: writerDoCaller() } as never, "updateMains", [
        { entries: oneAdvance(), operation: "push" },
      ]);
      const row = refs.listMainRefLog("packages/notes")[0]!;
      expect(row.writer).toBe(WRITER_ID);
      expect((row.onBehalfOf as { runtime: { id: string } }).runtime.id).toBe(WRITER_ID);
    });
  });

  it("enforces compare-and-swap and validates inputs at the schema boundary", async () => {
    const { service } = makeService();
    const ctx = { caller: writerDoCaller() } as never;
    await service.handler(ctx, "updateMains", [{ entries: oneAdvance(), operation: "push" }]);
    await expect(
      service.handler(ctx, "updateMains", [
        { entries: oneAdvance("packages/notes", null, STATE_C), operation: "push" },
      ])
    ).rejects.toMatchObject({ code: "REF_CONFLICT" });
    await expect(
      service.handler(ctx, "updateMains", [
        {
          entries: [{ repoPath: "packages/notes", expectedOld: null, next: "not-a-tree-ref" }],
          operation: "push",
        },
      ])
    ).rejects.toThrow();
  });
});
