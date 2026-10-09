import { describe, expect, it } from "vitest";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";
import { canonicalTemplateYaml, parseTemplateManifestContent } from "./templateManifest.js";
import {
  mergeTemplateManifests,
  templateRepositoryOwners,
  type TemplateSourceLayer,
} from "./templateManifestMerge.js";

function layer(
  label: string,
  template: Record<string, unknown>,
  rest: Record<string, unknown> = {},
  repositories: readonly string[] = []
) {
  return {
    label,
    repositories,
    manifest: parseTemplateManifestContent(
      canonicalTemplateYaml({
        systemEpoch: WORKSPACE_SYSTEM_EPOCH,
        ...rest,
        template,
      }),
      WORKSPACE_SYSTEM_EPOCH
    ),
  } satisfies TemplateSourceLayer;
}

describe("mergeTemplateManifests", () => {
  it("retains the strongest dependency floor even when the parent or local layer declares a lower one", () => {
    const merged = mergeTemplateManifests([
      layer("base", {}, { minimumAppVersion: "0.1.83" }),
      layer("personal", {}, { minimumAppVersion: "0.1.70" }),
      layer("workspace", {}),
    ]);
    expect(merged.document["minimumAppVersion"]).toBe("0.1.83");
  });

  it("inherits named automation defaults and lets a dependent suppress one without losing others", () => {
    const automation = {
      source: "workers/agent-worker",
      className: "AiChatWorker",
      name: "Updates",
      summary: "Check updates",
      action: { kind: "watch", code: "return signal();" },
      trigger: { kind: "schedule", everyMs: 21600000 },
      operations: [],
    };
    const base = layer(
      "base",
      {},
      { defaultAutomations: { updates: automation, other: automation } }
    );
    expect(
      mergeTemplateManifests([base, layer("personal", {})]).document["defaultAutomations"]
    ).toEqual({ updates: automation, other: automation });
    expect(
      mergeTemplateManifests([
        base,
        layer("personal", {}, { defaultAutomations: { updates: null } }),
      ]).document["defaultAutomations"]
    ).toEqual({ updates: null, other: automation });
  });

  it("discovers ownership separately from the effective configuration", () => {
    const layers = [
      layer("base", {}, {}, ["meta", "panels/chat"]),
      layer("personal", {}, {}, ["meta", "panels/news"]),
    ];
    expect([...templateRepositoryOwners(layers).keys()].sort()).toEqual([
      "meta",
      "panels/chat",
      "panels/news",
    ]);
    expect(mergeTemplateManifests(layers).document["template"]).not.toHaveProperty("repositories");
  });

  it("accumulates extension declarations so a dependent inherits what it builds on", () => {
    const merged = mergeTemplateManifests([
      layer("base", {}, { extensions: [{ source: "extensions/git" }] }, ["meta"]),
      layer("personal", {}, { extensions: [{ source: "extensions/news" }] }, ["meta"]),
    ]);

    expect(merged.document["extensions"]).toEqual([
      { source: "extensions/git" },
      { source: "extensions/news" },
    ]);
  });

  it("resolves a setting to the last layer that stated it", () => {
    const merged = mergeTemplateManifests([
      layer("base", {}, { defaultRepo: "projects/default" }, ["meta"]),
      layer("personal", {}, { panelRestorePolicy: "none" }, ["meta"]),
    ]);

    // Personal never restated defaultRepo, so it keeps the one Base supplied.
    expect(merged.document["defaultRepo"]).toBe("projects/default");
    expect(merged.document["panelRestorePolicy"]).toBe("none");
  });

  it("lets the top layer override a setting its dependency stated", () => {
    const merged = mergeTemplateManifests([
      layer("base", {}, { defaultRepo: "projects/default" }, ["meta"]),
      layer("system", {}, { defaultRepo: "projects/system" }, ["meta"]),
    ]);
    expect(merged.document["defaultRepo"]).toBe("projects/system");
  });

  it("refuses two layers declaring one repository", () => {
    expect(() =>
      templateRepositoryOwners([
        layer("base", {}, {}, ["meta", "panels/chat"]),
        layer("personal", {}, {}, ["meta", "panels/chat"]),
      ])
    ).toThrow(/both declare repository panels\/chat: base and personal/u);
  });

  it("refuses two layers declaring one extension source", () => {
    expect(() =>
      mergeTemplateManifests([
        layer("base", {}, { extensions: [{ source: "extensions/git" }] }, ["meta"]),
        layer("personal", {}, { extensions: [{ source: "extensions/git" }] }, ["meta"]),
      ])
    ).toThrow(/both declare source extensions:extensions\/git/u);
  });

  it("takes its name from the template at the top of the stack", () => {
    const merged = mergeTemplateManifests([
      layer("base", { name: "Base", description: "A foundation" }, {}, ["meta"]),
      layer("system", { name: "System", description: "Your device" }, {}, ["meta"]),
    ]);
    expect(merged.document["template"]).toMatchObject({
      name: "System",
      description: "Your device",
    });
  });

  it("retains the top template's direct dependencies for later authoring", () => {
    const dependency = { url: "https://example.test/base.git" };
    const merged = mergeTemplateManifests([
      layer("base", { name: "Base" }, {}, ["meta"]),
      layer(
        "personal",
        {
          name: "Personal",
          dependencies: [dependency],
        },
        {},
        ["meta"]
      ),
    ]);

    expect(merged.document["template"]).toMatchObject({ dependencies: [dependency] });
  });

  it("refuses to compose nothing", () => {
    expect(() => mergeTemplateManifests([])).toThrow(/at least one manifest/u);
  });

  it("refuses layers built for different workspace system epochs", () => {
    // Each manifest is valid for its own epoch; composing them is not.
    const other = {
      label: "base",
      manifest: parseTemplateManifestContent(
        canonicalTemplateYaml({
          systemEpoch: WORKSPACE_SYSTEM_EPOCH + 1,
          template: {},
        }),
        WORKSPACE_SYSTEM_EPOCH + 1
      ),
    };
    expect(() => mergeTemplateManifests([other, layer("personal", {}, {}, ["meta"])])).toThrow(
      /disagree about the workspace system epoch/u
    );
  });

  it("merges a record setting per slot so a layer can name only what it changes", () => {
    const merged = mergeTemplateManifests([
      layer(
        "base",
        {},
        {
          extensions: [{ source: "extensions/git-bridge" }],
          providers: {
            evalEngine: { source: "@workspace/eval" },
            gitInterop: { extension: "extensions/git-bridge" },
          },
        },
        ["meta"]
      ),
      layer(
        "personal",
        {},
        {
          extensions: [{ source: "extensions/browser-data" }],
          providers: { browserData: { extension: "extensions/browser-data" } },
        },
        ["meta"]
      ),
    ]);

    // Personal named one slot and kept the two Base supplied, instead of having
    // to restate them to avoid losing them.
    expect(merged.document["providers"]).toEqual({
      evalEngine: { source: "@workspace/eval" },
      gitInterop: { extension: "extensions/git-bridge" },
      browserData: { extension: "extensions/browser-data" },
    });
  });

  it("lets the top layer replace one slot without disturbing the others", () => {
    const merged = mergeTemplateManifests([
      layer("base", {}, { defaultAgentConfig: { model: "base-model", thinkingLevel: "high" } }, [
        "meta",
      ]),
      layer("system", {}, { defaultAgentConfig: { model: "own-model" } }, ["meta"]),
    ]);
    expect(merged.document["defaultAgentConfig"]).toEqual({
      model: "own-model",
      thinkingLevel: "high",
    });
  });

  it("replaces a list inside a slot rather than letting a dependency join it", () => {
    // trust.chromeApps decides which apps may render host chrome, so the layer
    // that states it states all of it; a dependency cannot add itself.
    const merged = mergeTemplateManifests([
      layer("base", {}, { trust: { chromeApps: ["apps/base-shell"] } }, ["meta"]),
      layer("system", {}, { trust: { chromeApps: ["apps/shell"] } }, ["meta"]),
    ]);
    expect(merged.document["trust"]).toEqual({ chromeApps: ["apps/shell"] });
  });
});

