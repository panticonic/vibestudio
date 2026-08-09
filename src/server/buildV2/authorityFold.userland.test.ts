import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TypeCheckService } from "@vibestudio/typecheck";
import { authorityDiagnosticsForProgram } from "./authorityFold.js";
import { createExactWorkspaceAuthorityEnvironment } from "./userlandAuthority.js";

function programFor(source: string) {
  const root = mkdtempSync(join(tmpdir(), "vibestudio-authority-fold-"));
  const file = join(root, "index.ts");
  writeFileSync(file, source);
  const service = new TypeCheckService({
    panelPath: root,
    workspaceContext: null,
    disableTsconfigDiscovery: true,
  });
  service.updateFile(file, source);
  services.push(service);
  return {
    root,
    project: service.getProject(),
  };
}

const services: TypeCheckService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
});

function programForFiles(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "vibestudio-authority-fold-deps-"));
  const sources = Object.entries(files).map(([relative, source]) => {
    const file = join(root, relative);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, source);
    return { file, source };
  });
  const service = new TypeCheckService({
    panelPath: root,
    workspaceContext: null,
    disableTsconfigDiscovery: true,
  });
  for (const source of sources) service.updateFile(source.file, source.source);
  services.push(service);
  return {
    root,
    project: service.getProject(),
  };
}

const binding = {
  name: "notes",
  protocols: ["example.notes.v1"],
  source: "workers/notes",
  action: "manage notes",
  notability: "everyday" as const,
  presentation: { domain: "files" as const, verb: "manage" as const },
  principals: ["code" as const],
  target: { kind: "durable-object" as const, className: "NotesDO", defaultObjectKey: "main" },
};

const catalog = {
  provider: {
    unitName: "@workspace-workers/notes",
    source: "workers/notes",
    effectiveVersion: "ev-notes",
    className: "NotesDO",
  },
  methods: new Map([
    [
      "deleteNote",
      {
        kind: "protected" as const,
        localCapability: "notes.delete",
        canonicalCapability: "userland:workers/notes/notes.delete#digest",
        definitionDigest: "digest",
        tier: "critical" as const,
        sensitivity: "destructive" as const,
        resource: { kind: "receiver-object" as const, resourceType: "note" },
        access: { principals: ["code" as const], codeOnly: false, codeReachable: true },
      },
    ],
  ]),
  digest: "catalog-digest",
};

