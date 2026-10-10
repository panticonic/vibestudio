import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PackageManifest } from "@vibestudio/shared/types";
import type { GraphNode, PackageGraph } from "./packageGraph.js";
import { directorySourceProvider } from "./buildSource.js";
import {
  createExactWorkspaceAuthorityEnvironment,
  resolveProviderCatalog,
  resolveProviderRpcCatalog,
  type ExactWorkspaceServiceBinding,
} from "./userlandAuthority.js";

import { WorkspaceRpcCatalogWorkerClient } from "./workspaceRpcCatalogWorkerClient.js";

const ownedRoots = new Set<string>();
let catalogWorker: WorkspaceRpcCatalogWorkerClient;
beforeEach(() => {
  catalogWorker = new WorkspaceRpcCatalogWorkerClient();
});
afterEach(async () => {
  await catalogWorker.close();
  for (const root of ownedRoots) {
    rmSync(root, { recursive: true, force: true });
    ownedRoots.delete(root);
  }
});

function authority(title: string) {
  return {
    requests: [],
    provides: [
      {
        name: "notes.delete",
        title,
        action: "delete this note",
        tier: "critical" as const,
        sensitivity: "destructive" as const,
        resourceType: "note",
        presentation: { domain: "files" as const, verb: "manage" as const },
        notability: "headline" as const,
        grantScopes: ["once" as const],
      },
    ],
  };
}

function providerNode(root: string, manifestAuthority: ReturnType<typeof authority>): GraphNode {
  return {
    path: join(root, "workers/notes"),
    relativePath: "workers/notes",
    name: "@workspace-workers/notes",
    kind: "worker",
    dependencies: {},
    peerDependencies: {},
    optionalPeerDependencies: [],
    dependencyOverrides: {},
    internalDeps: [],
    manifest: {
      authority: manifestAuthority,
      durable: { classes: [{ className: "NotesDO" }] },
    } as PackageManifest,
  };
}

