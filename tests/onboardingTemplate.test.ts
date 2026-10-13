import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseWorkspaceConfigContentWithId } from "@vibestudio/workspace/configParser";
import {
  canonicalTemplateYaml,
  parseTemplateManifestContent,
} from "@vibestudio/workspace/templateManifest";
import { mergeTemplateManifests } from "@vibestudio/workspace/templateManifestMerge";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";
import { summarizeAuthorityRequests } from "@vibestudio/shared/authorityPresentation";
import {
  authorityRequestsFromManifest,
  capabilityPatternCovers,
} from "@vibestudio/shared/authorityManifest";
import { resourceScopeContains } from "@vibestudio/shared/authorization";
import { exactAllTemplateRoots, exactTemplateRoots } from "./exactUserlandRoot";

const basePath = (...parts: string[]) => path.join(exactTemplateRoots.base, ...parts);
const personalPath = (...parts: string[]) => path.join(exactTemplateRoots.personal, ...parts);
const readServiceManifest = (source: string): string | null => {
  const candidates = exactAllTemplateRoots
    .map((root) => path.join(root, source, "package.json"))
    .filter((candidate) => fs.existsSync(candidate));
  if (candidates.length !== 1) return null;
  return fs.readFileSync(candidates[0]!, "utf8");
};
const parseWorkspace = (content: string, id: string) =>
  parseWorkspaceConfigContentWithId(content, id, readServiceManifest);
const baseRuntime = fs.readFileSync(basePath("meta/vibestudio.yml"), "utf8");
const personalRuntime = fs.readFileSync(personalPath("meta/vibestudio.yml"), "utf8");
const baseManifest = parseTemplateManifestContent(baseRuntime, WORKSPACE_SYSTEM_EPOCH);
const personalManifest = parseTemplateManifestContent(personalRuntime, WORKSPACE_SYSTEM_EPOCH);
const systemTestingRoot = exactTemplateRoots["system-testing"];
if (!systemTestingRoot) throw new Error("The System-testing source checkout is required");
const systemTestingManifest = parseTemplateManifestContent(
  fs.readFileSync(path.join(systemTestingRoot, "meta/vibestudio.yml"), "utf8"),
  WORKSPACE_SYSTEM_EPOCH
);
const composedRuntime = canonicalTemplateYaml(
  mergeTemplateManifests([
    { label: "base", manifest: baseManifest },
    { label: "system-testing", manifest: systemTestingManifest },
    { label: "personal", manifest: personalManifest },
  ]).document
);

