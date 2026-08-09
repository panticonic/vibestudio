import { describe, expect, it, vi } from "vitest";
import type { TemplateCompositionPlan } from "./resolver.js";
import type { WorkspaceTemplateLock } from "@vibestudio/workspace-contracts/types";
import {
  assertTemplateLockIntegrityForRead,
  templateLockFingerprint,
} from "@vibestudio/workspace/templateLock";
import {
  applyTemplateOperation,
  inspectTemplateOperation,
  prepareTemplateOperation,
  publishPreparedTemplateOperation,
  rebuildPreparedTemplateOperation,
  templateStatus,
  TemplateBuildGateError,
} from "./operations.js";

const exactRoot = {
  url: "https://github.com/vibestudio/workspace-base.git",
  ref: "refs/tags/v1.0.0",
  commit: "a".repeat(40),
  snapshot: `v1-sha256:${"a".repeat(64)}` as const,
};

describe("template operations", () => {
  it("projects exact unresolved suggestions from the local lock only", () => {
    const digest = `v1-sha256:${"b".repeat(64)}` as const;
    const lock = {
      nodes: [
        {
          nodeId: "t-base",
          alias: "base",
          pin: exactRoot,
          parents: [],
          fragmentDigest: `v1-sha256:${"c".repeat(64)}`,
          suggestions: {
            trust: { digest, value: { chromeApps: ["apps/base"] } },
          },
        },
      ],
    } as unknown as WorkspaceTemplateLock;

    expect(templateStatus([{ url: exactRoot.url }], lock).excludedSuggestions).toEqual([
      {
        nodeId: "t-base",
        alias: "base",
        trust: { chromeApps: ["apps/base"] },
      },
    ]);
    expect(
      templateStatus([{ url: exactRoot.url }], lock, {
        "t-base:trust": { digest, decision: "declined" },
      }).excludedSuggestions
    ).toEqual([]);
  });

  it("represents a workspace with no selected templates as an empty composition", async () => {
    const inspection = await inspectTemplateOperation({
      kind: "recompose",
      workspace: {
        roots: [],
        localRepoPaths: new Set(["panels/chat"]),
        expectedSystemEpoch: 57,
      },
      sources: {
        resolvePromoted: vi.fn(),
        acquire: vi.fn(),
      },
    });

    expect(inspection).toMatchObject({
      kind: "recompose",
      nextTemplates: null,
      plan: {
        rootNodeIds: [],
        nodes: [],
        repositories: {},
        localRepoPaths: ["panels/chat"],
        lock: null,
      },
    });
  });

  it("adopts the bootstrap descriptor exact pin without resolving the root from a registry", async () => {
    const resolvePromoted = vi.fn(async () => {
      throw new Error("registry should not resolve the bootstrap root");
    });
    const manifest = new TextEncoder().encode(
      "systemEpoch: 57\ntrust:\n  chromeApps:\n    - apps/base\n"
    );
    const inspection = await inspectTemplateOperation({
      kind: "adopt-bootstrap",
      descriptor: { version: 1, workspaceId: "example", rootTemplate: exactRoot },
      workspace: {
        localRepoPaths: new Set(["packages/runtime"]),
        expectedSystemEpoch: 57,
      },
      sources: {
        resolvePromoted,
        acquire: async (pin) => ({
          commit: pin.commit,
          snapshot: pin.snapshot,
          files: [
            {
              path: "meta/template.yml",
              contentHash: "a".repeat(64),
              size: manifest.byteLength,
              mode: 0o644,
            },
            {
              path: "packages/runtime/index.ts",
              contentHash: "b".repeat(64),
              size: 1,
              mode: 0o644,
            },
          ],
          readFile: (path) => (path === "meta/template.yml" ? manifest : null),
        }),
      },
    });

    expect(resolvePromoted).not.toHaveBeenCalled();
    expect(inspection.plan.lock?.roots).toEqual([
      { url: "git+https://github.com/vibestudio/workspace-base.git" },
    ]);
    expect(inspection.plan.lock?.nodes[0]?.suggestions.trust).toMatchObject({
      value: { chromeApps: ["apps/base"] },
    });
    const corrupt = structuredClone(inspection.plan.lock!);
    corrupt.nodes[0]!.suggestions.trust!.value = { chromeApps: ["apps/other"] };
    const { fingerprint: _fingerprint, ...withoutFingerprint } = corrupt;
    corrupt.fingerprint = templateLockFingerprint(withoutFingerprint);
    expect(() => assertTemplateLockIntegrityForRead(corrupt)).toThrow(
      "invalid trust suggestion evidence"
    );
    expect(inspection.plan.repositories["packages/runtime"]).toBeDefined();
  });

  it("discards the operation context and never publishes when the build gate fails", async () => {
    const publish = vi.fn();
    const discard = vi.fn(async () => undefined);
    const plan = { repositories: {} } as TemplateCompositionPlan;

    await expect(
      applyTemplateOperation({
        operationId: "op-1",
        expectedMainEventId: "event-1",
        inspection: { kind: "add", plan, nextTemplates: null },
        ports: {
          openContext: async () => ({ contextId: "template-composer-operation-op-1" }),
          stageComposition: async () => ({ affectedRepoPaths: ["panels/news"] }),
          buildAffected: async () => ({
            failures: [{ unit: "panels/news", message: "type error" }],
          }),
          publish,
          discard,
        },
      })
    ).rejects.toBeInstanceOf(TemplateBuildGateError);

    expect(publish).not.toHaveBeenCalled();
    expect(discard).toHaveBeenCalledWith("template-composer-operation-op-1");
  });

  it("retains an interactive failed context so an in-context repair can ship atomically", async () => {
    let repaired = false;
    const discard = vi.fn();
    const publish = vi.fn(async () => ({ mainEventId: "event-2" }));
    const ports = {
      openContext: async () => ({ contextId: "template-composer-operation-op-2" }),
      stageComposition: async () => ({ affectedRepoPaths: ["panels/news"] }),
      buildAffected: async () => ({
        failures: repaired ? [] : [{ unit: "panels/news", message: "type error" }],
      }),
      publish,
      discard,
    };
    const inspection = {
      kind: "add" as const,
      plan: { repositories: {} } as TemplateCompositionPlan,
      nextTemplates: null,
    };

    const failed = await prepareTemplateOperation({
      operationId: "op-2",
      inspection,
      ports,
    });
    expect(failed.status).toBe("build-failed");
    expect(discard).not.toHaveBeenCalled();

    repaired = true;
    const rebuilt = await rebuildPreparedTemplateOperation(failed.prepared, ports);
    expect(rebuilt.status).toBe("ready");
    await publishPreparedTemplateOperation(rebuilt.prepared, "event-1", ports);
    expect(publish).toHaveBeenCalledWith("template-composer-operation-op-2", "event-1");
  });
});
