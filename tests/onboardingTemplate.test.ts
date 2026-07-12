import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("shipped first-run workspace", () => {
  it("opens one idle onboarding chat without impersonating the user or running system tests", () => {
    const source = fs.readFileSync(path.resolve("workspace/meta/vibestudio.yml"), "utf8");
    const manifest = parse(source) as {
      initPanels?: Array<{ source?: string; stateArgs?: Record<string, unknown> }>;
    };
    expect(manifest.initPanels).toHaveLength(1);
    expect(manifest.initPanels?.[0]).toMatchObject({
      source: "panels/chat",
      stateArgs: { actionBarFile: "skills/onboarding/ActionBar.tsx" },
    });
    expect(manifest.initPanels?.[0]?.stateArgs).not.toHaveProperty("initialPrompt");
    expect(source).not.toContain("run the full system test suite");
  });
});
