import { describe, expect, it } from "vitest";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";
import { canonicalTemplateYaml, parseTemplateManifestContent } from "./templateManifest.js";
import { mergeTemplateManifests, type TemplateManifestLayer } from "./templateManifestMerge.js";

function layer(
  label: string,
  template: Record<string, unknown>,
  rest: Record<string, unknown> = {}
) {
  return {
    label,
    manifest: parseTemplateManifestContent(
      canonicalTemplateYaml({
        systemEpoch: WORKSPACE_SYSTEM_EPOCH,
        ...rest,
        template: { repositories: [], files: [], ...template },
      }),
      WORKSPACE_SYSTEM_EPOCH
    ),
  } satisfies TemplateManifestLayer;
}

describe("mergeTemplateManifests", () => {
  it("declares both layers' repositories so the base's files are not left unowned", () => {
    const merged = mergeTemplateManifests([
      layer("base", { repositories: ["meta", "panels/chat"], files: ["README.md"] }),
      layer("personal", { repositories: ["meta", "panels/news"], files: [] }),
    ]);

    expect(merged.inventory.repositories).toEqual(["meta", "panels/chat", "panels/news"]);
    expect(merged.inventory.files).toEqual(["README.md"]);
  });

  it("accumulates extension declarations so a dependent inherits what it builds on", () => {
    const merged = mergeTemplateManifests([
      layer("base", { repositories: ["meta"] }, { extensions: [{ source: "extensions/git" }] }),
      layer(
        "personal",
        { repositories: ["meta"] },
        { extensions: [{ source: "extensions/news" }] }
      ),
    ]);

    expect(merged.document["extensions"]).toEqual([
      { source: "extensions/git" },
      { source: "extensions/news" },
    ]);
  });

  it("resolves a setting to the last layer that stated it", () => {
    const merged = mergeTemplateManifests([
      layer("base", { repositories: ["meta"] }, { defaultRepo: "projects/default" }),
      layer("personal", { repositories: ["meta"] }, { panelRestorePolicy: "none" }),
    ]);

    // Personal never restated defaultRepo, so it keeps the one Base supplied.
    expect(merged.document["defaultRepo"]).toBe("projects/default");
    expect(merged.document["panelRestorePolicy"]).toBe("none");
  });

  it("lets the top layer override a setting its dependency stated", () => {
    const merged = mergeTemplateManifests([
      layer("base", { repositories: ["meta"] }, { defaultRepo: "projects/default" }),
      layer("system", { repositories: ["meta"] }, { defaultRepo: "projects/system" }),
    ]);
    expect(merged.document["defaultRepo"]).toBe("projects/system");
  });

  it("refuses two layers declaring one repository", () => {
    expect(() =>
      mergeTemplateManifests([
        layer("base", { repositories: ["meta", "panels/chat"] }),
        layer("personal", { repositories: ["meta", "panels/chat"] }),
      ])
    ).toThrow(/both declare repository panels\/chat: base and personal/u);
  });

  it("refuses two layers declaring one extension source", () => {
    expect(() =>
      mergeTemplateManifests([
        layer("base", { repositories: ["meta"] }, { extensions: [{ source: "extensions/git" }] }),
        layer(
          "personal",
          { repositories: ["meta"] },
          { extensions: [{ source: "extensions/git" }] }
        ),
      ])
    ).toThrow(/both declare source extensions:extensions\/git/u);
  });

  it("takes its name from the template at the top of the stack", () => {
    const merged = mergeTemplateManifests([
      layer("base", { name: "Base", description: "A foundation", repositories: ["meta"] }),
      layer("system", { name: "System", description: "Your device", repositories: ["meta"] }),
    ]);
    expect(merged.document["template"]).toMatchObject({
      name: "System",
      description: "Your device",
    });
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
          template: { repositories: ["meta"], files: [] },
        }),
        WORKSPACE_SYSTEM_EPOCH + 1
      ),
    };
    expect(() =>
      mergeTemplateManifests([other, layer("personal", { repositories: ["meta"] })])
    ).toThrow(/disagree about the workspace system epoch/u);
  });

  it("merges a record setting per slot so a layer can name only what it changes", () => {
    const merged = mergeTemplateManifests([
      layer(
        "base",
        { repositories: ["meta"] },
        {
          extensions: [{ source: "extensions/git-bridge" }],
          providers: {
            evalEngine: { source: "@workspace/eval" },
            gitInterop: { extension: "extensions/git-bridge" },
          },
        }
      ),
      layer(
        "personal",
        { repositories: ["meta"] },
        {
          extensions: [{ source: "extensions/browser-data" }],
          providers: { browserData: { extension: "extensions/browser-data" } },
        }
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
      layer(
        "base",
        { repositories: ["meta"] },
        { defaultAgentConfig: { model: "base-model", thinkingLevel: "high" } }
      ),
      layer("system", { repositories: ["meta"] }, { defaultAgentConfig: { model: "own-model" } }),
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
      layer("base", { repositories: ["meta"] }, { trust: { chromeApps: ["apps/base-shell"] } }),
      layer("system", { repositories: ["meta"] }, { trust: { chromeApps: ["apps/shell"] } }),
    ]);
    expect(merged.document["trust"]).toEqual({ chromeApps: ["apps/shell"] });
  });
});
