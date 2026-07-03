/**
 * Full-chain on-behalf-of attribution (narrow-host-vcs §4, register rows 11-12).
 *
 * Prior phases verified token attribution at the RELAY level (rpcServer.test.ts,
 * mocked transport) and the DO level (doVcsPush.test.ts, stubbed refsStore). This
 * suite wires the REAL chain end-to-end in ONE process:
 *
 *   sandboxed caller dispatch (real `__rpc` envelope, carrying the host-minted
 *     invocationToken + host-resolved callerContextId, exactly as the relay
 *     threads them)
 *   → REAL GadWorkspaceDO.vcsPush (clean-source / FF / build-gate / write-ahead
 *     intent / publish orchestration)
 *   → REAL refsService.updateMains handler (single-writer policy + on-behalf-of
 *     token resolution against the REAL VcsInvocationTable)
 *   → REAL RefService gated CAS (gateContext observed at the approval gate).
 *
 * REAL vs STUBBED (see report):
 *   REAL   — VcsInvocationTable (mint/resolve/release), refsService handler
 *            (policy + token resolution + gateContext construction), RefService
 *            (CAS + gate), GadWorkspaceDO push/merge orchestration, the DO base's
 *            read-at-entry invocationToken/callerContextId binding (driven via a
 *            real `__rpc` envelope), the content store, the chrome-trust bypass.
 *   STUBBED — (a) the HTTP/workerd transport between host relay and DO is replaced
 *            by in-process `fetch` into the DO (the full electron gateway /
 *            workerd is unreachable in a vitest process); (b) the host-side token
 *            MINT is performed by calling `VcsInvocationTable.mint` directly — the
 *            EXACT call `RpcServer.relayToDO` makes at its chokepoint; (c) the
 *            build validator is a no-op all-pass, as in doVcsPush.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { GadWorkspaceDO } from "../../workspace/workers/gad-store/index.js";
import { attachLocalHostBridges } from "../../src/server/vcsHost/testSupport.js";
import { WorkspaceVcs } from "../../src/server/vcsHost/workspaceVcs.js";
import { vcsContextHead } from "../../src/server/vcsHost/paths.js";
import type { GadCaller } from "../../src/server/vcsHost/testSupport.js";
import { createRefService, type RefGateBatch } from "../../src/server/services/refService.js";
import { createRefsService } from "../../src/server/services/refsService.js";
import { VcsInvocationTable } from "../../src/server/services/vcsInvocationTable.js";
import { isAuthorizedChrome } from "../../src/server/services/chromeTrust.js";
import { createVerifiedCaller, type VerifiedCaller } from "@vibez1/shared/serviceDispatcher";
import type { RefAdvanceGateContext } from "../../src/server/services/mainAdvanceApproval.js";

const USER = { id: "user", kind: "user" };
const WRITER_ID = "do:workers/gad-store:GadWorkspaceDO:workspace-gad";
type TestGad = Awaited<ReturnType<typeof createTestDO<GadWorkspaceDO>>>;

function inProcessGadCaller(gad: TestGad): GadCaller {
  return {
    async call<T>(method: string, input: unknown): Promise<T> {
      const instance = gad.instance as unknown as Record<string, (arg: unknown) => unknown>;
      const fn = instance[method];
      if (typeof fn !== "function") throw new Error(`no such gad method: ${method}`);
      return (await fn.call(gad.instance, input)) as T;
    },
  };
}

describe("full-gateway attribution (rows 11-12)", () => {
  let root: string;
  let gad: TestGad;
  let vcs: WorkspaceVcs;
  let refs: ReturnType<typeof createRefService>;
  let invocations: VcsInvocationTable;
  let refsService: ReturnType<typeof createRefsService>;
  let gateBatches: RefGateBatch[];

  /** The REAL refs bridge: the DO's `refsStore().updateMains` routes through the
   *  REAL refsService handler, authenticated as the writer DO — so the
   *  single-writer policy + on-behalf-of token resolution are genuinely
   *  exercised (not the doVcsPush stub, which bypasses that layer). */
  function installRealRefsBridge(): void {
    const writerCtx = { caller: createVerifiedCaller(WRITER_ID, "do") };
    const bridge = {
      async readMain(repoPath: string) {
        const r = refs.readMain(repoPath);
        return r ? { stateHash: r.stateHash } : null;
      },
      async listMains() {
        return refs.listMains().map((r) => ({ repoPath: r.repoPath, stateHash: r.stateHash }));
      },
      async readMainLog(repoPath: string, limit?: number) {
        return refs
          .readMainLog({ repoPath, ...(limit !== undefined ? { limit } : {}) })
          .map((e) => ({ seq: e.seq, old: e.old, new: e.new, operation: e.operation }));
      },
      async updateMains(input: {
        entries: Array<{ repoPath: string; expectedOld: string | null; next: string | null }>;
        reason?: string;
        operation: "push" | "merge" | "import" | "delete" | "restore";
        invocationToken?: string;
      }) {
        // The production RPC hop: the DO calls refs.updateMains; the host
        // resolves attribution from the token in the refsService handler.
        return (await refsService.handler(writerCtx as never, "updateMains", [input])) as {
          updated: Array<{ repoPath: string; stateHash: string | null; seq: number }>;
        };
      },
    };
    Object.defineProperty(gad.instance, "refsStore", { value: () => bridge, configurable: true });
  }

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "gw-attr-"));
    await fsp.mkdir(path.join(root, "workspace"));
    gad = await createTestDO(GadWorkspaceDO, { __objectKey: "workspace-gad" });
    gateBatches = [];
    refs = createRefService({
      statePath: path.join(root, "refs"),
      gate: async (batch) => {
        gateBatches.push(batch);
      },
    });
    invocations = new VcsInvocationTable();
    refsService = createRefsService({
      refs,
      invocations,
      getVcsWriterIdentity: () => WRITER_ID,
    });
    // contentStore + buildStore from the shared bridge; refsStore overridden below.
    attachLocalHostBridges(gad.instance, { blobsDir: path.join(root, "blobs"), refs });
    installRealRefsBridge();
    vcs = new WorkspaceVcs({
      blobsDir: path.join(root, "blobs"),
      workspaceRoot: path.join(root, "workspace"),
      contextsRoot: path.join(root, ".contexts"),
      buildSourcesRoot: path.join(root, "build-sources"),
      refs,
      vcsInvocations: invocations,
      getVcsWriterIdentity: () => WRITER_ID,
    });
    await vcs.attachGad(inProcessGadCaller(gad));
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  async function seedCommit(ctxId: string, repoPath: string, file: string, text: string) {
    const head = vcsContextHead(ctxId);
    await vcs.recordEdit({
      head,
      repoPath,
      actor: USER,
      edits: [{ kind: "create", path: file, content: { kind: "text", text } }],
    });
    const committed = await vcs.commit({ head, repoPath, message: `commit ${file}`, actor: USER });
    expect(committed.status).toBe("committed");
    return committed.stateHash;
  }

  /** Deliver `vcsPush` to the DO via the REAL `__rpc` envelope path, threading
   *  the host-minted token + host-resolved context exactly as the relay does.
   *  Mints/releases around the dispatch, mirroring `RpcServer.relayToDO`. */
  async function relayPush(opts: {
    caller: VerifiedCaller;
    callerContextId?: string;
    /** When true, dispatch WITHOUT a token (a DO self-initiated advance). */
    noToken?: boolean;
    input: { repoPaths: string[]; sourceHead: string };
  }): Promise<{ status: string }> {
    const minted = opts.noToken
      ? null
      : invocations.mint({
          caller: opts.caller,
          via: WRITER_ID,
          method: "vcsPush",
          operation: "push",
        });
    try {
      const objectKey = "workspace-gad";
      const fetchable = gad.instance as unknown as { fetch(r: Request): Promise<Response> };
      const envelope = {
        from: opts.caller.runtime.id,
        target: `do:test:${objectKey}`,
        delivery: {
          caller: { callerId: opts.caller.runtime.id, callerKind: opts.caller.runtime.kind },
        },
        provenance: [],
        message: {
          type: "request",
          requestId: crypto.randomUUID(),
          fromId: opts.caller.runtime.id,
          method: "vcsPush",
          // `actor` is a provenance LABEL, distinct from gate attribution (which
          // the host resolves from the token). Pass an explicit valid actor, as
          // an in-process host caller does — the caller kind (shell/do) is not a
          // provenance participant kind.
          args: [{ ...opts.input, actor: USER }],
          ...(minted ? { invocationToken: minted.token } : {}),
          ...(opts.callerContextId ? { callerContextId: opts.callerContextId } : {}),
        },
      };
      const res = await fetchable.fetch(
        new Request(`http://test/${objectKey}/__rpc`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(envelope),
        })
      );
      const text = await res.text();
      const respEnv = (text ? JSON.parse(text) : {}) as {
        message?: { type?: string; result?: unknown; error?: unknown };
      };
      const msg = respEnv.message;
      if (msg?.type === "response" && msg.error != null) {
        throw new Error(typeof msg.error === "string" ? msg.error : JSON.stringify(msg.error));
      }
      return msg?.result as { status: string };
    } finally {
      minted?.release();
    }
  }

  function lastGateCaller(): VerifiedCaller {
    const ctx = gateBatches.at(-1)?.gateContext as RefAdvanceGateContext | undefined;
    if (!ctx || ctx.kind !== "caller") throw new Error("no caller-kind gate context recorded");
    return ctx.caller;
  }

  it("attributes a panel-originated push to the PANEL principal (no chrome bypass)", async () => {
    const panel = createVerifiedCaller("chat-1", "panel");
    const stateHash = await seedCommit("chat-1", "packages/a", "a.txt", "A\n");

    const result = await relayPush({
      caller: panel,
      callerContextId: "chat-1",
      input: { repoPaths: ["packages/a"], sourceHead: vcsContextHead("chat-1") },
    });
    expect(result.status).toBe("pushed");
    expect(refs.readMain("packages/a")?.stateHash).toBe(stateHash);

    // The approval gate saw the ORIGINATING panel principal, resolved by the
    // host from the token — and the chrome bypass does NOT fire for it.
    const gateCaller = lastGateCaller();
    expect(gateCaller.runtime).toEqual({ id: "chat-1", kind: "panel" });
    expect(isAuthorizedChrome(gateCaller)).toBe(false);
    // Ref log records DO writer + panel on-behalf-of.
    const log = refs.readMainLog({ repoPath: "packages/a" });
    expect(log[0]).toMatchObject({ writer: `do:${WRITER_ID}`, onBehalfOf: "panel:chat-1" });
    // The token window closed after the dispatch (replay fails closed).
    expect(invocations.size()).toBe(0);
  });

  it("attributes a chrome-originated push to chrome — bypass FIRES on the resolved caller", async () => {
    const shell = createVerifiedCaller("shell", "shell");
    // Sanity: chrome trust is keyed on the resolved principal.
    expect(isAuthorizedChrome(shell)).toBe(true);
    await seedCommit("chat-1", "packages/a", "a.txt", "A\n");

    const result = await relayPush({
      caller: shell,
      // chrome has no ctx registration; it pushes another head unrestricted.
      input: { repoPaths: ["packages/a"], sourceHead: vcsContextHead("chat-1") },
    });
    expect(result.status).toBe("pushed");
    const gateCaller = lastGateCaller();
    expect(gateCaller.runtime).toEqual({ id: "shell", kind: "shell" });
    expect(isAuthorizedChrome(gateCaller)).toBe(true);
    expect(refs.readMainLog({ repoPath: "packages/a" })[0]).toMatchObject({
      onBehalfOf: "shell:shell",
    });
  });

  it("a DO-self push (no token) attributes to the DO itself — full prompt, no bypass", async () => {
    await seedCommit("chat-1", "packages/a", "a.txt", "A\n");
    const result = await relayPush({
      caller: createVerifiedCaller(WRITER_ID, "do"),
      noToken: true,
      input: { repoPaths: ["packages/a"], sourceHead: vcsContextHead("chat-1") },
    });
    expect(result.status).toBe("pushed");
    // No token → attributed to the writer DO (kind "do"), chrome bypass off.
    const gateCaller = lastGateCaller();
    expect(gateCaller.runtime.kind).toBe("do");
    expect(isAuthorizedChrome(gateCaller)).toBe(false);
    expect(refs.readMainLog({ repoPath: "packages/a" })[0]?.onBehalfOf).toBeNull();
  });

  it("rejects a forged token at the host (never silently attributes to the DO)", async () => {
    await seedCommit("chat-1", "packages/a", "a.txt", "A\n");
    // Deliver a push whose envelope carries a token the host never minted.
    const objectKey = "workspace-gad";
    const fetchable = gad.instance as unknown as { fetch(r: Request): Promise<Response> };
    const envelope = {
      from: "panel:chat-1",
      target: `do:test:${objectKey}`,
      delivery: { caller: { callerId: "panel:chat-1", callerKind: "panel" } },
      provenance: [],
      message: {
        type: "request",
        requestId: crypto.randomUUID(),
        fromId: "panel:chat-1",
        method: "vcsPush",
        args: [{ repoPaths: ["packages/a"], sourceHead: vcsContextHead("chat-1") }],
        invocationToken: "forged-token-not-in-table",
        callerContextId: "chat-1",
      },
    };
    const res = await fetchable.fetch(
      new Request(`http://test/${objectKey}/__rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(envelope),
      })
    );
    const respEnv = JSON.parse(await res.text()) as { message?: { error?: unknown } };
    expect(String(respEnv.message?.error)).toMatch(/invalid or expired invocation token/);
    // Fail-closed: main never moved, no gate context attributed.
    expect(refs.readMain("packages/a")).toBeNull();
  });

  // Row-12: the HOST-side merge-to-main mint (the piece that was missing — a
  // host-dispatched merge previously carried NO token → DO-attributed). This
  // exercises WorkspaceVcs.mergeIntoMainHead minting for the VERIFIED chrome
  // caller and threading it to the DO's vcsMerge. The DO→refsService resolution
  // of that token is identical to push (proven above).
  describe("chrome merge-to-main attribution (row 12)", () => {
    it("mints + threads an on-behalf-of token for the verified caller, released after", async () => {
      const shell = createVerifiedCaller("shell", "shell");
      let threadedToken: string | undefined;
      let resolvedDuringDispatch: VerifiedCaller | undefined;
      let sizeDuringDispatch = -1;

      // A gad caller that captures the token WorkspaceVcs threads for vcsMerge,
      // resolves it against the REAL table while the dispatch is in flight, and
      // returns up-to-date (no ref write needed to observe attribution wiring).
      const capturingGad: GadCaller = {
        async call<T>(method: string, _input: unknown, opts?: { invocationToken?: string }) {
          if (method === "vcsMerge") {
            threadedToken = opts?.invocationToken;
            if (threadedToken) {
              resolvedDuringDispatch = invocations.resolve(threadedToken)?.caller;
              sizeDuringDispatch = invocations.size();
            }
            return { status: "up-to-date", stateHash: "state:x", upstreamCommits: [] } as T;
          }
          // Delegate everything else (attach bootstrap, etc.) to the real DO.
          return inProcessGadCaller(gad).call<T>(method, _input, opts);
        },
      };
      await vcs.attachGad(capturingGad);

      await vcs.mergeGroup(
        [{ repoPath: "packages/a", sourceHead: vcsContextHead("chat-1"), targetHead: "main" }],
        {
          actor: USER,
          mainAdvance: { kind: "caller", caller: shell, operation: "merge" },
        }
      );

      expect(threadedToken).toBeTruthy();
      expect(resolvedDuringDispatch?.runtime).toEqual({ id: "shell", kind: "shell" });
      expect(sizeDuringDispatch).toBe(1);
      // Released after the dispatch settles (no leak; replay fails closed).
      expect(invocations.size()).toBe(0);
    });

    it("threads NO token when the advance carries no caller-kind context", async () => {
      let threadedToken: string | undefined = "unset";
      const capturingGad: GadCaller = {
        async call<T>(method: string, _input: unknown, opts?: { invocationToken?: string }) {
          if (method === "vcsMerge") {
            threadedToken = opts?.invocationToken;
            return { status: "up-to-date", stateHash: "state:x", upstreamCommits: [] } as T;
          }
          return inProcessGadCaller(gad).call<T>(method, _input, opts);
        },
      };
      await vcs.attachGad(capturingGad);
      await vcs.mergeGroup(
        [{ repoPath: "packages/a", sourceHead: vcsContextHead("chat-1"), targetHead: "main" }],
        { actor: USER }
      );
      expect(threadedToken).toBeUndefined();
      expect(invocations.size()).toBe(0);
    });
  });
});
