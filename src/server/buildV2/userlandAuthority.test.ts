import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PackageManifest } from "@vibestudio/shared/types";
import type { GraphNode, PackageGraph } from "./packageGraph.js";
import { directorySourceProvider } from "./buildSource.js";
import {
  createExactWorkspaceAuthorityEnvironment,
  resolveProviderCatalog,
  resolveProviderRpcCatalog,
} from "./userlandAuthority.js";

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
    dependencyOverrides: {},
    internalDeps: [],
    manifest: {
      authority: manifestAuthority,
      durable: { classes: [{ className: "NotesDO" }] },
    } as PackageManifest,
  };
}

describe("exact userland provider catalogs", () => {
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
    mkdirSync(join(root, "workers/notes"), { recursive: true });
    const manifestAuthority = authority("Delete note");
    writeFileSync(
      join(root, "workers/notes/package.json"),
      JSON.stringify({ vibestudio: { authority: manifestAuthority } })
    );
    writeFileSync(
      join(root, "workers/notes/provider.ts"),
      `class NotesDO {
        @rpc({
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
    };
    const sourceCatalog = await resolveProviderRpcCatalog(input);
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
});
