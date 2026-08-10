import { describe, expect, it, vi } from "vitest";
import { composeWorkspaceConfig } from "@vibestudio/workspace/configComposition";
import type { WorkspaceTemplatePin } from "@vibestudio/workspace-contracts/types";
import { TemplateRegistryUnavailableError } from "@workspace/template-registry";
import type {
  TemplateOperationInspection,
  TemplateSourcePorts,
} from "@workspace/template-composer";
import { ensureTemplateOperationIntent } from "./operationRecord.js";
import { createPinnedTemplateSourcePorts } from "./source.js";
import { affectedRepositoryPaths, type TemplateOperationRecord } from "./staging.js";
import {
  bootstrapNeedsAdoption,
  cancelTemplateOperation,
  loadTemplateCatalog,
  mergeAcceptedTemplateSuggestion,
  operationReviewForTemplate,
  selectedTemplateName,
} from "./index.js";
import { bootstrapWorkspaceSource, projectBootstrapRuntimeToSource } from "./workspace.js";

const oldPin: WorkspaceTemplatePin = {
  url: "git+https://example.test/template.git",
  ref: "refs/tags/v1",
  commit: "1".repeat(40),
  snapshot: `v1-sha256:${"a".repeat(64)}`,
};

const refreshedPin: WorkspaceTemplatePin = {
  ...oldPin,
  ref: "refs/tags/v2",
  commit: "2".repeat(40),
  snapshot: `v1-sha256:${"b".repeat(64)}`,
};

function inspection(): TemplateOperationInspection {
  return {
    kind: "pull",
    nextTemplates: null,
    plan: {
      version: 1,
      fingerprint: `v1-sha256:${"c".repeat(64)}`,
      rootNodeIds: [],
      nodes: [
        {
          nodeId: "t-old",
          alias: "template",
          pin: oldPin,
          parents: [],
          fragment: { systemEpoch: 57 },
          fragmentYaml: "{}\n",
          fragmentDigest: `v1-sha256:${"d".repeat(64)}`,
          excludedSuggestions: {},
        },
      ],
      repositories: {},
      localRepoPaths: [],
      lock: null,
      artifacts: [],
      removedArtifactPaths: [],
    },
  };
}

function approvedRecord(): TemplateOperationRecord {
  return {
    version: 1,
    operationId: "pull-1",
    kind: "pull",
    fingerprint: inspection().plan.fingerprint,
    intent: { kind: "pull", target: oldPin },
    pins: [oldPin],
    affectedParts: [],
  };
}

