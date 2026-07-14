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
 *   → REAL ProtectedRefStore gated CAS (gateContext observed at the approval gate).
 *
 * REAL vs STUBBED (see report):
 *   REAL   — VcsInvocationTable (mint/resolve/release), refsService handler
 *            (policy + token resolution + gateContext construction), ProtectedRefStore
 *            (CAS + gate), GadWorkspaceDO push/merge orchestration, the DO base's
 *            read-at-entry invocationToken/callerContextId binding (driven via a
 *            real `__rpc` envelope), the content store, and exact originating
 *            principal attribution at the approval boundary.
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

import {
  createTestDO,
  createTestDirectAuthority,
} from "@workspace/runtime/worker/test-utils";
import { GadWorkspaceDO } from "../../workspace/workers/gad-store/index.js";
import { attachLocalHostBridges } from "../../src/server/vcsHost/testSupport.js";
import { WorkspaceVcs } from "../../src/server/vcsHost/workspaceVcs.js";
import { vcsContextHead } from "../../src/server/vcsHost/paths.js";
import type { GadCaller } from "../../src/server/vcsHost/testSupport.js";
import { createProtectedRefStore, type RefGateBatch } from "../../src/server/services/protectedRefStore.js";
import { createRefsRpcService } from "../../src/server/services/refsRpcService.js";
import { VcsInvocationTable } from "../../src/server/services/vcsInvocationTable.js";
import {
  createHostCaller,
  createVerifiedCaller,
  type ServiceDispatcher,
  type VerifiedCaller,
} from "@vibestudio/shared/serviceDispatcher";
import { createTestServiceDispatcher } from "@vibestudio/shared/serviceDispatcherTestUtils";
import type { RefAdvanceGateContext } from "../../src/server/services/mainAdvanceApproval.js";

const USER = { id: "user", kind: "user" };
const WRITER_ID = "do:workers/gad-store:GadWorkspaceDO:workspace-gad";
type TestGad = Awaited<ReturnType<typeof createTestDO<GadWorkspaceDO>>>;

function inProcessGadCaller(gad: TestGad): GadCaller {
  return {
    async call<T>(method: string, input: unknown): Promise<T> {
      // WorkspaceVcs is a host-owned bridge. Exercise the normal DO dispatch
      // path so the call carries the product host principal; direct method
      // calls would be deliberately unattributed and must fail closed.
      return await gad.call<T>(method, input);
    },
  };
}

