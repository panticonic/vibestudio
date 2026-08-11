import { describe, expect, it, vi } from "vitest";
import {
  createTemplateManagementClient,
  templateMigrationPrompt,
  templateOperationStage,
  templateOperationTitle,
} from "./index.js";

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
    await client.add({ commandId: "add-1", source: { catalogId: "github" } });
    await client.adopt({ commandId: "adopt-1", pin });
    await client.pull({
      commandId: "pull-1",
      alias: "github",
      toRef: "refs/tags/v2",
      pin,
    });
    await client.remove({ commandId: "remove-1", alias: "github" });
    await client.suggest({ commandId: "suggest-1", alias: "github", parts: ["skills/github"] });
    await client.operations();
    await client.resume({ operationId: "operation-1" });
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
      [
        "@workspace-extensions/template-composer",
        "add",
        [{ commandId: "add-1", source: { catalogId: "github" } }],
      ],
      ["@workspace-extensions/template-composer", "adopt", [{ commandId: "adopt-1", pin }]],
      [
        "@workspace-extensions/template-composer",
        "pull",
        [{ commandId: "pull-1", alias: "github", toRef: "refs/tags/v2", pin }],
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
      ["@workspace-extensions/template-composer", "resume", [{ operationId: "operation-1" }]],
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

describe("template migration handoff", () => {
  const operation = {
    operationId: "host-release-v2",
    kind: "pull" as const,
    contextId: "template-operation-v2",
    initiator: "host-release" as const,
    target: { alias: "workspace-base", ref: "refs/tags/v2" },
    state: "repairing" as const,
    fingerprint: `v1-sha256:${"a".repeat(64)}`,
    migration: {
      facets: ["system"],
      notes: [
        {
          path: "migrations/system/runtime.md",
          title: "Runtime contract",
          degradedOk: false,
        },
      ],
    },
  };

  it("builds a human target label and exact in-context agent handoff", () => {
    expect(templateOperationTitle(operation)).toBe("workspace-base · v2");
    expect(templateOperationStage(operation)).toBe("Repair needed");
    expect(templateMigrationPrompt(operation)).toContain("Use the Templates skill");
    expect(templateMigrationPrompt(operation)).not.toContain("host-release-v2");
    expect(templateMigrationPrompt(operation)).toContain(
      "migrations/system/runtime.md: Runtime contract"
    );
  });
});