it("requires an override to name the current ancestor owner, not an unrelated sibling", () => {
  const base = "https://example.test/base.git",
    derived = "https://example.test/derived.git",
    sibling = "https://example.test/sibling.git";
  const first = layer(base, {}, {}, ["panels/chat"]);
  const replacement = layer(
    derived,
    {
      dependencies: [{ url: base }],
      overrides: [{ repoPath: "panels/chat", source: base }],
    },
    {},
    ["panels/chat"]
  );
  expect([...templateRepositoryOwners([first, replacement]).keys()]).toEqual(["panels/chat"]);
  expect(() =>
    templateRepositoryOwners([
      first,
      layer(
        sibling,
        {
          overrides: [{ repoPath: "panels/chat", source: base }],
        },
        {},
        ["panels/chat"]
      ),
    ])
  ).toThrow("Invalid override");
  expect(() =>
    templateRepositoryOwners([
      first,
      replacement,
      layer(
        sibling,
        {
          dependencies: [{ url: derived }],
          overrides: [{ repoPath: "panels/chat", source: base }],
        },
        {},
        ["panels/chat"]
      ),
    ])
  ).toThrow("currently owns");
});

it("retains an explicit override after its dependency removes the original unit", () => {
  const base = "https://example.test/base.git";
  expect([
    ...templateRepositoryOwners([
      layer(base, {}, {}, []),
      layer(
        "https://example.test/mine.git",
        {
          dependencies: [{ url: base }],
          overrides: [{ repoPath: "panels/chat", source: base }],
        },
        {},
        ["panels/chat"]
      ),
    ]).keys(),
  ]).toEqual(["panels/chat"]);
});

it("keeps every service declared by an override while replacing the inherited services", () => {
  const base = "https://example.test/base.git";
  const service = (name: string) => ({ source: "workers/example", name });
  const merged = mergeTemplateManifests([
    layer(base, {}, { services: [service("old")] }, ["workers/example"]),
    layer(
      "https://example.test/mine.git",
      {
        dependencies: [{ url: base }],
        overrides: [{ repoPath: "workers/example", source: base }],
      },
      { services: [service("first"), service("second")] },
      ["workers/example"]
    ),
  ]);
  expect(merged.document["services"]).toEqual([service("first"), service("second")]);
});
