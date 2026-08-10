import { describe, expect, it, vi } from "vitest";
import { createTemplateManagementClient } from "./index.js";

describe("createTemplateManagementClient", () => {
  it("exposes the complete template-composer API through one invocation path", async () => {
    const invoke = vi.fn(async () => undefined);
    const client = createTemplateManagementClient(invoke);
    const pin = {
      url: "git+https://example.test/template.git",
      ref: "refs/tags/v1",
      commit: "a".repeat(40),
      snapshot: `v1-sha256:${"b".repeat(64)}` as const,
    };

    await client.status();
    await client.catalog({ refresh: true });
    await client.check({ alias: "github" });
    await client.inspect({ url: "https://example.test/template.git" });
    await client.prepareAdd({ catalogId: "github" });
    await client.add({ commandId: "add-1", pin });
    await client.adopt({ commandId: "adopt-1", pin });
    await client.pull({ commandId: "pull-1", alias: "github", toRef: "refs/tags/v2" });
    await client.remove({ commandId: "remove-1", alias: "github" });
    await client.suggest({ commandId: "suggest-1", alias: "github", parts: ["skills/github"] });
    await client.operations();
    await client.resume({ operationId: "operation-1", onBuildFailure: "discard-context" });
    await client.cancel({ operationId: "operation-2" });
    await client.decideSuggestion({
      commandId: "decision-1",
      alias: "github",
      section: "trust",
      decision: "accept",
    });

    expect(invoke.mock.calls).toEqual([
      ["@workspace-extensions/template-composer", "status", []],
      ["@workspace-extensions/template-composer", "catalog", [{ refresh: true }]],
      ["@workspace-extensions/template-composer", "check", [{ alias: "github" }]],
      [
        "@workspace-extensions/template-composer",
        "inspect",
        [{ url: "https://example.test/template.git" }],
      ],
      ["@workspace-extensions/template-composer", "prepareAdd", [{ catalogId: "github" }]],
      ["@workspace-extensions/template-composer", "add", [{ commandId: "add-1", pin }]],
      ["@workspace-extensions/template-composer", "adopt", [{ commandId: "adopt-1", pin }]],
      [
        "@workspace-extensions/template-composer",
        "pull",
        [{ commandId: "pull-1", alias: "github", toRef: "refs/tags/v2" }],
      ],
      [
        "@workspace-extensions/template-composer",
        "remove",
        [{ commandId: "remove-1", alias: "github" }],
      ],
      [
        "@workspace-extensions/template-composer",
        "suggest",
        [{ commandId: "suggest-1", alias: "github", parts: ["skills/github"] }],
      ],
      ["@workspace-extensions/template-composer", "operations", []],
      [
        "@workspace-extensions/template-composer",
        "resume",
        [{ operationId: "operation-1", onBuildFailure: "discard-context" }],
      ],
      ["@workspace-extensions/template-composer", "cancel", [{ operationId: "operation-2" }]],
      [
        "@workspace-extensions/template-composer",
        "decideSuggestion",
        [
          {
            commandId: "decision-1",
            alias: "github",
            section: "trust",
            decision: "accept",
          },
        ],
      ],
    ]);
  });
});