describe("userland authority fold", () => {
  it("reports an actionable diagnostic when a consumed service lacks review metadata", async () => {
    const { root, project } = programFor(`
      declare const workers: { resolveService(query: string): Promise<unknown> };
      export const notes = workers.resolveService("example.notes.v1");
    `);
    const { notability: _notability, ...unreviewedBinding } = binding;
    const environment = createExactWorkspaceAuthorityEnvironment({
      stateHash: "state:exact",
      services: [unreviewedBinding],
      resolveCatalog: async () => catalog,
    });

    const diagnostics = await authorityDiagnosticsForProgram({
      project,
      sourceRoot: root,
      unitRelativePath: ".",
      units: [{ name: "consumer", relativePath: "." }],
      manifest: {
        authority: {
          requests: [],
          serviceRequests: [{ protocol: "example.notes.v1", availability: "required" }],
          provides: [],
        },
      },
      environment,
    });

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining("has no reviewed notability classification"),
          suggestion: expect.stringContaining("meta/vibestudio.yml"),
        }),
      ])
    );
  });

  it("does not charge an empty package for unrelated workspace source", async () => {
    const { root, project } = programForFiles({
      "packages/empty/index.ts": "export {};",
      "packages/unrelated/index.ts": `
        export const method = "workspace-state.slot.commitPreparedNavigation";
      `,
    });

    const diagnostics = await authorityDiagnosticsForProgram({
      project,
      sourceRoot: root,
      unitRelativePath: "packages/empty",
      units: [
        { name: "@workspace/empty", relativePath: "packages/empty" },
        { name: "@workspace/unrelated", relativePath: "packages/unrelated" },
      ],
      manifest: {
        authority: {
          requests: [],
          serviceRequests: [{ protocol: "example.notes.v1", availability: "required" }],
          provides: [],
        },
      },
    });

    expect(diagnostics).toEqual([]);
  });

  it("still charges a library for an explicit context-bearing host call", async () => {
    const { root, project } = programFor(
      `export const method = "workspace-state.slot.commitPreparedNavigation";`
    );

    const diagnostics = await authorityDiagnosticsForProgram({
      project,
      sourceRoot: root,
      unitRelativePath: ".",
      units: [{ name: "@workspace/library", relativePath: "." }],
      manifest: {
        authority: {
          requests: [],
          serviceRequests: [{ protocol: "example.notes.v1", availability: "required" }],
          provides: [],
        },
      },
    });

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining("capability 'context.boundary'"),
        }),
      ])
    );
  });

  it("does not treat trusted runtime dispatch plumbing as consumer service intent", async () => {
    const { root, project } = programFor("export const entry = true;");
    const environment = createExactWorkspaceAuthorityEnvironment({
      stateHash: "state:exact",
      services: [binding],
      resolveCatalog: async () => catalog,
    });

    const diagnostics = await authorityDiagnosticsForProgram({
      project,
      sourceRoot: root,
      unitRelativePath: ".",
      units: [{ name: "consumer", relativePath: "." }],
      manifest: {
        authority: {
          serviceRequests: [{ protocol: "example.notes.v1", availability: "required" }],
          requests: [
            {
              capability: "context.boundary",
              resource: { kind: "prefix", prefix: "context" },
              tier: "critical",
              evidence: "bounded-dynamic",
            },
          ],
          provides: [],
        },
      },
      environment,
      executableModules: [
        {
          moduleId: "runtime/workerd.ts",
          contentDigest: "digest-runtime",
          package: {
            kind: "workspace",
            name: "@workspace/runtime",
            effectiveVersion: "ev-runtime",
          },
          format: "ts",
          source: `
            declare const workers: { resolveService(query: string): Promise<unknown> };
            export const resolveService = (query: string) => workers.resolveService(query);
          `,
        },
      ],
    });

    expect(diagnostics).toEqual([]);
  });

  it("does not treat reachable trusted runtime source as consumer service intent", async () => {
    const { root, project } = programForFiles({
      "index.ts": `import { runtimeClient } from "./runtime/workerd"; export const client = runtimeClient;`,
      "runtime/workerd.ts": `
        declare const workers: {
          resolveService(query: string, objectKey?: string): Promise<{ targetId: string }>;
        };
        export function runtimeClient(query: string) { return workers.resolveService(query); }
      `,
    });
    const environment = createExactWorkspaceAuthorityEnvironment({
      stateHash: "state:exact",
      services: [binding],
      resolveCatalog: async () => catalog,
    });

    const diagnostics = await authorityDiagnosticsForProgram({
      project,
      sourceRoot: root,
      unitRelativePath: ".",
      units: [
        { name: "consumer", relativePath: "." },
        {
          name: "@workspace/runtime",
          relativePath: "runtime",
          package: {
            kind: "workspace",
            name: "@workspace/runtime",
            versionOrEffectiveVersion: "ev-runtime",
            contentDigest: "digest-runtime",
          },
        },
      ],
      manifest: {
        authority: {
          serviceRequests: [{ protocol: "example.notes.v1", availability: "required" }],
          requests: [
            {
              capability: "context.boundary",
              resource: { kind: "prefix", prefix: "context" },
              tier: "critical",
              evidence: "bounded-dynamic",
            },
          ],
          provides: [],
        },
      },
      environment,
    });

    expect(diagnostics).toEqual([]);
  });

  it("requires service admission and the sealed provider method capability", async () => {
    const { root, project } = programFor(`
      declare const workers: { resolveService(query: string, objectKey?: string | null): Promise<{ targetId: string }> };
      declare const rpc: { call(target: string, method: string, args: unknown[]): Promise<unknown> };
      async function run() {
        const service = await workers.resolveService("example.notes.v1");
        await rpc.call(service.targetId, "deleteNote", []);
      }
    `);
    const environment = createExactWorkspaceAuthorityEnvironment({
      stateHash: "state:exact",
      services: [binding],
      resolveCatalog: async () => catalog,
    });
    const diagnostics = await authorityDiagnosticsForProgram({
      project,
      sourceRoot: root,
      unitRelativePath: ".",
      units: [{ name: "consumer", relativePath: "." }],
      manifest: {
        authority: {
          requests: [],
          serviceRequests: [{ protocol: "example.notes.v1", availability: "required" }],
          provides: [],
        },
      },
      environment,
    });
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("workspace-service:notes") }),
        expect.objectContaining({ message: expect.stringContaining("notes.delete") }),
      ])
    );
  });

  it("accepts an exact service target and provider-bound capability family", async () => {
    const { root, project } = programFor(`
      declare const workers: { resolveService(query: string, objectKey?: string | null): Promise<{ targetId: string }> };
      declare const rpc: { call(target: string, method: string, args: unknown[]): Promise<unknown> };
      async function run() {
        const service = await workers.resolveService("example.notes.v1");
        await rpc.call(service.targetId, "deleteNote", []);
      }
    `);
    const environment = createExactWorkspaceAuthorityEnvironment({
      stateHash: "state:exact",
      services: [binding],
      resolveCatalog: async () => catalog,
    });
    const diagnostics = await authorityDiagnosticsForProgram({
      project,
      sourceRoot: root,
      unitRelativePath: ".",
      units: [{ name: "consumer", relativePath: "." }],
      manifest: {
        authority: {
          serviceRequests: [{ protocol: "example.notes.v1", availability: "required" }],
          requests: [
            {
              capability: "context.boundary",
              resource: { kind: "prefix", prefix: "context/" },
              tier: "gated",
              evidence: "bounded-dynamic",
            },
            {
              capability: "workspace-service:notes",
              resource: { kind: "exact", key: "do:workers/notes:NotesDO:main" },
              tier: "gated",
              evidence: "exact",
            },
            {
              capability: "userland:workers/notes/notes.delete#*",
              resource: { kind: "exact", key: "note:do:workers/notes:NotesDO:main" },
              tier: "critical",
              evidence: "bounded-dynamic",
            },
          ],
          provides: [],
        },
      },
      environment,
    });
    expect(diagnostics).toEqual([]);
  });

  it("requires dependency-origin effects to name the explicit package endowment", async () => {
    const { root, project } = programForFiles({
      "index.ts": "export const entry = true;",
      "dep/index.ts": `
        declare const workers: { resolveService(query: string): Promise<{ targetId: string }> };
        declare const rpc: { call(target: string, method: string, args: unknown[]): Promise<unknown> };
        async function run() {
          const service = await workers.resolveService("example.notes.v1");
          await rpc.call(service.targetId, "deleteNote", []);
        }
      `,
    });
    const environment = createExactWorkspaceAuthorityEnvironment({
      stateHash: "state:exact",
      services: [binding],
      resolveCatalog: async () => catalog,
    });
    const diagnostics = await authorityDiagnosticsForProgram({
      project,
      sourceRoot: root,
      unitRelativePath: ".",
      units: [
        { name: "consumer", relativePath: "." },
        {
          name: "@workspace/wrapper",
          relativePath: "dep",
          package: {
            kind: "workspace",
            name: "@workspace/wrapper",
            versionOrEffectiveVersion: "ev-wrapper",
            contentDigest: "digest-wrapper",
          },
        },
      ],
      manifest: {
        authority: {
          serviceRequests: [{ protocol: "example.notes.v1", availability: "required" }],
          requests: [
            {
              capability: "context.boundary",
              resource: { kind: "prefix", prefix: "context/" },
              tier: "gated",
              evidence: "bounded-dynamic",
            },
            {
              capability: "workspace-service:notes",
              resource: { kind: "exact", key: "do:workers/notes:NotesDO:main" },
              tier: "gated",
              evidence: "exact",
              packages: ["@workspace/wrapper"],
            },
            {
              capability: "userland:workers/notes/notes.delete#*",
              resource: { kind: "exact", key: "note:do:workers/notes:NotesDO:main" },
              tier: "critical",
              evidence: "bounded-dynamic",
              packages: ["@workspace/wrapper"],
            },
          ],
          provides: [],
        },
      },
      environment,
    });
    expect(diagnostics).toEqual([]);
  });
});