describe("full-gateway attribution (row 11)", () => {
  let root: string;
  let gad: TestGad;
  let vcs: WorkspaceVcs;
  let refs: ReturnType<typeof createProtectedRefStore>;
  let invocations: VcsInvocationTable;
  let refsService: ReturnType<typeof createRefsRpcService>;
  let refsDispatcher: ServiceDispatcher;
  let gateBatches: RefGateBatch[];

  /** The REAL refs bridge: the DO's `refsStore().updateMains` routes through the
   *  REAL refsService handler, authenticated as the writer DO — so the
   *  single-writer policy + on-behalf-of token resolution are genuinely
   *  exercised (not the doVcsPush stub, which bypasses that layer). */
  function installRealRefsBridge(): void {
    const writer = createVerifiedCaller(WRITER_ID, "do", {
      callerId: WRITER_ID,
      callerKind: "do",
      repoPath: "workers/gad-store",
      executionDigest: "d".repeat(64),
      requested: [
        {
          capability: "service:refs.updateMains",
          resource: { kind: "prefix", prefix: "" },
        },
      ],
    });
    const bridge = {
      async readMain(repoPath: string) {
        const r = refs.readMain(repoPath);
        return r ? { stateHash: r.stateHash } : null;
      },
      async listMains() {
        return refs.listMains().map((r) => ({ repoPath: r.repoPath, stateHash: r.stateHash }));
      },
      // The real host records a main-ref movement log (§2), but this stub only
      // exercises updateMains ATTRIBUTION; the DO consults `listMainRefLog` only
      // via optional chaining, so the bridge omits it and the DO falls back to
      // current-value comparison.
      async updateMains(input: {
        entries: Array<{ repoPath: string; expectedOld: string | null; next: string | null }>;
        operation: "push" | "import" | "delete" | "restore" | "seed";
        reason?: string;
        invocationToken?: string;
      }) {
        // The production RPC hop: the DO calls refs.updateMains; the host
        // resolves attribution from the token in the refsService handler.
        return (await refsDispatcher.dispatch(
          { caller: writer },
          "refs",
          "updateMains",
          [input]
        )) as {
          updated: Array<{ repoPath: string; stateHash: string | null }>;
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
    refs = createProtectedRefStore({
      statePath: path.join(root, "refs"),
      gate: async (batch) => {
        gateBatches.push(batch);
      },
    });
    invocations = new VcsInvocationTable();
    refsService = createRefsRpcService({
      refs,
      invocations,
      getVcsWriterIdentity: () => WRITER_ID,
    });
    refsDispatcher = createTestServiceDispatcher();
    refsDispatcher.registerService(refsService);
    refsDispatcher.markInitialized();
    // contentStore + buildStore from the shared bridge; refsStore overridden below.
    attachLocalHostBridges(gad.instance, { blobsDir: path.join(root, "blobs"), refs });
    installRealRefsBridge();
    vcs = new WorkspaceVcs({
      workspaceId: "test-ws",
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
        });
    try {
      const objectKey = "workspace-gad";
      const fetchable = gad.instance as unknown as { fetch(r: Request): Promise<Response> };
      const envelope = {
        from: opts.caller.runtime.id,
        target: `do:test:${objectKey}`,
        delivery: {
          caller: {
            callerId: opts.caller.runtime.id,
            callerKind: opts.caller.runtime.kind,
            authorization: createTestDirectAuthority({
              callerKind:
                opts.caller.hostOriginated || opts.noToken ? "server" : opts.caller.runtime.kind,
              source: "test",
              className: "TestDO",
              objectKey,
              method: "vcsPush",
            }),
          },
        },
        provenance: [],
        message: {
          type: "request",
          requestId: crypto.randomUUID(),
          fromId: opts.caller.runtime.id,
          method: "vcsPush",
          // Userland provenance is derived from the verified envelope caller;
          // only privileged host/DO-internal paths may supply an explicit actor.
          args: [opts.input],
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

  it("attributes a panel-originated push to the exact panel principal", async () => {
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
    // host from the token. A runtime label alone carries no host authority.
    const gateCaller = lastGateCaller();
    expect(gateCaller.runtime).toEqual({ id: "chat-1", kind: "panel" });
    expect(gateCaller.hostOriginated).toBeUndefined();
    // Phase 5: the host ref movement LOG is gone; on-behalf-of attribution now
    // rides the invocation token, resolved at the gate (asserted above) and
    // recorded DO-side. The token window closed after the dispatch (replay
    // fails closed).
    expect(invocations.size()).toBe(0);
  });

  it("preserves a genuine host origin through the invocation token", async () => {
    const shell = createHostCaller("shell", "shell");
    await seedCommit("chat-1", "packages/a", "a.txt", "A\n");

    const result = await relayPush({
      caller: shell,
      // A host operation has no context registration; it pushes another head.
      input: { repoPaths: ["packages/a"], sourceHead: vcsContextHead("chat-1") },
    });
    expect(result.status).toBe("pushed");
    const gateCaller = lastGateCaller();
    expect(gateCaller.runtime).toEqual({ id: "shell", kind: "shell" });
    expect(gateCaller.hostOriginated).toBe(true);
  });

  it("a DO-self push without a token attributes to the DO itself", async () => {
    await seedCommit("chat-1", "packages/a", "a.txt", "A\n");
    const result = await relayPush({
      caller: createVerifiedCaller(WRITER_ID, "do"),
      noToken: true,
      input: { repoPaths: ["packages/a"], sourceHead: vcsContextHead("chat-1") },
    });
    expect(result.status).toBe("pushed");
    // No token means the writer DO is the sole originating principal.
    const gateCaller = lastGateCaller();
    expect(gateCaller.runtime.kind).toBe("do");
    expect(gateCaller.hostOriginated).toBeUndefined();
  });

  it("rejects a forged token at the host (never silently attributes to the DO)", async () => {
    await seedCommit("chat-1", "packages/a", "a.txt", "A\n");
    // Deliver a push whose envelope carries a token the host never minted.
    const objectKey = "workspace-gad";
    const fetchable = gad.instance as unknown as { fetch(r: Request): Promise<Response> };
    const envelope = {
      from: "panel:chat-1",
      target: `do:test:${objectKey}`,
      delivery: {
        caller: {
          callerId: "panel:chat-1",
          callerKind: "panel",
          authorization: createTestDirectAuthority({
            callerKind: "panel",
            source: "test",
            className: "TestDO",
            objectKey,
            method: "vcsPush",
          }),
        },
      },
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
});
