import { describe, expect, it } from "vitest";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";
import {
  canonicalTemplateYaml,
  parseTemplateManifestContent,
  rootRuntimeFromTemplateManifest,
  templateRepositories,
  authoredTemplateManifest,
} from "./templateManifest.js";

describe("current template manifest", () => {
  it("exports dependency differences and refuses to silently restore removed settings", () => {
    const url = "https://example.test/base.git";
    const dependency = canonicalTemplateYaml({
      systemEpoch: WORKSPACE_SYSTEM_EPOCH,
      services: [{ source: "workers/example", name: "example" }],
      trust: { chromeApps: ["apps/shell"] },
    });
    const installation = {
      sources: [
        { pin: { url, ref: "refs/heads/main", commit: "a".repeat(40) }, manifest: dependency },
      ],
    };
    const desired = parseTemplateManifestContent(
      canonicalTemplateYaml({
        systemEpoch: WORKSPACE_SYSTEM_EPOCH,
        template: { dependencies: [{ url }] },
        services: [{ source: "workers/example", name: "example" }],
        trust: { chromeApps: ["apps/shell"] },
      }),
      WORKSPACE_SYSTEM_EPOCH
    );
    const authored = authoredTemplateManifest(desired, installation);
    expect(authored.top.services).toBeUndefined();
    expect(authored.top.trust).toBeUndefined();
    expect(authored.dependencies).toEqual([{ url }]);
    desired.top.services = [];
    expect(() => authoredTemplateManifest(desired, installation)).toThrow(
      /cannot reproduce the desired workspace settings/
    );
  });
  it("needs no authored inventory and rejects the removed field", () => {
    expect(() =>
      parseTemplateManifestContent(
        `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\ntemplate: { name: Test }\n`,
        WORKSPACE_SYSTEM_EPOCH
      )
    ).not.toThrow();
    expect(() =>
      parseTemplateManifestContent(
        `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\ntemplate: { repositories: [] }\n`,
        WORKSPACE_SYSTEM_EPOCH
      )
    ).toThrow(/repositories/);
  });

  it("rejects a null template block instead of treating it as absent", () => {
    expect(() =>
      parseTemplateManifestContent(
        `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\ntemplate: null\n`,
        WORKSPACE_SYSTEM_EPOCH
      )
    ).toThrow();
  });

  it("derives all repositories from the exact tree, including content-only units", () => {
    expect(
      templateRepositories([
        "meta/vibestudio.yml",
        "meta/notes.md",
        "panels/test/index.tsx",
        "panels/other/index.tsx",
        "projects/notes/README.md",
        "skills/example/SKILL.md",
      ])
    ).toEqual(["meta", "panels/other", "panels/test", "projects/notes", "skills/example"]);
    expect(templateRepositories(["meta/vibestudio.yml"])).toEqual(["meta"]);
  });

  it("rejects a missing manifest and source outside repository boundaries", () => {
    expect(() => templateRepositories(["panels/test/index.tsx"])).toThrow(/missing required/);
    for (const path of [
      "README.md",
      "panels/stray.ts",
      "unknown/unit/file.ts",
      "agents/example/file.ts",
      "panels/example/../outside.ts",
      "/meta/file",
      "meta//file",
    ])
      expect(() => templateRepositories(["meta/vibestudio.yml", path])).toThrow(
        /repository layout/
      );
  });

  it("projects a workspace snapshot manifest directly into its runtime", () => {
    const root = parseTemplateManifestContent(
      `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}
template: {}
routes: []
providers:
  evalRuntime:
    source: "@workspace/runtime"
trust:
  chromeApps: [apps/shell]
`,
      WORKSPACE_SYSTEM_EPOCH
    );

    expect(canonicalTemplateYaml(rootRuntimeFromTemplateManifest(root))).toBe(
      `providers:\n  evalRuntime:\n    source: "@workspace/runtime"\nroutes: []\nsystemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\ntrust:\n  chromeApps:\n    - apps/shell\n`
    );
  });

  it("rejects composition-only fields at manifest parsing", () => {
    expect(() =>
      parseTemplateManifestContent(
        `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}
template: {}
disable: [routes/example]
`,
        WORKSPACE_SYSTEM_EPOCH
      )
    ).toThrow(/unrecognized key.*disable/iu);
  });

  it("reads the templates a manifest is built on, and defaults to standing alone", () => {
    const base = "git+https://example.test/base.git";
    const withDependency = parseTemplateManifestContent(
      canonicalTemplateYaml({
        systemEpoch: WORKSPACE_SYSTEM_EPOCH,
        template: {
          name: "Personal",
          description: "Built on Base",
          dependencies: [{ url: base }],
        },
      }),
      WORKSPACE_SYSTEM_EPOCH
    );
    // Neither a track nor a commit: the dependency follows Base's releases, so
    // two templates built on it agree without either naming a version.
    expect(withDependency.dependencies).toEqual([{ url: base }]);

    const standalone = parseTemplateManifestContent(
      canonicalTemplateYaml({
        systemEpoch: WORKSPACE_SYSTEM_EPOCH,
        template: {},
      }),
      WORKSPACE_SYSTEM_EPOCH
    );
    expect(standalone.dependencies).toEqual([]);
  });

  it("keeps a deliberately frozen dependency, and refuses an unknown key beside it", () => {
    const base = "git+https://example.test/base.git";
    const frozen = parseTemplateManifestContent(
      canonicalTemplateYaml({
        systemEpoch: WORKSPACE_SYSTEM_EPOCH,
        template: {
          dependencies: [{ url: base, track: "refs/tags/v*", commit: "a".repeat(40) }],
        },
      }),
      WORKSPACE_SYSTEM_EPOCH
    );
    expect(frozen.dependencies).toEqual([
      { url: base, track: "refs/tags/v*", commit: "a".repeat(40) },
    ]);

    expect(() =>
      parseTemplateManifestContent(
        canonicalTemplateYaml({
          systemEpoch: WORKSPACE_SYSTEM_EPOCH,
          template: {
            dependencies: [{ url: base, version: "2" }],
          },
        }),
        WORKSPACE_SYSTEM_EPOCH
      )
    ).toThrow(/unrecognized key.*version/iu);
  });
});

it("rejects the removed standalone-files field and unowned root files", () => {
  expect(() =>
    parseTemplateManifestContent(
      canonicalTemplateYaml({
        systemEpoch: WORKSPACE_SYSTEM_EPOCH,
        template: { files: ["README.md"] },
      }),
      WORKSPACE_SYSTEM_EPOCH
    )
  ).toThrow(/files/);
  expect(() => templateRepositories(["meta/vibestudio.yml", "README.md"])).toThrow(
    /repository layout/
  );
});
