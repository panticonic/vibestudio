import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("shipped first-run workspace", () => {
  it("automatically starts the single onboarding chat", () => {
    const source = fs.readFileSync(path.resolve("workspace/meta/vibestudio.yml"), "utf8");
    const manifest = parse(source) as {
      initPanels?: Array<{ source?: string; stateArgs?: Record<string, unknown> }>;
    };
    expect(manifest.initPanels).toEqual([
      expect.objectContaining({
        source: "panels/chat",
        stateArgs: expect.objectContaining({
          actionBarFile: "skills/onboarding/ActionBar.tsx",
          systemPrompt: expect.stringContaining("Vibestudio onboarding assistant"),
        }),
      }),
    ]);
  });
});
