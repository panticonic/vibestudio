import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";
import { TemplateRepositoryExchangeExecutor } from "./templateRepositoryExchangeExecutor.js";
import type { ExactRepositorySnapshotPlan } from "../vcsHost/workspaceVcs.js";

const roots: string[] = [];
const digest = (character: string): string => character.repeat(64);

function manifest(): string {
  return [
    `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}`,
    "template:",
    "  name: Test",
    "  description: Test template",
    "  repositories:",
    "    - apps/one",
    "  files:",
    "    - package.json",
    "apps:",
    "  - source: apps/one",
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
    await fsp.mkdir(path.join(target, "apps", "one"), { recursive: true });
    await fsp.writeFile(path.join(target, "meta", "template.yml"), manifest());
    await fsp.writeFile(path.join(target, "package.json"), "root\n");
    await fsp.writeFile(path.join(target, "apps", "one", "package.json"), value);
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
  const semanticImport = vi.fn(async (_input: unknown) => imported);
  fs.mkdirSync(path.join(root, "blobs", "tmp"), { recursive: true });
  const executor = new TemplateRepositoryExchangeExecutor({
    root: path.join(root, "operations"),
    blobsDir: path.join(root, "blobs"),
    planSource: async () => sourcePlan,
    materializeSource: async (_plan, destination) => writeTree(destination, semanticValue),
    semantic: { commitChildBase: vi.fn(), importSnapshot: semanticImport },
  });
  return {
    root,
    checkout,
    executor,
    semanticImport,
    setSemantic: (value: string) => (semanticValue = value),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("TemplateRepositoryExchangeExecutor", () => {
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
      ingress: { causalParent: null, contextIntegrity: { class: "internal", externalKeys: [] } },
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
    expect(fs.readFileSync(path.join(fx.checkout, "apps", "one", "package.json"), "utf8")).toBe(
      "semantic\n"
    );
    const receipt = await fx.executor.apply({
      operationId: prepared.plan.operationId,
      intentDigest: prepared.intentDigest,
      checkout: fx.checkout,
      ingress: { causalParent: null, contextIntegrity: { class: "internal", externalKeys: [] } },
    });
    expect(receipt.direction).toBe("export");
    expect(fs.readFileSync(path.join(fx.checkout, "apps", "one", "package.json"), "utf8")).toBe(
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
      ingress: { causalParent: null, contextIntegrity: { class: "internal", externalKeys: [] } },
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
      ingress: { causalParent: null, contextIntegrity: { class: "internal", externalKeys: [] } },
    });
    fs.writeFileSync(path.join(fx.checkout, "apps", "one", "package.json"), "checkout edit\n");
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
      ingress: { causalParent: null, contextIntegrity: { class: "internal", externalKeys: [] } },
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
      ingress: { causalParent: null, contextIntegrity: { class: "internal", externalKeys: [] } },
    });
    expect(replayed).toEqual(receipt);
    expect(fx.semanticImport).toHaveBeenCalledOnce();
    expect(fs.existsSync(path.join(fx.root, "operations", prepared.intentDigest, "semantic"))).toBe(
      false
    );
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
        ingress: { causalParent: null, contextIntegrity: { class: "internal", externalKeys: [] } },
      })
    ).rejects.toMatchObject({ code: "EIDEMPOTENCYDRIFT" });
  });
});
