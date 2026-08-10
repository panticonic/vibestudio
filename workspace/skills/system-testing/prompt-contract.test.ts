import { describe, expect, it } from "vitest";

import { agentGoalPromptFindings, assertSystemTestDeclaration } from "./prompt-contract.js";
import type { TestCase } from "./types.js";

const agentCase = (prompt: string): TestCase => ({
  name: "natural-agent-goal",
  description: "fixture",
  category: "fixture",
  prompt,
  validate: () => ({ passed: true }),
});

describe("agent-goal prompt contract", () => {
  it("accepts an outcome stated at the user's level", () => {
    const prompt =
      "Delegate independent parts of this fixture task, integrate the useful results, verify the package, and summarize any supervision difficulties.";
    expect(agentGoalPromptFindings(prompt)).toEqual([]);
    expect(() => assertSystemTestDeclaration(agentCase(prompt))).not.toThrow();
  });

  it.each([
    ["internal tools", "Call spawn_subagent and then merge_subagent."],
    ["API calls", "Use extensions.invoke('shell', 'exec', [request])."],
    ["runtime configuration", "Set agentKind:'pi' and thinkingLevel:'minimal'."],
    ["call choreography", "Using exactly one eval call, return exactly { ok: true }."],
  ])("rejects %s embedded in an agent goal", (_label, prompt) => {
    expect(agentGoalPromptFindings(prompt)).not.toEqual([]);
    expect(() => assertSystemTestDeclaration(agentCase(prompt))).toThrow(/user outcome/u);
  });

  it("allows exact choreography only for an explicit harness probe", () => {
    const test: TestCase = {
      ...agentCase("Using exactly one eval call, return exactly { ok: true }."),
      validation: "harness",
      validate: () => ({ passed: true }),
    };
    expect(() => assertSystemTestDeclaration(test)).not.toThrow();
  });

  it("requires harness probes to keep their deterministic validator", () => {
    const test = {
      ...agentCase("Harness-orchestrated protocol probe."),
      validation: "harness",
      validate: undefined,
    } as unknown as TestCase;
    expect(() => assertSystemTestDeclaration(test)).toThrow(/no deterministic validator/u);
  });
});
