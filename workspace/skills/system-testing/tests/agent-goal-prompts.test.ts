import { describe, expect, it } from "vitest";
import { buildTests } from "./build.js";
import { localModelTests } from "./local-models.js";
import { trustedUnitAuthoringTests } from "./trusted-unit-authoring.js";

function named<T extends { name: string }>(tests: T[], name: string): T {
  const test = tests.find((candidate) => candidate.name === name);
  if (!test) throw new Error(`Missing system test ${name}`);
  return test;
}

describe("agent-goal prompt boundaries", () => {
  it("leaves the extension and app development workflow to product guidance", () => {
    for (const test of trustedUnitAuthoringTests) {
      expect(test.prompt).not.toMatch(/\b(?:test|build|verify|commit|save|publish|workflow)\b/iu);
    }
  });

  it("leaves profiling, verification, and persistence out of the optimization prompt", () => {
    const prompt = named(buildTests, "panel-performance-optimize").prompt;
    expect(prompt).not.toMatch(
      /\b(?:profile|measure|benchmark|build|verify|commit|save|publish)\b/iu
    );
  });

  it("asks for a local-model outcome without prescribing model installation", () => {
    const prompt = named(localModelTests, "local-model-download-and-task").prompt;
    expect(prompt).not.toMatch(/\b(?:download|install|ensureLoaded)\b/iu);
  });
});
