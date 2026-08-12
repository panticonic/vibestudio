import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function compact(name: "SKILL.md" | "API.md"): string {
  return readFileSync(new URL(name, import.meta.url), "utf8").replace(/\s+/gu, " ");
}

describe("Automations skill contract", () => {
  it("documents the complete agent-to-review workflow", () => {
    const skill = compact("SKILL.md");

    expect(skill).toContain("Use this skill when a user asks to run work repeatedly or later");
    expect(skill).toContain("**Method** runs one RPC method");
    expect(skill).toContain("**Agent** sends a prompt through the ordinary agent turn loop");
    expect(skill).toContain("exact inline `eval` code executed without a model call");
    expect(skill).toContain("does not require a new worker");
    expect(skill).toContain("proposeDraft");
    expect(skill).toContain("inert draft is waiting in **Automations** for review");
    expect(skill).toContain("Do not call `requestReview` for them");
  });

  it("documents supervision, history, conversations, results, and errors", () => {
    const skill = compact("SKILL.md");
    const api = compact("API.md");

    expect(skill).toContain("failures from the last 24 hours");
    expect(skill).toContain("paged history");
    expect(skill).toContain("completion response or result/error");
    expect(skill).toContain("links to the exact conversation");
    expect(api).toContain("canonical deep-link identity for that conversation");
    expect(skill).toContain("chat-history pill");
    expect(skill).toContain("Collapsed transcript pills perform no service reads");
    expect(skill).toContain(
      "Agents can use the agent-facing `edit`, `runNow`, `pause`, `resume`, and"
    );
    expect(api).toContain("`requestReview` is intentionally not agent-facing");
  });

  it("documents interval, calendar, finite, and natural-completion schedules", () => {
    const skill = compact("SKILL.md");
    const api = compact("API.md");

    expect(skill).toContain('kind: "schedule"');
    expect(skill).toContain('kind: "cron"');
    expect(skill).toContain('expression: "5 5 * * THU"');
    expect(skill).toContain('timezone: "America/New_York"');
    expect(skill).toContain("no run begins at or after");
    expect(skill).toContain("failed runs count, while visible overlap skips do not");
    expect(skill).toContain("`complete_automation` tool");
    expect(api).toContain('protocol: "automation-completion.v1"');
    expect(api).toContain("transitions the definition to `completed`");
  });
});
