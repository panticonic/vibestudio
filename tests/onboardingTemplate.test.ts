import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseWorkspaceConfigContentWithId } from "@vibestudio/workspace/configParser";
import { prepareWorkspaceDistribution } from "@vibestudio/workspace/distribution";
import {
  canonicalTemplateYaml,
  parseTemplateManifestContent,
} from "@vibestudio/workspace/templateManifest";
import { mergeTemplateManifests } from "@vibestudio/workspace/templateManifestMerge";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";
import { exactUserlandRoot } from "./exactUserlandRoot";

const basePath = (...parts: string[]) => path.join(exactUserlandRoot, ...parts);

// Personal is built on Base, so Base supplies the repositories its runtime
// refers to but its own inventory no longer lists.
const baseDistribution = prepareWorkspaceDistribution({
  sourceRoot: exactUserlandRoot,
  manifestContent: fs.readFileSync(basePath("meta/distributions/base.yml"), "utf8"),
  expectedSystemEpoch: WORKSPACE_SYSTEM_EPOCH,
});
const distribution = prepareWorkspaceDistribution({
  sourceRoot: exactUserlandRoot,
  manifestContent: fs.readFileSync(basePath("meta/distributions/personal.yml"), "utf8"),
  expectedSystemEpoch: WORKSPACE_SYSTEM_EPOCH,
  providedRepositories: new Set(
    baseDistribution.repositories.filter((repoPath) => repoPath !== "meta")
  ),
});
const runtimeFile = distribution.files.find((file) => file.path === "meta/vibestudio.yml");
if (!runtimeFile || !("bytes" in runtimeFile))
  throw new Error("Personal runtime manifest was not generated");
const personalRuntime = new TextDecoder().decode(runtimeFile.bytes);

/** What a host materializes: Personal laid over the Base it is built on. */
const composedRuntime = canonicalTemplateYaml(
  mergeTemplateManifests([
    {
      label: "base",
      manifest: parseTemplateManifestContent(
        new TextDecoder().decode(
          (
            baseDistribution.files.find((file) => file.path === "meta/vibestudio.yml") as {
              bytes: Uint8Array;
            }
          ).bytes
        ),
        WORKSPACE_SYSTEM_EPOCH
      ),
    },
    {
      label: "personal",
      manifest: parseTemplateManifestContent(personalRuntime, WORKSPACE_SYSTEM_EPOCH),
    },
  ]).document
);

describe("shipped Personal first-run workspace", () => {
  it("is valid against the canonical workspace configuration contract, layer and composition alike", () => {
    // Personal names only the provider slots it adds, so its own manifest no
    // longer refers to extensions it does not declare — a layer stands on its
    // own now, and so does what a host actually materializes from it.
    expect(() => parseWorkspaceConfigContentWithId(personalRuntime, "shipped-layer")).not.toThrow();
    expect(() =>
      parseWorkspaceConfigContentWithId(composedRuntime, "shipped-template")
    ).not.toThrow();
  });

  it("automatically starts the single state-aware onboarding chat", () => {
    const source = personalRuntime;
    const manifest = parse(source) as {
      initPanels?: Array<{ source?: string; stateArgs?: Record<string, unknown> }>;
    };
    expect(manifest.initPanels).toEqual([
      expect.objectContaining({
        source: "panels/chat",
        stateArgs: expect.objectContaining({
          initialPrompt: "I just opened this workspace for the first time, help me get onboarded.",
          systemPrompt: expect.stringContaining("Vibestudio onboarding assistant"),
        }),
      }),
    ]);
    const stateArgs = manifest.initPanels?.[0]?.stateArgs ?? {};
    expect(Object.keys(stateArgs).sort()).toEqual(["initialPrompt", "systemPrompt"]);
    expect(stateArgs["systemPrompt"]).toEqual(expect.stringContaining("leading `client_eval`"));
    expect(stateArgs["systemPrompt"]).not.toEqual(
      expect.stringContaining("composeOnboardingOverview")
    );
    expect(stateArgs["systemPrompt"]).toEqual(
      expect.stringContaining("executeOnboardingSelection")
    );
    expect(stateArgs["systemPrompt"]).not.toEqual(
      expect.stringContaining("resolveOnboardingTemplateSelection")
    );
    expect(stateArgs["systemPrompt"]).toEqual(expect.stringContaining("SetupHub.tsx"));
    expect(stateArgs["systemPrompt"]).toEqual(expect.stringContaining("onboarding-setup-overview"));
    expect(stateArgs["systemPrompt"]).toEqual(
      expect.stringContaining("do not load or publish an action bar")
    );
    expect(stateArgs["systemPrompt"]).not.toEqual(expect.stringContaining("onboarding_snapshot"));
    expect(stateArgs["systemPrompt"]).not.toEqual(expect.stringContaining("onboarding_route"));
    expect(stateArgs["systemPrompt"]).not.toEqual(
      expect.stringContaining("Common starting points")
    );
    expect(stateArgs["systemPrompt"]).not.toEqual(
      expect.stringContaining("Everything runs locally on their machine")
    );
  });

  it("ships the onboarding UI and its local dependency closure without a native app", () => {
    // Its own additions; the chat panel and its runtime come from Base.
    expect(distribution.repositories).toEqual(
      expect.arrayContaining([
        "skills/onboarding",
        "about/credentials",
        "about/permissions",
        "about/local-models",
        "about/browser-import-inspector",
        "skills/phone-setup",
      ])
    );
    expect(distribution.repositories).not.toContain("panels/chat");
    expect(baseDistribution.repositories).toEqual(
      expect.arrayContaining(["panels/chat", "packages/agentic-chat", "packages/runtime"])
    );
    expect(distribution.repositories.some((repository) => repository.startsWith("apps/"))).toBe(
      false
    );
    for (const source of ["skills/onboarding/SKILL.md", "skills/onboarding/SetupHub.tsx"]) {
      expect(distribution.files.some((file) => file.path === source)).toBe(true);
    }
  });

  it("keeps onboarding in the inline transcript instead of a pinned action bar", () => {
    expect(fs.existsSync(basePath("skills/onboarding/ActionBar.tsx"))).toBe(false);

    for (const relativePath of [
      "skills/onboarding/SKILL.md",
      "skills/onboarding/GETTING_STARTED.md",
      "meta/distributions/personal.yml",
    ]) {
      const text = fs.readFileSync(basePath(relativePath), "utf8");
      expect(text).not.toMatch(/Common starting points|pinned action bar.*choice list/iu);
      expect(text).not.toContain("Preparing setup overview");
    }
  });

  it("does not retain the retired Hello Vanilla seed declaration or local source", () => {
    const source = personalRuntime;
    const manifest = parse(source) as {
      git?: {
        remotes?: Record<string, Record<string, Record<string, { url?: string; branch?: string }>>>;
        upstreams?: Record<
          string,
          Record<
            string,
            {
              remote?: string;
              branch?: string;
              credential?: string;
            }
          >
        >;
      };
    };

    expect(fs.existsSync(basePath("panels/hello-vanilla"))).toBe(false);
    expect(manifest.git?.remotes?.["panels"]?.["hello-vanilla"]).toBeUndefined();
    expect(manifest.git?.upstreams?.["panels"]?.["hello-vanilla"]).toBeUndefined();
  });
});