describe("shipped Personal first-run workspace", () => {
  it("declares native model admission for every shipping agent worker", () => {
    for (const source of [
      "workers/agent-worker",
      "workers/silent-agent-worker",
      "workers/mission-agent",
      "workers/explorer-agent",
      "workers/system-agent",
      "workers/gmail-agent",
      "workers/news-agent",
      "workers/adventure-agents",
      "workers/grimoire-agents",
      "workers/regency-agents",
    ]) {
      const content = readServiceManifest(source);
      expect(content, source).not.toBeNull();
      const manifest = JSON.parse(content!) as { vibestudio: { authority?: unknown } };
      const requests = authorityRequestsFromManifest(manifest.vibestudio, source);
      // Unit discovery uses this review projection before the desktop can launch.
      expect(
        () =>
          summarizeAuthorityRequests(
            requests.filter((request) => request.capability === "model.use")
          ),
        source
      ).not.toThrow();
      // The host selects the exact provider/model/account at invocation time;
      // local models use the same admission contract with a runtime resource.
      for (const key of [
        "model:openai-codex/gpt-6.1-sol@openai-codex%3Aaccount-1",
        "model:anthropic/claude-sonnet@credential%3Aaccount-2",
        "model:local/qwen@runtime",
      ]) {
        expect(
          requests.some(
            (request) =>
              capabilityPatternCovers(request.capability, "model.use") &&
              resourceScopeContains(request.resource, { kind: "exact", key })
          ),
          `${source} must request model.use for ${key}`
        ).toBe(true);
      }
    }
  });

  it("is valid as its own source and with development layers", () => {
    expect(() => parseWorkspace(personalRuntime, "personal-layer")).not.toThrow();
    expect(() => parseWorkspace(composedRuntime, "personal-workspace")).not.toThrow();
    expect(personalManifest.dependencies.map(({ url }) => url)).toEqual([
      "git+https://github.com/panticonic/vibestudio-base.git",
    ]);
  });

  it("leaves model selection to live settings instead of shipping a provider requirement", () => {
    for (const runtime of [baseRuntime, personalRuntime, composedRuntime]) {
      expect(
        (parse(runtime) as { defaultAgentConfig?: unknown }).defaultAgentConfig
      ).toBeUndefined();
    }
  });

  it("automatically starts the single state-aware onboarding chat", () => {
    const manifest = parse(personalRuntime) as {
      initPanels?: Array<{ source?: string; stateArgs?: Record<string, unknown> }>;
    };
    expect(manifest.initPanels).toEqual([
      expect.objectContaining({
        source: "panels/chat",
        stateArgs: expect.objectContaining({
          seed: expect.objectContaining({
            openingRequest:
              "I just opened this workspace for the first time, help me get onboarded.",
            messages: [expect.objectContaining({ content: expect.stringContaining("<Video") })],
          }),
          systemPrompt: expect.stringContaining("Vibestudio onboarding assistant"),
        }),
      }),
    ]);
    const effective = parseWorkspace(composedRuntime, "personal-workspace");
    expect(effective.initPanels).toEqual(manifest.initPanels);
    const systemPrompt = manifest.initPanels?.[0]?.stateArgs?.["systemPrompt"];
    expect(systemPrompt).toEqual(expect.stringContaining("executeOnboardingSelection"));
    expect(systemPrompt).toEqual(expect.stringContaining("SetupHub.tsx"));
    expect(systemPrompt).toEqual(expect.stringContaining("onboarding-setup-overview"));
    expect(systemPrompt).not.toEqual(expect.stringContaining("composeOnboardingOverview"));
    expect(systemPrompt).not.toEqual(expect.stringContaining("Common starting points"));
  });

  it("owns only Personal additions and receives common runtime from Base", () => {
    expect(personalManifest.dependencies.map(({ url }) => url)).toContain(
      "git+https://github.com/panticonic/vibestudio-base.git"
    );
    for (const source of [
      "skills/onboarding/SKILL.md",
      "skills/onboarding/SetupHub.tsx",
      "panels/tour/index.tsx",
    ]) {
      expect(fs.existsSync(personalPath(source))).toBe(true);
    }
    for (const source of ["panels/chat", "packages/agentic-chat", "packages/runtime"]) {
      expect(fs.existsSync(basePath(source))).toBe(true);
      expect(fs.existsSync(personalPath(source))).toBe(false);
    }
  });

  it("keeps onboarding in the inline transcript instead of a pinned action bar", () => {
    expect(fs.existsSync(personalPath("skills/onboarding/ActionBar.tsx"))).toBe(false);
    for (const relativePath of [
      "skills/onboarding/SKILL.md",
      "skills/onboarding/GETTING_STARTED.md",
      "meta/vibestudio.yml",
    ]) {
      const text = fs.readFileSync(personalPath(relativePath), "utf8");
      expect(text).not.toMatch(/Common starting points|pinned action bar.*choice list/iu);
      expect(text).not.toContain("Preparing setup overview");
    }
  });

  it("does not retain the retired Hello Vanilla seed", () => {
    const manifest = parse(personalRuntime) as { git?: { remotes?: object; upstreams?: object } };
    expect(fs.existsSync(personalPath("panels/hello-vanilla"))).toBe(false);
    expect(JSON.stringify(manifest.git ?? {})).not.toContain("hello-vanilla");
  });
});
