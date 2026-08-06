import { describe, expect, it, vi } from "vitest";
import { authorityDependencyIndexFromFacts } from "./authorityDependencyIndex.js";

describe("authority dependency index completeness", () => {
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
            catalogDigest: "catalog:workspace-source",
          },
        ])
      )
    );
  });
});
