import { describe, expect, it } from "vitest";
import YAML from "yaml";
import type { WorkspaceTemplatePin } from "@vibestudio/workspace-contracts/types";
import { inspectTemplateAuthoring, listTemplateAuthoringParts } from "./authoring.js";

function packageFile(value: unknown) {
  return value === undefined
    ? null
    : { content: { kind: "text" as const, text: JSON.stringify(value) } };
}

function pin(name: string, commitCharacter: string): WorkspaceTemplatePin {
  return {
    url: `git+https://example.test/${name}.git`,
    ref: "refs/tags/v1",
    commit: commitCharacter.repeat(40),
    snapshot: `v1-sha256:${commitCharacter.repeat(64)}`,
  };
}

function context(packages: Record<string, unknown>) {
  return {
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
}

describe("template authoring inspection", () => {
  it("uses the current installed dependency layer, including local base edits", async () => {
    const base = pin("base", "a");
    const packages = {
      "extensions/demo": {
        name: "@workspace/demo",
        dependencies: {
          "@workspace/shared": "workspace:*",
          "@workspace/base-runtime": "workspace:*",
        },
      },
      "packages/shared": { name: "@workspace/shared" },
      // This is read from protected main, not reacquired from base's old pin.
      "packages/base-runtime": { name: "@workspace/base-runtime", version: "locally-edited" },
    };
    const plan = await inspectTemplateAuthoring(
      context(packages) as never,
      {
        localRepoPaths: new Set(["extensions/demo", "packages/shared"]),
        state: {
          nodes: [{ nodeId: "t-base", alias: "base", pin: base, parents: [] }],
          repositories: {
            "packages/base-runtime": {
              contributions: [{ nodeId: "t-base", subtreeDigest: base.snapshot }],
            },
          },
        },
        runtimeTop: {
          systemEpoch: 57,
          extensions: [{ source: "extensions/demo" }],
        },
        mainEventId: "event:main",
        mainState: { kind: "event", eventId: "event:main" },
      } as never,
      {
        name: "Demo",
        description: "A focused demo",
        parts: ["extensions/demo"],
        dependencies: [{ url: base.url }],
      }
    );

    expect(plan.requiredParts).toEqual(["packages/shared"]);
    expect(plan.dependencyParts).toEqual(["packages/base-runtime"]);
    expect(plan.overlapParts).toEqual([]);
    expect(plan.includedParts).toEqual(["extensions/demo", "packages/shared"]);
    expect(plan.request.dependencies).toEqual([{ url: base.url }]);
    expect(YAML.parse(plan.manifest)).toMatchObject({
      templates: { use: [{ url: base.url }] },
      extensions: [{ source: "extensions/demo" }],
    });
  });

  it("rejects unresolved authored workspace dependencies", async () => {
    await expect(
      inspectTemplateAuthoring(
        context({
          "extensions/demo": {
            name: "@workspace/demo",
            dependencies: { "@workspace/missing": "workspace:*" },
          },
        }) as never,
        {
          localRepoPaths: new Set(["extensions/demo"]),
          runtimeTop: { systemEpoch: 57 },
          mainEventId: "event:main",
          mainState: { kind: "event", eventId: "event:main" },
        } as never,
        { name: "Demo", description: "A focused demo", parts: ["extensions/demo"] }
      )
    ).rejects.toThrow("extensions/demo depends on missing workspace package @workspace/missing");
  });

  it("inherits the installed dependency closure without publishing its repositories", async () => {
    const feature = pin("feature", "c");
    const base = pin("base", "d");
    const plan = await inspectTemplateAuthoring(
      context({
        "extensions/demo": { name: "@workspace/demo" },
        "packages/feature-runtime": { name: "@workspace/feature-runtime" },
        "packages/base-runtime": { name: "@workspace/base-runtime" },
      }) as never,
      {
        localRepoPaths: new Set(["extensions/demo"]),
        state: {
          nodes: [
            { nodeId: "t-base", alias: "base", pin: base, parents: [] },
            { nodeId: "t-feature", alias: "feature", pin: feature, parents: ["t-base"] },
          ],
          repositories: {
            "packages/base-runtime": {
              contributions: [{ nodeId: "t-base", subtreeDigest: base.snapshot }],
            },
            "packages/feature-runtime": {
              contributions: [{ nodeId: "t-feature", subtreeDigest: feature.snapshot }],
            },
          },
        },
        runtimeTop: { systemEpoch: 57 },
        mainEventId: "event:main",
        mainState: { kind: "event", eventId: "event:main" },
      } as never,
      {
        name: "Demo",
        description: "A focused demo",
        parts: ["extensions/demo"],
        dependencies: [{ url: feature.url }],
      }
    );

    expect(plan.dependencyParts).toEqual(["packages/base-runtime", "packages/feature-runtime"]);
    expect(plan.overlapParts).toEqual([]);
    expect(YAML.parse(plan.manifest).templates.use).toEqual([{ url: feature.url }]);
  });

  it("keeps dependencies semantic and allows explicit overlap", async () => {
    const base = pin("base", "e");
    const observation = {
      localRepoPaths: new Set(["packages/base-runtime"]),
      state: {
        nodes: [{ nodeId: "t-base", alias: "base", pin: base, parents: [] }],
        repositories: {
          "packages/base-runtime": {
            contributions: [{ nodeId: "t-base", subtreeDigest: base.snapshot }],
          },
        },
      },
      runtimeTop: { systemEpoch: 57 },
      mainEventId: "event:main",
      mainState: { kind: "event", eventId: "event:main" },
    };
    const overlapping = await inspectTemplateAuthoring(context({}) as never, observation as never, {
      name: "Duplicate",
      description: "An intentional overlay",
      parts: ["packages/base-runtime"],
      dependencies: [{ url: base.url }],
    });
    expect(overlapping.includedParts).toEqual(["packages/base-runtime"]);
    expect(overlapping.dependencyParts).toEqual(["packages/base-runtime"]);
    expect(overlapping.overlapParts).toEqual(["packages/base-runtime"]);

    const unavailable = await inspectTemplateAuthoring(context({}) as never, observation as never, {
      name: "Missing",
      description: "A dependency resolved only when composed",
      parts: ["packages/base-runtime"],
      dependencies: [{ url: "git+https://example.test/other.git" }],
    });
    expect(unavailable.dependencyParts).toEqual([]);
    expect(unavailable.overlapParts).toEqual([]);
    expect(unavailable.request.dependencies).toEqual([
      { url: "git+https://example.test/other.git" },
    ]);
  });

  it("exposes installed ownership without exact authoring pins", async () => {
    const base = pin("base", "f");
    const parts = await listTemplateAuthoringParts(
      context({}) as never,
      {
        localRepoPaths: new Set(),
        state: {
          nodes: [{ nodeId: "t-base", alias: "base", pin: base }],
          repositories: {
            "packages/base-runtime": {
              contributions: [{ nodeId: "t-base", subtreeDigest: base.snapshot }],
            },
          },
        },
        mainState: { kind: "event", eventId: "event:main" },
      } as never
    );

    expect(parts).toEqual([
      {
        repoPath: "packages/base-runtime",
        templateAliases: ["base"],
        templateUrls: [base.url],
      },
    ]);
  });
});