describe("template composer operation resumption", () => {
  it("names a direct add after its selected root rather than a sorted dependency", () => {
    const basePin = { ...oldPin, url: "git+https://example.test/base.git" };
    const selectedPin = { ...refreshedPin, url: "git+https://example.test/google.git" };
    expect(
      selectedTemplateName({
        pin: selectedPin,
        fingerprint: `v1-sha256:${"f".repeat(64)}`,
        roots: ["t-google"],
        templates: [
          { nodeId: "t-base", alias: "base", url: basePin.url, commit: basePin.commit },
          {
            nodeId: "t-google",
            alias: "google-workspace",
            url: selectedPin.url,
            commit: selectedPin.commit,
          },
        ],
        affectedParts: [],
        excludedSuggestions: [],
      })
    ).toBe("google-workspace");
  });

  it("discards the exact in-flight context", async () => {
    const publishCancellation = vi.fn(async () => undefined);
    const destroy = vi.fn(async () => undefined);
    await expect(
      cancelTemplateOperation({
        operationId: "pull-1",
        findContext: async () => ({
          contextId: "template-composer-operation-exact",
          applied: false,
          mainEventId: "event-main",
        }),
        publishCancellation,
        destroy,
      })
    ).resolves.toEqual({ operationId: "pull-1", state: "cancelled" });
    expect(publishCancellation).toHaveBeenCalledWith("event-main");
    expect(destroy).toHaveBeenCalledWith("template-composer-operation-exact");
  });

  it("treats a repeated cancellation as idempotently complete", async () => {
    const publishCancellation = vi.fn();
    const destroy = vi.fn();
    await expect(
      cancelTemplateOperation({
        operationId: "pull-1",
        findContext: async () => null,
        publishCancellation,
        destroy,
      })
    ).resolves.toEqual({ operationId: "pull-1", state: "cancelled" });
    expect(publishCancellation).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  });

  it("does not report cancellation when publication wins the protected-main race", async () => {
    let applied = false;
    const destroy = vi.fn();
    await expect(
      cancelTemplateOperation({
        operationId: "pull-1",
        findContext: async () => ({
          contextId: "template-composer-operation-exact",
          applied,
          mainEventId: applied ? "event-applied" : "event-main",
        }),
        publishCancellation: async () => {
          applied = true;
          throw new Error("Protected main changed");
        },
        destroy,
      })
    ).rejects.toThrow("already applied");
    expect(destroy).not.toHaveBeenCalled();
  });

  it("joins an exact pending review back onto its installed template", () => {
    const record = {
      ...approvedRecord(),
      intent: { kind: "pull", alias: "template", target: refreshedPin },
      reviews: [{ repoPath: "panels/news", deltaId: "delta:news" }],
    };
    expect(
      operationReviewForTemplate([{ contextId: "template-composer-operation-pull", record }], {
        alias: "template",
        pin: oldPin,
      })
    ).toEqual({
      contextId: "template-composer-operation-pull",
      record,
    });
  });

  it("keeps registry-independent operations usable without a cached catalog", async () => {
    const client = {
      catalog: vi.fn(async () => {
        throw new TemplateRegistryUnavailableError();
      }),
      refresh: vi.fn(),
    };

    await expect(loadTemplateCatalog(client)).resolves.toBeUndefined();
    await expect(loadTemplateCatalog(client, { requireCatalog: true })).rejects.toThrow(
      TemplateRegistryUnavailableError
    );
    expect(client.refresh).not.toHaveBeenCalled();
  });

  it("retains exact context intent on resume", async () => {
    const persist = vi.fn(async () => undefined);
    await expect(
      ensureTemplateOperationIntent({
        operationId: "pull-1",
        inspection: inspection(),
        intent: { kind: "pull", target: oldPin },
        existing: approvedRecord(),
        affectedParts: [],
        persist,
      })
    ).resolves.toMatchObject({ resumed: true });
    expect(persist).not.toHaveBeenCalled();
  });

  it("keeps every exact in-flight pin when the registry refreshes", async () => {
    const fallback = vi.fn(async () => refreshedPin);
    const base: TemplateSourcePorts = {
      resolvePromoted: fallback,
      acquire: vi.fn(),
    };
    const pinned = createPinnedTemplateSourcePorts(base, approvedRecord().pins);
    await expect(pinned.resolvePromoted({ url: oldPin.url })).resolves.toEqual(oldPin);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("includes every merged contribution in the affected build set", () => {
    expect(affectedRepositoryPaths(["panels/news", "packages/shared"])).toEqual([
      "packages/shared",
      "panels/news",
    ]);
  });

  it("merges accepted exact trust suggestions without replacing existing grants", () => {
    expect(
      mergeAcceptedTemplateSuggestion(
        {
          systemEpoch: 57,
          trust: { chromeApps: ["apps/shell"] },
        },
        "trust",
        { chromeApps: ["apps/integration"] }
      ).trust
    ).toEqual({ chromeApps: ["apps/shell", "apps/integration"] });
  });

  it("never resurrects a removed bootstrap root after durable adoption", () => {
    expect(
      bootstrapNeedsAdoption({
        roots: [],
        top: {
          systemEpoch: 57,
          templates: { use: [], bootstrapAdopted: oldPin },
        },
      })
    ).toBe(false);
  });

  it("preserves workspace-owned authority while a bootstrap runtime becomes composed", () => {
    const runtime = {
      systemEpoch: 57,
      defaultRepo: "projects/default",
      extensions: [{ source: "extensions/template-composer" }],
      providers: {
        evalEngine: { source: "@workspace/eval" },
      },
      trust: { chromeApps: ["apps/shell"] },
    };
    const source = bootstrapWorkspaceSource(runtime);
    const composed = composeWorkspaceConfig(
      source,
      [
        {
          nodeId: "t-base",
          alias: "base",
          ancestors: [],
          config: {
            systemEpoch: 57,
            defaultRepo: runtime.defaultRepo,
            extensions: runtime.extensions,
          },
        },
      ],
      "workspace-1"
    );
    const { id: _id, ...flattened } = composed;
    expect(flattened).toEqual(runtime);
  });

  it("projects pre-adoption runtime edits over the exact bootstrap fragment", () => {
    const runtime = {
      systemEpoch: 57,
      defaultRepo: "projects/locally-selected",
      extensions: [{ source: "extensions/template-composer" }, { source: "extensions/local-tool" }],
      providers: { evalEngine: { source: "@workspace/eval" } },
      trust: { chromeApps: ["apps/shell"] },
    };
    const nodes = [
      {
        nodeId: "t-base",
        alias: "base",
        parents: [],
        fragment: {
          systemEpoch: 57,
          defaultRepo: "projects/default",
          extensions: [{ source: "extensions/template-composer" }],
        },
      },
    ];
    const source = projectBootstrapRuntimeToSource(runtime, nodes, "workspace-1");
    const composed = composeWorkspaceConfig(
      source,
      [{ ...nodes[0]!, ancestors: [], config: nodes[0]!.fragment }],
      "workspace-1"
    );
    const { id: _id, ...flattened } = composed;
    expect(flattened).toEqual(runtime);
  });
});