describe("exact userland provider catalogs", () => {
  it("uses the canonical declaration owner when its name also identifies its protocol", async () => {
    const binding: ExactWorkspaceServiceBinding = {
      name: "tasks.v1",
      protocols: ["tasks.v1"],
      source: "workers/tasks",
      action: "manage tasks",
      presentation: { domain: "files", verb: "manage" },
      principals: ["code"],
      target: { kind: "durable-object", className: "TasksDO", defaultObjectKey: "tasks" },
    };
    const resolveCatalog = vi.fn(async () => ({
      provider: {
        unitName: "@workspace-workers/tasks",
        source: binding.source,
        effectiveVersion: "ev-tasks",
        className: "TasksDO",
      },
      methods: new Map(),
      digest: "tasks-catalog",
    }));
    const environment = createExactWorkspaceAuthorityEnvironment({
      stateHash: "state:tasks",
      services: [binding],
      resolveCatalog,
    });
    expect(await environment.resolveService("tasks.v1")).toMatchObject({
      kind: "resolved",
      service: { binding },
    });
    expect(resolveCatalog).toHaveBeenCalledWith(binding);
    expect(() =>
      createExactWorkspaceAuthorityEnvironment({
        stateHash: "state:tasks",
        services: [binding, { ...binding, name: "other" }],
        resolveCatalog,
      })
    ).toThrow(/declared by both/);
  });

  it("does not synthesize product providers outside the exact workspace catalog", async () => {
    const environment = createExactWorkspaceAuthorityEnvironment({
      stateHash: "state:catalog",
      services: [],
      resolveCatalog: async () => {
        throw new Error("No undeclared service should resolve a catalog");
      },
    });

    const development = await environment.resolveService("vibestudio.development.v1");
    expect(development).toEqual({
      kind: "missing",
      query: "vibestudio.development.v1",
    });
    expect(
      environment.services.some((service) => ["development", "missions"].includes(service.name))
    ).toBe(false);
  });

  it("projects the exact materialized provider and coalesces identical extraction", async () => {
    const root = mkdtempSync(join(tmpdir(), "vibestudio-userland-catalog-"));
    ownedRoots.add(root);
    mkdirSync(join(root, "workers/notes"), { recursive: true });
    const manifestAuthority = authority("Delete note");
    writeFileSync(
      join(root, "workers/notes/package.json"),
      JSON.stringify({ vibestudio: { authority: manifestAuthority } })
    );
    writeFileSync(
      join(root, "workers/notes/provider.ts"),
      `class NotesDO {
        @rpc({ website: {"kind":"eligible","rationale":"Explicit receiver exposure for this test fixture."},
          principals: ["code"],
          effect: { kind: "userland-capability", capability: "notes.delete", resource: { kind: "receiver-object" } },
          tier: "critical",
          sensitivity: "destructive"
        })
        async deleteNote(): Promise<void> {}
      }`
    );
    const graph = {} as PackageGraph;
    const source = directorySourceProvider(root);
    const materializeForBuild = vi.spyOn(source, "materializeForBuild");
    const input = {
      stateHash: "state:catalog",
      provider: providerNode(root, manifestAuthority),
      effectiveVersion: "ev-notes-1",
      className: "NotesDO",
      graph,
      workspaceRoot: root,
      source,
      collectRpcCatalog: catalogWorker.collect.bind(catalogWorker),
      compiledRpcCatalog: async () => null,
    };
    const sourceCatalog = await resolveProviderRpcCatalog(input);
    const preparedMaterialize = vi.fn(() => {
      throw new Error("Prepared catalog must not materialize source");
    });
    const preparedExtract = vi.fn(() => {
      throw new Error("Prepared catalog must not re-extract RPC");
    });
    const preparedCatalog = await resolveProviderRpcCatalog({
      ...input,
      effectiveVersion: "ev-notes-prepared",
      source: { ...source, materializeForBuild: preparedMaterialize },
      collectRpcCatalog: preparedExtract,
      compiledRpcCatalog: async () => sourceCatalog.methods,
    });
    expect(preparedCatalog.methods).toEqual(sourceCatalog.methods);
    expect(preparedMaterialize).not.toHaveBeenCalled();
    expect(preparedExtract).not.toHaveBeenCalled();
    const first = await resolveProviderCatalog(input);
    const second = await resolveProviderCatalog(input);
    expect(second).toBe(first);
    expect(sourceCatalog.methods).toEqual([
      expect.objectContaining({ className: "NotesDO", name: "deleteNote" }),
    ]);
    expect(materializeForBuild).toHaveBeenCalledTimes(1);
    expect(first.methods.get("deleteNote")).toMatchObject({
      kind: "protected",
      canonicalCapability: expect.stringMatching(
        /^userland:workers\/notes\/notes\.delete#[0-9a-f]{64}$/u
      ),
      access: { codeReachable: true },
    });

    const changedAuthority = authority("Delete note permanently");
    writeFileSync(
      join(root, "workers/notes/package.json"),
      JSON.stringify({ vibestudio: { authority: changedAuthority } })
    );
    const changed = await resolveProviderCatalog({
      ...input,
      provider: providerNode(root, changedAuthority),
      effectiveVersion: "ev-notes-2",
    });
    expect(changed.digest).not.toBe(first.digest);
  });

  it("rejects module-level runtime clients while resolving a Durable Object catalog", async () => {
    const root = mkdtempSync(join(tmpdir(), "vibestudio-userland-do-runtime-"));
    ownedRoots.add(root);
    mkdirSync(join(root, "workers/notes"), { recursive: true });
    const manifestAuthority = authority("Delete note");
    writeFileSync(
      join(root, "workers/notes/package.json"),
      JSON.stringify({ vibestudio: { authority: manifestAuthority } })
    );
    writeFileSync(
      join(root, "workers/notes/provider.ts"),
      `import { blobstore } from "@workspace/runtime";
class NotesDO {
  async deleteNote(): Promise<void> { void blobstore; }
}`
    );

    const input = {
      stateHash: "state:do-module-runtime",
      provider: providerNode(root, manifestAuthority),
      effectiveVersion: "ev-notes-module-runtime",
      className: "NotesDO",
      graph: {} as PackageGraph,
      workspaceRoot: root,
      source: directorySourceProvider(root),
      collectRpcCatalog: catalogWorker.collect.bind(catalogWorker),
      compiledRpcCatalog: async () => null,
    };

    await expect(resolveProviderRpcCatalog(input)).rejects.toThrow(
      /imports a module-level runtime client from "@workspace\/runtime"/u
    );
  });
});
