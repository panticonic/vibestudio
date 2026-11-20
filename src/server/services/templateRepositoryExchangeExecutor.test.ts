import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";
import { TemplateRepositoryExchangeExecutor } from "./templateRepositoryExchangeExecutor.js";
import type { ExactRepositorySnapshotPlan } from "../vcsHost/workspaceVcs.js";
import { createVerifiedCaller, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { hasBlobUploads, privateWorkspaceBlobScopes } from "../storage/blobUploads.js";
import type { NativeDevelopmentSemanticAdapter } from "./nativeDevelopmentExecutor.js";

const roots: string[] = [];
const digest = (character: string): string => character.repeat(64);

function manifest(): string {
  return [
    `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}`,
    "template:",
    "  name: Test",
    "  description: Test template",

    "clients:",
    "  - source: clients/one",
    "",
  ].join("\n");
}

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-template-exchange-"));
  roots.push(root);
  const checkout = path.join(root, "checkout");
  fs.mkdirSync(path.join(checkout, ".git"), { recursive: true });
  const writeTree = async (target: string, value: string) => {
    await fsp.mkdir(path.join(target, "meta"), { recursive: true });
    await fsp.mkdir(path.join(target, "clients", "one"), { recursive: true });
    await fsp.writeFile(path.join(target, "meta", "vibestudio.yml"), manifest());
    await fsp.writeFile(path.join(target, "package.json"), "root\n");
    await fsp.writeFile(path.join(target, "clients", "one", "package.json"), value);
  };
  await writeTree(checkout, "semantic\n");
  let semanticValue = "semantic\n";
  const sourcePlan = {
    version: 1,
    contextId: "context",
    repositoryId: "repository",
    repoPath: "projects/base",
    sourceState: { kind: "event", eventId: "event" },
    contentRoot: `state:${digest("a")}`,
    repositoryManifestDigest: digest("b"),
    materializedTreeDigest: digest("c"),
    requiredFiles: [],
    realization: {} as ExactRepositorySnapshotPlan["realization"],
    planDigest: digest("d"),
  } satisfies ExactRepositorySnapshotPlan;
  const imported = {
    contextId: "context",
    event: { kind: "event", eventId: "imported" },
    application: { kind: "application", applicationId: "application" },
    workUnitId: "work-unit",
    importedRepositoryIds: ["repository"],
    externalSnapshot: {
      sourceKind: "filesystem",
      sourceUri: "uri",
      snapshotRevision: "revision",
      targetRepositoryIds: ["repository"],
    },
  } as never;
  const semanticImport = vi.fn(async (_input: Parameters<NativeDevelopmentSemanticAdapter["importSnapshot"]>[0]) => imported);
  const materializeSource = vi.fn(async (_plan: ExactRepositorySnapshotPlan, destination: string) =>
    writeTree(destination, semanticValue));
  fs.mkdirSync(path.join(root, "blobs", "tmp"), { recursive: true });
  const executor = new TemplateRepositoryExchangeExecutor({
    root: path.join(root, "operations"),
    blobsDir: path.join(root, "blobs"),
    planSource: async () => sourcePlan,
    materializeSource,
    resolveAccess: async (contextId, ctx) => ({ caller: ctx.caller, ownerContextId: contextId }),
    semantic: { commitChildBase: vi.fn(), importSnapshot: semanticImport },
  });
  const ctx = {
    caller: createVerifiedCaller("shell:template-owner", "shell", null, null, {
      userId: "user:template-owner", handle: "template-owner",
    }),
  };
  return {
    root,
    checkout,
    executor: {
      prepare: (input: Parameters<typeof executor.prepare>[0], caller: ServiceContext = ctx) => executor.prepare(input, caller),
      apply: (input: Parameters<typeof executor.apply>[0], caller: ServiceContext = ctx) => executor.apply(input, caller),
    },
    semanticImport,
    materializeSource,
    setSemantic: (value: string) => (semanticValue = value),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("TemplateRepositoryExchangeExecutor", () => {
  it.each(["import", "export"] as const)(
    "refuses to prepare an %s against a different working revision",
    async (direction) => {
      const fx = await fixture();
      await expect(fx.executor.prepare({
        direction,
        checkout: fx.checkout,
        contextId: "context",
        repositoryId: "repository",
        expectedWorkingHead: { kind: "application", applicationId: "other-working-revision" },
        idempotencyKey: "changed-basis",
      })).rejects.toMatchObject({ code: "EREVISIONCHANGED" });
      expect(fx.materializeSource).not.toHaveBeenCalled();
      expect(fx.semanticImport).not.toHaveBeenCalled();
      expect(await fsp.readdir(path.join(fx.root, "operations"))).toEqual([]);
      expect(await fsp.readFile(path.join(fx.checkout, "clients", "one", "package.json"), "utf8"))
        .toBe("semantic\n");
    },
  );

  it("replays an exact terminal export receipt after a lost response and cleans source bytes", async () => {
    const fx = await fixture();
    const baseline = await fx.executor.prepare({
      direction: "export",
      checkout: fx.checkout,
      contextId: "context",
      repositoryId: "repository",
      expectedWorkingHead: { kind: "event", eventId: "event" },
      idempotencyKey: "baseline",
    });
    await fx.executor.apply({
      operationId: baseline.plan.operationId,
      intentDigest: baseline.intentDigest,
      checkout: fx.checkout,
      ingress: { causalParent: null },
    });
    fx.setSemantic("semantic update\n");
    const prepared = await fx.executor.prepare({
      direction: "export",
      checkout: fx.checkout,
      contextId: "context",
      repositoryId: "repository",
      expectedWorkingHead: { kind: "event", eventId: "event" },
      idempotencyKey: "export",
    });
    expect(fs.readFileSync(path.join(fx.checkout, "clients", "one", "package.json"), "utf8")).toBe(
      "semantic\n"
    );
    const receipt = await fx.executor.apply({
      operationId: prepared.plan.operationId,
      intentDigest: prepared.intentDigest,
      checkout: fx.checkout,
      ingress: { causalParent: null },
    });
    expect(receipt.direction).toBe("export");
    expect(fs.readFileSync(path.join(fx.checkout, "clients", "one", "package.json"), "utf8")).toBe(
      "semantic update\n"
    );
    expect(fs.existsSync(path.join(fx.root, "operations", prepared.intentDigest))).toBe(true);
    expect(fs.existsSync(path.join(fx.root, "operations", prepared.intentDigest, "semantic"))).toBe(
      false
    );
    const replayed = await fx.executor.apply({
      operationId: prepared.plan.operationId,
      intentDigest: prepared.intentDigest,
      checkout: fx.checkout,
      ingress: { causalParent: null },
    });
    expect(replayed).toEqual(receipt);
  });

  it("replays an exact terminal import receipt after a lost response without reimporting", async () => {
    const fx = await fixture();
    const baseline = await fx.executor.prepare({
      direction: "export",
      checkout: fx.checkout,
      contextId: "context",
      repositoryId: "repository",
      expectedWorkingHead: { kind: "event", eventId: "event" },
      idempotencyKey: "baseline",
    });
    await fx.executor.apply({
      operationId: baseline.plan.operationId,
      intentDigest: baseline.intentDigest,
      checkout: fx.checkout,
      ingress: { causalParent: null },
    });
    fs.writeFileSync(path.join(fx.checkout, "clients", "one", "package.json"), "checkout edit\n");
    const prepared = await fx.executor.prepare({
      direction: "import",
      checkout: fx.checkout,
      contextId: "context",
      repositoryId: "repository",
      expectedWorkingHead: { kind: "event", eventId: "event" },
      idempotencyKey: "import",
    });
    const receipt = await fx.executor.apply({
      operationId: prepared.plan.operationId,
      intentDigest: prepared.intentDigest,
      checkout: fx.checkout,
      ingress: { causalParent: null },
    });
    expect(receipt.direction).toBe("import");
    expect(fx.semanticImport).toHaveBeenCalledOnce();
    expect(fx.semanticImport.mock.calls[0]?.[0]).toMatchObject({
      developmentContextId: "context",
      repositoryId: "repository",
      expectedWorkingHead: { kind: "event", eventId: "event" },
    });
    const replayed = await fx.executor.apply({
      operationId: prepared.plan.operationId,
      intentDigest: prepared.intentDigest,
      checkout: fx.checkout,
      ingress: { causalParent: null },
    });
    expect(replayed).toEqual(receipt);
    expect(fx.semanticImport).toHaveBeenCalledOnce();
    expect(fs.existsSync(path.join(fx.root, "operations", prepared.intentDigest, "semantic"))).toBe(
      false
    );
  });

  it("accepts a private import only for the participant who prepared it", async () => {
    const fx = await fixture();
    const context = (id: string, grant: string) => ({
      caller: { ...createVerifiedCaller(id, "shell"), taskAuthority: `task:${grant.repeat(64)}` as const },
    }) as ServiceContext;
    const alice = context("shell:alice", "a");
    const bob = context("shell:bob", "b");
    const basis = {
      checkout: fx.checkout,
      contextId: "context",
      repositoryId: "repository",
      expectedWorkingHead: { kind: "event", eventId: "event" } as const,
    };
    const baselined = await fx.executor.prepare({ ...basis, direction: "export", idempotencyKey: "baseline" }, alice);
    const apply = (prepared: typeof baselined, ctx: ServiceContext) => fx.executor.apply({
      operationId: prepared.plan.operationId, intentDigest: prepared.intentDigest,
      checkout: fx.checkout, ingress: { causalParent: null },
    }, ctx);
    await apply(baselined, alice);
    await fsp.writeFile(path.join(fx.checkout, "clients", "one", "package.json"), "private import\n");
    const prepared = await fx.executor.prepare({ ...basis, direction: "import", idempotencyKey: "private" }, alice);
    await expect(apply(prepared, bob)).rejects.toMatchObject({ code: "EACCES" });
    expect(fx.semanticImport).not.toHaveBeenCalled();
    const result = await apply(prepared, alice);
    expect(result.direction).toBe("import");
    const request = fx.semanticImport.mock.calls[0]![0];
    const principal = request.ingress.participant!.uploadPrincipal;
    expect(request.ingress.participant?.access.caller).toBe(alice.caller);
    const digests = [...new Set(request.descriptor.files.map(({ contentHash }) => contentHash))];
    const blobsDir = path.join(fx.root, "blobs");
    expect(hasBlobUploads(blobsDir, principal, digests)).toBe(true);
    expect(privateWorkspaceBlobScopes(blobsDir, digests).size).toBe(digests.length);
    await expect(apply(prepared, bob)).rejects.toMatchObject({ code: "EACCES" });
    await expect(apply(prepared, alice)).resolves.toEqual(result);
    expect(fx.semanticImport).toHaveBeenCalledOnce();
  });

  it("rejects apply against a different checkout coordinate", async () => {
    const fx = await fixture();
    const prepared = await fx.executor.prepare({
      direction: "export",
      checkout: fx.checkout,
      contextId: "context",
      repositoryId: "repository",
      expectedWorkingHead: { kind: "event", eventId: "event" },
      idempotencyKey: "wrong-checkout",
    });
    const other = path.join(fx.root, "other");
    fs.cpSync(fx.checkout, other, { recursive: true });
    await expect(
      fx.executor.apply({
        operationId: prepared.plan.operationId,
        intentDigest: prepared.intentDigest,
        checkout: other,
        ingress: { causalParent: null },
      })
    ).rejects.toMatchObject({ code: "EIDEMPOTENCYDRIFT" });
  });
});
