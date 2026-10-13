import { describe, expect, it } from "vitest";
import { runEmbeddedMoonPermit } from "./embeddedMoonPermit";
import { inventorModelScript } from "./inventorModelScript";

describe("scripted inventor output", () => {
  it("uses the public runtime client instead of embedding raw RPC method names", () => {
    const generatedFiles = inventorModelScript.rules.flatMap((rule) =>
      rule.steps.flatMap((step) =>
        step.tool === "write" && typeof step.arguments.content === "string"
          ? [step.arguments.content]
          : []
      )
    );

    expect(generatedFiles).not.toHaveLength(0);
    for (const source of generatedFiles) {
      expect(source).toContain("workspace.runtime.createEntity(");
      expect(source).toContain('data-directory="{{directory}}"');
      expect(source).toContain('status.dataset["state"] = state');
      expect(source).toContain('setStatus("working"');
      expect(source).toContain('setStatus("complete"');
      expect(source).toContain('setStatus("failed"');
      expect(source).toContain("workspace.formatRpcFailure(error)");
      expect(source).not.toContain("error.message");
      expect(source).not.toMatch(
        /\.rpc\.(?:call|stream|streamReadable)\(\s*["'](?:main|server|self)["']\s*,\s*["']/u
      );
    }
  });

  it("serializes a self-contained executable function", () => {
    const source = runEmbeddedMoonPermit.toString();
    expect(() => Function(`return (${source})`)()).not.toThrow();
    expect(source).toContain("workspace.runtime.createEntity");
  });
});
