import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("shipped first-run workspace", () => {
  it("automatically starts the onboarding and system-testing chats", () => {
    const source = fs.readFileSync(path.resolve("workspace/meta/vibestudio.yml"), "utf8");
    const manifest = parse(source) as {
      initPanels?: Array<{ source?: string; stateArgs?: Record<string, unknown> }>;
    };
    expect(manifest.initPanels).toHaveLength(2);
    expect(manifest.initPanels?.[0]).toMatchObject({
      source: "panels/chat",
      stateArgs: {
        initialPrompt: "I just opened this workspace for the first time, help me get onboarded.",
        actionBarFile: "skills/onboarding/ActionBar.tsx",
      },
    });
    expect(manifest.initPanels?.[1]).toMatchObject({
      source: "panels/chat",
      stateArgs: {
        agentConfig: { model: "openai-codex:gpt-5.3-codex-spark" },
        initialPrompt: expect.stringContaining("run the full system test suite"),
        systemPrompt: expect.stringContaining("Vibestudio system testing agent"),
        systemPromptMode: "append",
      },
    });
  });
});
