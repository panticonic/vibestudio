import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("shipped first-run workspace", () => {
  it("automatically starts the single state-aware onboarding chat", () => {
    const source = fs.readFileSync(path.resolve("workspace/meta/vibestudio.yml"), "utf8");
    const manifest = parse(source) as {
      initPanels?: Array<{ source?: string; stateArgs?: Record<string, unknown> }>;
    };
    expect(manifest.initPanels).toEqual([
      expect.objectContaining({
        source: "panels/chat",
        stateArgs: expect.objectContaining({
          initialPrompt: "I just opened this workspace for the first time, help me get onboarded.",
          actionBarFile: "skills/onboarding/ActionBar.tsx",
          systemPrompt: expect.stringContaining("Vibestudio onboarding assistant"),
        }),
      }),
    ]);
    const stateArgs = manifest.initPanels?.[0]?.stateArgs ?? {};
    expect(Object.keys(stateArgs).sort()).toEqual([
      "actionBarFile",
      "initialPrompt",
      "systemPrompt",
    ]);
    expect(stateArgs["systemPrompt"]).toEqual(expect.stringContaining("client_eval"));
    expect(stateArgs["systemPrompt"]).toEqual(expect.stringContaining("composeOnboardingSnapshot"));
    expect(stateArgs["systemPrompt"]).toEqual(
      expect.stringContaining("executeOnboardingSelection")
    );
    expect(stateArgs["systemPrompt"]).toEqual(expect.stringContaining("SetupHub.tsx"));
    expect(stateArgs["systemPrompt"]).not.toEqual(expect.stringContaining("onboarding_snapshot"));
    expect(stateArgs["systemPrompt"]).not.toEqual(expect.stringContaining("onboarding_route"));
    expect(stateArgs["systemPrompt"]).not.toEqual(
      expect.stringContaining("Common starting points")
    );
    expect(stateArgs["systemPrompt"]).not.toEqual(
      expect.stringContaining("Everything runs locally on their machine")
    );
  });

  it("keeps the action bar compact and prevents the retired feature menu from drifting back", () => {
    const actionBar = fs.readFileSync(
      path.resolve("workspace/skills/onboarding/ActionBar.tsx"),
      "utf8"
    );
    expect(actionBar).toContain("Preparing setup overview");
    expect(actionBar).not.toContain("actionGroups");
    expect(actionBar).not.toContain("Pick a path");

    for (const relativePath of [
      "workspace/skills/onboarding/SKILL.md",
      "workspace/skills/onboarding/GETTING_STARTED.md",
      "workspace/meta/vibestudio.yml",
    ]) {
      const text = fs.readFileSync(path.resolve(relativePath), "utf8");
      expect(text).not.toMatch(/Common starting points|pinned action bar.*choice list/iu);
    }
  });
});
