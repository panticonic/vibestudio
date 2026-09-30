import { describe, expect, it, vi } from "vitest";
import {
  authorityDependencyIndexFromDeclarations,
  authorityDependencyIndexFromFacts,
  changedAuthorityQueries,
} from "./authorityDependencyIndex.js";

describe("authority dependency index completeness", () => {
  it("builds consumer query edges from manifests without analyzer facts", async () => {
    const result = await authorityDependencyIndexFromDeclarations({
      stateHash: "state:declared",
      epoch: { analyzerVersion: "analyzer:v1", rpcSchemaVersion: "schema:v1" },
      consumers: [
        {
          unitName: "@workspace-panels/notes",
          effectiveVersion: "ev:notes-panel",
          serviceRequests: [
            { protocol: "example.notes.v1", availability: "required" },
            { protocol: "example.search.v1", availability: "optional" },
          ],
        },
      ],
      environment: {
        stateHash: "state:declared",
        services: [],
        digest: "environment:none",
        async resolveService(query: string) {
          return { kind: "missing" as const, query };
        },
      },
    });

    expect(result.consumersByQuery.get("example.notes.v1")).toEqual(
      new Set(["@workspace-panels/notes"])
    );
    expect(result.consumersByQuery.get("example.search.v1")).toEqual(
      new Set(["@workspace-panels/notes"])
    );
    expect(result.blockingConsumers).toEqual(new Set(["@workspace-panels/notes"]));
  });

  it("marks an index incomplete when any consumer blocked local analysis", async () => {
    const result = await authorityDependencyIndexFromFacts({
      stateHash: "state:blocked",
      epoch: { analyzerVersion: "analyzer:v1", rpcSchemaVersion: "schema:v1" },
      consumers: [],
      environment: {
        stateHash: "state:blocked",
        services: [],
        digest: "environment:none",
        async resolveService(query: string) {
          return { kind: "missing" as const, query };
        },
      },
      blockingConsumers: new Set(["@workspace-panels/broken"]),
    });

    expect(result.complete).toBe(false);
    expect(result.blockingConsumers).toEqual(new Set(["@workspace-panels/broken"]));
  });

  it("resolves one catalog for a service name and all of its protocol aliases", async () => {
    const binding = {
      name: "gad.workspace",
      protocols: ["vibestudio.workspace-source.v1", "vibestudio.gad.workspace.v1"],
      source: "workers/workspace-source",
      action: "manage workspace source",
      presentation: { domain: "automation" as const, verb: "manage" as const },
      principals: ["code" as const],
      target: {
        kind: "durable-object" as const,
        className: "GadWorkspaceDO",
        defaultObjectKey: "workspace",
      },
    };
    const resolveService = vi.fn(async (_query: string) => ({
      kind: "resolved" as const,
      service: {
        stateHash: "state:aliases",
        binding,
        catalog: {
          provider: {
            unitName: "@workspace-workers/workspace-source",
            source: binding.source,
            effectiveVersion: "ev:workspace-source",
            className: "GadWorkspaceDO",
          },
          methods: new Map(),
          digest: "catalog:workspace-source",
        },
      },
    }));

    const result = await authorityDependencyIndexFromFacts({
      stateHash: "state:aliases",
      epoch: { analyzerVersion: "analyzer:v1", rpcSchemaVersion: "schema:v1" },
      consumers: [],
      environment: {
        stateHash: "state:aliases",
        services: [binding],
        digest: "environment:aliases",
        resolveService,
      },
    });

    expect(resolveService).toHaveBeenCalledOnce();
    expect(resolveService).toHaveBeenCalledWith("gad.workspace");
    expect(result.providersByQuery).toEqual(
      new Map(
        [binding.name, ...binding.protocols].map((query) => [
          query,
          {
            providerUnit: "workers/workspace-source",
            resolutionDigest: expect.any(String),
          },
        ])
      )
    );
    const retargetedBinding = {
      ...binding,
      target: { ...binding.target, defaultObjectKey: "another-workspace" },
    };
    const retargeted = await authorityDependencyIndexFromFacts({
      stateHash: "state:retargeted",
      epoch: result.epoch,
      consumers: [],
      environment: {
        stateHash: "state:retargeted",
        digest: "environment:retargeted",
        services: [retargetedBinding],
        async resolveService(query) {
          const previous = await resolveService(query);
          return { ...previous, service: { ...previous.service, binding: retargetedBinding } };
        },
      },
    });
    expect(changedAuthorityQueries(result, retargeted)).toEqual(
      new Set([binding.name, ...binding.protocols])
    );
  });

  it("selects only changed query resolutions, including new and removed aliases", async () => {
    const empty = await authorityDependencyIndexFromFacts({
      stateHash: "state:empty",
      epoch: { analyzerVersion: "a", rpcSchemaVersion: "s" },
      consumers: [],
      environment: {
        stateHash: "state:empty",
        digest: "empty",
        services: [],
        async resolveService(query) {
          return { kind: "missing", query };
        },
      },
    });
    const before = {
      ...empty,
      providersByQuery: new Map([
        ["unchanged", { providerUnit: "workers/common", resolutionDigest: "same" }],
        ["removed", { providerUnit: "workers/old", resolutionDigest: "old" }],
        ["retargeted", { providerUnit: "workers/common", resolutionDigest: "old-target" }],
      ]),
    };
    const after = {
      ...empty,
      providersByQuery: new Map([
        ["unchanged", { providerUnit: "workers/common", resolutionDigest: "same" }],
        ["added", { providerUnit: "workers/new", resolutionDigest: "new" }],
        ["retargeted", { providerUnit: "workers/common", resolutionDigest: "new-target" }],
      ]),
    };
    expect(changedAuthorityQueries(before, after)).toEqual(
      new Set(["removed", "retargeted", "added"])
    );
  });
});
