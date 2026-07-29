import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { inspectTemplateAuthoring } from "./authoring.js";

function packageFile(value: unknown) {
  return {
    content: { kind: "text" as const, text: JSON.stringify(value) },
  };
}

describe("template authoring inspection", () => {
  it("adds workspace package dependencies and lets an installed parent satisfy its parts", async () => {
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
      localRepoPaths: new Set(["extensions/demo", "packages/shared"]),
      lock: {
        nodes: [
          {
            nodeId: "t-base",
            alias: "base",
            pin: {
              url: "git+https://example.test/base.git",
              ref: "refs/tags/v1",
              commit: "a".repeat(40),
              snapshot: `v1-sha256:${"b".repeat(64)}`,
            },
          },
        ],
        repositories: {
          "packages/base-runtime": { nodeId: "t-base" },
        },
      },
      runtimeTop: {
        systemEpoch: 57,
        extensions: [{ source: "extensions/demo" }],
        providers: { gitInterop: { extension: "extensions/demo" } },
      },
      mainEventId: "event:main",
      mainState: { kind: "event", eventId: "event:main" },
    };
    const plan = await inspectTemplateAuthoring(
      ctx as never,
      observation as never,
      {
        name: "Demo",
        description: "A focused demo",
        parts: ["extensions/demo"],
        parents: ["base"],
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
    };

    await expect(
      inspectTemplateAuthoring(ctx as never, observation as never, {
        name: "Demo",
        description: "A focused demo",
        parts: ["extensions/demo"],
      })
    ).rejects.toThrow(
      "extensions/demo depends on missing workspace package @workspace/missing"
    );
  });

  it("refuses to vendor a repository also supplied by a selected parent", async () => {
    const observation = {
      localRepoPaths: new Set(),
      lock: {
        nodes: [
          {
            nodeId: "t-base",
            alias: "base",
            pin: { url: "git+https://example.test/base.git" },
          },
        ],
        repositories: { "packages/base-runtime": { nodeId: "t-base" } },
      },
      runtimeTop: { systemEpoch: 57 },
      mainEventId: "event:main",
    };
    await expect(
      inspectTemplateAuthoring({} as never, observation as never, {
        name: "Duplicate",
        description: "Invalid duplicate",
        parts: ["packages/base-runtime"],
        parents: ["base"],
      })
    ).rejects.toThrow("already supplied by a selected parent");
  });
});
