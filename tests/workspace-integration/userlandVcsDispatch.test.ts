/**
 * P5c — vcs.* userland dispatch through the MANIFEST-SERVICE mechanism.
 *
 * The moved read/history methods (vcsFileHistory / vcsLog / vcsCommitEdits /
 * vcsCommitAncestors / vcsEditsBy*) no longer exist on the host `vcs` service;
 * consumers resolve the `vcs` service declared in workspace/meta/vibez1.yml
 * (workers.resolveService → gad-store DO singleton) and call the DO methods
 * with positional args. This test drives that resolution against the REAL
 * workspace manifest and dispatches the resolved method names against a real
 * in-process GadWorkspaceDO seeded through the full edit→commit flow.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { parseWorkspaceConfigContentWithId } from "@vibez1/shared/workspace/configParser";
import { buildWorkspaceDeclarations } from "@vibez1/shared/workspace/singletonRegistry";
import { VCS_SERVICE_PROTOCOL } from "@vibez1/shared/userlandServiceRpc";
import { vcsMethods } from "@vibez1/shared/serviceSchemas/vcs";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { GadWorkspaceDO } from "../../workspace/workers/gad-store/index.js";
import { resolveUserlandService } from "../../src/server/userlandServices.js";
import { attachLocalHostBridges } from "../../src/server/vcsHost/testSupport.js";
import { WorkspaceVcs } from "../../src/server/vcsHost/workspaceVcs.js";
import { vcsContextHead } from "../../src/server/vcsHost/paths.js";
import type { GadCaller } from "../../src/server/vcsHost/testSupport.js";
import { createRefService } from "../../src/server/services/refService.js";

const REPO = "packages/dispatch-demo";
const CTX = vcsContextHead("disp");
const USER = { id: "user", kind: "user" };

type TestGad = Awaited<ReturnType<typeof createTestDO<GadWorkspaceDO>>>;

function callerFor(gad: TestGad): GadCaller {
  return {
    async call<T>(method: string, input: unknown): Promise<T> {
      const instance = gad.instance as unknown as Record<string, (arg: unknown) => unknown>;
      const fn = instance[method];
      if (typeof fn !== "function") throw new Error(`no such gad method: ${method}`);
      return (await fn.call(gad.instance, input)) as T;
    },
  };
}

/** Dispatch a positional-args DO method by NAME — the shape the userland
 *  service client produces (`rpc.call(targetId, method, args)`). */
function dispatchTo(gad: TestGad) {
  return async <T>(method: string, args: unknown[]): Promise<T> => {
    const instance = gad.instance as unknown as Record<string, (...a: unknown[]) => unknown>;
    const fn = instance[method];
    if (typeof fn !== "function") throw new Error(`vcs userland method missing: ${method}`);
    return (await fn.apply(gad.instance, args)) as T;
  };
}

describe("vcs userland dispatch (manifest service → gad-store DO)", () => {
  it("the workspace manifest declares `vcs` as a DO service on the gad-store singleton", async () => {
    const yml = await fsp.readFile(
      path.resolve(__dirname, "../../workspace/meta/vibez1.yml"),
      "utf8"
    );
    const config = parseWorkspaceConfigContentWithId(yml, "test");
    const decls = buildWorkspaceDeclarations(config);
    for (const query of [VCS_SERVICE_PROTOCOL, "vcs"]) {
      const resolved = resolveUserlandService(decls, query);
      expect(resolved).toMatchObject({
        kind: "durable-object",
        name: "vcs",
        source: "workers/gad-store",
        className: "GadWorkspaceDO",
        objectKey: "workspace-gad",
        targetId: "do:workers/gad-store:GadWorkspaceDO:workspace-gad",
      });
    }
  });

  it("the host vcs service no longer declares the moved read/history methods", () => {
    const hostMethods = new Set(Object.keys(vcsMethods));
    for (const moved of [
      "commitEdits",
      "fileHistory",
      "commitAncestors",
      "editsByActor",
      "editsByTurn",
      "editsByInvocation",
      "log",
      // Publishing is no longer a public host RPC: push dispatches userland to
      // the gad-store DO's vcsPush (runtime VcsClient.push / `vibez1 vcs push`).
      "push",
    ]) {
      expect(hostMethods.has(moved)).toBe(false);
    }
    // The host remnant keeps the operations that need host resources.
    for (const kept of ["forkRepo", "deleteRepo", "restoreRepo", "edit", "commit"]) {
      expect(hostMethods.has(kept)).toBe(true);
    }
  });

  describe("dispatching the moved methods against the real DO", () => {
    let root: string;
    let gad: TestGad;
    let vcs: WorkspaceVcs;
    let call: <T>(method: string, args: unknown[]) => Promise<T>;

    beforeAll(async () => {
      root = await fsp.mkdtemp(path.join(os.tmpdir(), "vcs-dispatch-"));
      const workspaceRoot = path.join(root, "workspace");
      await fsp.mkdir(workspaceRoot);
      gad = await createTestDO(GadWorkspaceDO, { __objectKey: "workspace-gad" });
      const refs = createRefService({ statePath: path.join(root, "refs"), gate: async () => {} });
      attachLocalHostBridges(gad.instance, { blobsDir: path.join(root, "blobs"), refs });
      vcs = new WorkspaceVcs({
        blobsDir: path.join(root, "blobs"),
        workspaceRoot,
        contextsRoot: path.join(root, ".contexts"),
        buildSourcesRoot: path.join(root, "build-sources"),
        refs,
      });
      await vcs.attachGad(callerFor(gad));
      call = dispatchTo(gad);
    });

    afterAll(async () => {
      await fsp.rm(root, { recursive: true, force: true });
    });

    it("serves fileHistory/commitEdits/commitAncestors/editsBy*/log for a real commit", async () => {
      await vcs.recordEdit({
        head: CTX,
        repoPath: REPO,
        actor: USER,
        invocationId: "inv-disp",
        edits: [{ kind: "create", path: "readme.md", content: { kind: "text", text: "# hi\n" } }],
      });
      const committed = await vcs.commit({
        head: CTX,
        repoPath: REPO,
        message: "first",
        actor: USER,
      });
      expect(committed.status).toBe("committed");

      const history = await call<Array<{ path: string; committedEventId: string | null }>>(
        "vcsFileHistory",
        [REPO, "readme.md", CTX]
      );
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        path: "readme.md",
        committedEventId: committed.eventId,
      });

      const owned = await call<Array<{ path: string }>>("vcsCommitEdits", [
        REPO,
        committed.eventId,
      ]);
      expect(owned.map((row) => row.path)).toEqual(["readme.md"]);

      const ancestors = await call<Array<{ eventId: string }>>("vcsCommitAncestors", [
        REPO,
        committed.eventId,
      ]);
      expect(ancestors[0]?.eventId).toBe(committed.eventId);

      const byActor = await call<Array<{ actorId: string | null }>>("vcsEditsByActor", ["user"]);
      expect(byActor.length).toBeGreaterThanOrEqual(1);
      const byInvocation = await call<Array<{ invocationId: string | null }>>(
        "vcsEditsByInvocation",
        ["inv-disp"]
      );
      expect(byInvocation).toHaveLength(1);

      const log = await call<Array<{ summary: string | null; outputStateHash: string | null }>>(
        "vcsLog",
        [REPO, 10, CTX]
      );
      expect(log[0]).toMatchObject({ summary: "first", outputStateHash: committed.stateHash });
    });
  });
});
