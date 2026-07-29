import { describe, expect, it } from "vitest";
import YAML from "yaml";
import type { WorkspaceTemplatePin } from "@vibestudio/workspace-contracts/types";
import { inspectTemplateAuthoring, listTemplateAuthoringParts } from "./authoring.js";

function packageFile(value: unknown) {
  return {
    content: { kind: "text" as const, text: JSON.stringify(value) },
  };
}

function pin(name: string, commitCharacter: string): WorkspaceTemplatePin {
  return {
    url: `git+https://example.test/${name}.git`,
    ref: "refs/tags/v1",
    commit: commitCharacter.repeat(40),
    snapshot: `v1-sha256:${commitCharacter.repeat(64)}`,
  };
}

function snapshot(exact: WorkspaceTemplatePin, files: Record<string, string>) {
  const entries = Object.entries(files);
  return {
    commit: exact.commit,
    snapshot: exact.snapshot,
    files: entries.map(([path, content], index) => ({
      path,
      contentHash: String(index + 1).padStart(64, "0"),
      size: Buffer.byteLength(content),
      mode: 0o644 as const,
    })),
    readFile(path: string) {
      const content = files[path];
      return content === undefined ? null : Buffer.from(content);
    },
  };
}

describe("template authoring inspection", () => {
  it("adds workspace dependencies and resolves an exact newly published parent", async () => {
    const base = pin("base", "a");
    const packages: Record<string, unknown> = {
      "extensions/demo": {
        name: "@workspace/demo",
        dependencies: {
          "@vibestudio/content-addressing": "workspace:*",
          "@workspace/shared": "workspace:*",
          "@workspace/base-runtime": "workspace:*",
        },
      },
      "packages/shared": { name: "@workspace/shared" },
      "packages/base-runtime": { name: "@workspace/base-runtime" },
    };
    const ctx = {
      rpc: {
        async call(_target: string, method: string, input: Record<string, unknown>) {
          if (method === "vcs.resolveRepository") {
            return { repositoryId: `repo:${String(input["repoPath"])}` };
          }
          if (method === "vcs.readFile") {
            const repoPath = String(input["repositoryId"]).slice("repo:".length);
            return packageFile(packages[repoPath]);
          }
          throw new Error(`Unexpected method ${method}`);
        },
      },
    };
    const observation = {
      localRepoPaths: new Set(["extensions/demo", "packages/shared", "packages/base-runtime"]),
      runtimeTop: {
        systemEpoch: 57,
        extensions: [{ source: "extensions/demo" }],
        providers: { gitInterop: { extension: "extensions/demo" } },
      },
      mainEventId: "event:main",
      mainState: { kind: "event", eventId: "event:main" },
      expectedSystemEpoch: 57,
    };
    const plan = await inspectTemplateAuthoring(
      ctx as never,
      observation as never,
      {
        name: "Demo",
        description: "A focused demo",
        parts: ["extensions/demo"],
        parents: [base],
      },
      {
        resolvePromoted: async () => {
          throw new Error("The exact direct parent must not consult promotion");
        },
        acquire: async () =>
          snapshot(base, {
            "meta/template.yml": "systemEpoch: 57\ntemplates:\n  use: []\n",
            "packages/base-runtime/package.json": JSON.stringify(packages["packages/base-runtime"]),
          }),
      }
    );

    expect(plan.requestedParts).toEqual(["extensions/demo"]);
    expect(plan.requiredParts).toEqual(["packages/shared"]);
    expect(plan.inheritedParts).toEqual(["packages/base-runtime"]);
    expect(plan.includedParts).toEqual(["extensions/demo", "packages/shared"]);
    expect(YAML.parse(plan.manifest)).toMatchObject({
      systemEpoch: 57,
      templates: { use: [{ url: "git+https://example.test/base.git" }] },
      extensions: [{ source: "extensions/demo" }],
      providers: { gitInterop: { extension: "extensions/demo" } },
    });
    expect(plan.request.parents).toEqual([base]);
    expect(plan.parents).toEqual([
      expect.objectContaining({
        alias: expect.stringMatching(/^base-/u),
        direct: true,
        url: base.url,
        commit: base.commit,
        snapshot: base.snapshot,
      }),
    ]);
    expect(plan.parentClosureFingerprint).toMatch(/^v1-sha256:[0-9a-f]{64}$/u);
    expect(plan.fingerprint).toMatch(/^v1-sha256:[0-9a-f]{64}$/u);
  });

  it("rejects unresolved authored workspace dependencies", async () => {
    const ctx = {
      rpc: {
        async call(_target: string, method: string, input: Record<string, unknown>) {
          if (method === "vcs.resolveRepository") {
            return { repositoryId: `repo:${String(input["repoPath"])}` };
          }
          if (method === "vcs.readFile") {
            return packageFile({
              name: "@workspace/demo",
              dependencies: { "@workspace/missing": "workspace:*" },
            });
          }
          throw new Error(`Unexpected method ${method}`);
        },
      },
    };
    const observation = {
      localRepoPaths: new Set(["extensions/demo"]),
      runtimeTop: { systemEpoch: 57 },
      mainEventId: "event:main",
      mainState: { kind: "event", eventId: "event:main" },
      expectedSystemEpoch: 57,
    };

    await expect(
      inspectTemplateAuthoring(ctx as never, observation as never, {
        name: "Demo",
        description: "A focused demo",
        parts: ["extensions/demo"],
      })
    ).rejects.toThrow("extensions/demo depends on missing workspace package @workspace/missing");
  });

  it("verifies a parent's URL-only transitive closure and inherits every contribution", async () => {
    const feature = pin("feature", "c");
    const base = pin("base", "d");
    const packages: Record<string, unknown> = {
      "extensions/demo": {
        name: "@workspace/demo",
        dependencies: { "@workspace/base-runtime": "workspace:*" },
      },
    };
    const ctx = {
      rpc: {
        async call(_target: string, method: string, input: Record<string, unknown>) {
          if (method === "vcs.resolveRepository") {
            return { repositoryId: `repo:${String(input["repoPath"])}` };
          }
          if (method === "vcs.readFile") {
            const repoPath = String(input["repositoryId"]).slice("repo:".length);
            return packageFile(packages[repoPath]);
          }
          throw new Error(`Unexpected method ${method}`);
        },
      },
    };
    const plan = await inspectTemplateAuthoring(
      ctx as never,
      {
        localRepoPaths: new Set(["extensions/demo"]),
        runtimeTop: { systemEpoch: 57, extensions: [{ source: "extensions/demo" }] },
        mainEventId: "event:main",
        mainState: { kind: "event", eventId: "event:main" },
        expectedSystemEpoch: 57,
      } as never,
      {
        name: "Demo",
        description: "A focused demo",
        parts: ["extensions/demo"],
        parents: [feature],
      },
      {
        resolvePromoted: async (declaration) => {
          expect(declaration.url).toBe(base.url);
          return base;
        },
        acquire: async (exact) =>
          exact.url === feature.url
            ? snapshot(feature, {
                "meta/template.yml": `systemEpoch: 57\ntemplates:\n  use:\n    - url: ${base.url}\n`,
                "packages/feature-runtime/package.json": JSON.stringify({
                  name: "@workspace/feature-runtime",
                }),
              })
            : snapshot(base, {
                "meta/template.yml": "systemEpoch: 57\ntemplates:\n  use: []\n",
                "packages/base-runtime/package.json": JSON.stringify({
                  name: "@workspace/base-runtime",
                }),
              }),
      }
    );

    expect(plan.inheritedParts).toEqual(["packages/base-runtime", "packages/feature-runtime"]);
    expect(plan.parents.map(({ url, direct }) => ({ url, direct }))).toEqual([
      { url: base.url, direct: false },
      { url: feature.url, direct: true },
    ]);
    expect(YAML.parse(plan.manifest).templates.use).toEqual([{ url: feature.url }]);
  });

  it("refuses to vendor a repository also supplied by an exact parent", async () => {
    const base = pin("base", "e");
    const observation = {
      localRepoPaths: new Set(["packages/base-runtime"]),
      runtimeTop: { systemEpoch: 57 },
      mainEventId: "event:main",
      expectedSystemEpoch: 57,
    };
    await expect(
      inspectTemplateAuthoring(
        {} as never,
        observation as never,
        {
          name: "Duplicate",
          description: "Invalid duplicate",
          parts: ["packages/base-runtime"],
          parents: [base],
        },
        {
          resolvePromoted: async () => {
            throw new Error("unexpected promotion");
          },
          acquire: async () =>
            snapshot(base, {
              "meta/template.yml": "systemEpoch: 57\ntemplates:\n  use: []\n",
              "packages/base-runtime/package.json": JSON.stringify({
                name: "@workspace/base-runtime",
              }),
            }),
        }
      )
    ).rejects.toThrow("already supplied by an exact parent");
  });

  it("exposes installed parents as exact pins rather than alias-only shortcuts", async () => {
    const base = pin("base", "f");
    const parts = await listTemplateAuthoringParts(
      {
        rpc: {
          async call(_target: string, method: string, input: Record<string, unknown>) {
            if (method === "vcs.resolveRepository") {
              return { repositoryId: `repo:${String(input["repoPath"])}` };
            }
            if (method === "vcs.readFile") return null;
            throw new Error(`Unexpected method ${method}`);
          },
        },
      } as never,
      {
        localRepoPaths: new Set(),
        lock: {
          nodes: [{ nodeId: "t-base", alias: "base", pin: base }],
          repositories: { "packages/base-runtime": { nodeId: "t-base" } },
        },
        mainState: { kind: "event", eventId: "event:main" },
      } as never
    );

    expect(parts).toEqual([
      {
        repoPath: "packages/base-runtime",
        templateAlias: "base",
        templatePin: base,
      },
    ]);
  });
});
