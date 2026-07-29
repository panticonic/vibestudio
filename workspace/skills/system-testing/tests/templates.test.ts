import { describe, expect, it } from "vitest";
import type { TestExecutionResult } from "../types.js";
import { templateTests } from "./templates.js";

function execution(
  returnValue: unknown,
  final: string,
  options: { code?: string; console?: string } = {}
): TestExecutionResult {
  return {
    duration: 0,
    messages: [
      { kind: "message", senderId: "user", complete: true, content: "prompt" },
      {
        kind: "message",
        senderId: "agent",
        complete: true,
        contentType: "invocation",
        invocation: {
          id: "template-overview",
          name: "eval",
          arguments: {
            code:
              options.code ??
              [
                'const status = await extensions.invoke("@workspace-extensions/template-composer", "status", []);',
                "let catalog;",
                "try {",
                '  catalog = await extensions.invoke("@workspace-extensions/template-composer", "catalog", []);',
                "} catch {",
                "  return { statusCount: status.length, catalogUnavailable: true };",
                "}",
                "return { statusCount: status.length, catalogCount: catalog.entries.length, firstCatalog: catalog.entries[0] };",
              ].join("\n"),
          },
          execution: {
            status: "complete",
            isError: false,
            result: { details: { returnValue, console: options.console } },
          },
        },
      },
      { kind: "message", senderId: "agent", complete: true, content: final },
    ],
  } as TestExecutionResult;
}

describe("template agentic validator", () => {
  it("accepts a fresh workspace with no connected or featured templates", () => {
    const test = templateTests.find(({ name }) => name === "templates-status-catalog")!;
    expect(
      test.validate(
        execution(
          {
            statusCount: 0,
            catalogCount: 0,
          },
          "There are 0 connected templates and 0 catalog entries."
        )
      )
    ).toEqual({ passed: true, reason: undefined });
  });

  it("accepts an honest absent-cache result without losing template status", () => {
    const test = templateTests.find(({ name }) => name === "templates-status-catalog")!;
    expect(
      test.validate(
        execution(
          {
            connectedTemplatesCount: 0,
            catalogUnavailable: true,
          },
          "There are 0 connected templates. The verified catalog cache is unavailable."
        )
      )
    ).toEqual({ passed: true, reason: undefined });
  });

  it("accepts cached-registry unavailable wording", () => {
    const test = templateTests.find(({ name }) => name === "templates-status-catalog")!;
    expect(
      test.validate(
        execution(
          { connectedTemplatesCount: 0, catalogUnavailable: true },
          "Connected templates: 0. Cached verified registry: unavailable.",
          {
            code: [
              "const call = (method, args = []) => extensions.invoke('@workspace-extensions/template-composer', method, args);",
              "const status = await call('status', []);",
              "await call('catalog', []);",
              "return { connectedTemplatesCount: status.length, catalogUnavailable: true };",
            ].join("\n"),
          }
        )
      )
    ).toEqual({ passed: true, reason: undefined });
  });

  it("accepts captured console evidence from a successful cache-only observation", () => {
    const test = templateTests.find(({ name }) => name === "templates-status-catalog")!;
    expect(
      test.validate(
        execution(undefined, "0 connected templates. Catalog cache unavailable.", {
          code: [
            "const status = await extensions.invoke('@workspace-extensions/template-composer', 'status', []);",
            "console.log('status ok', JSON.stringify(status));",
            "try {",
            "  await extensions.invoke('@workspace-extensions/template-composer', 'catalog', []);",
            "} catch (error) { console.log(String(error)); }",
          ].join("\n"),
          console: "status ok []\nNo verified template registry is cached; refresh first",
        })
      )
    ).toEqual({ passed: true, reason: undefined });
  });

  it("accepts the typed runtime proxy after an agent uses a local type assertion", () => {
    const test = templateTests.find(({ name }) => name === "templates-status-catalog")!;
    expect(
      test.validate(
        execution(
          {
            connectedTemplatesCount: 0,
            catalogUnavailable: true,
          },
          "There are 0 connected templates. The verified catalog cache is unavailable.",
          {
            code: [
              'const status = await (extensions as any).invoke("@workspace-extensions/template-composer", "status", []);',
              'await (extensions as any).invoke("@workspace-extensions/template-composer", "catalog", []);',
            ].join("\n"),
          }
        )
      )
    ).toEqual({ passed: true, reason: undefined });
  });

  it("accepts an exact preparation-only authoring plan", () => {
    const test = templateTests.find(({ name }) => name === "templates-authoring-prepare")!;
    const fingerprint = `v1-sha256:${"a".repeat(64)}`;
    expect(
      test.validate(
        execution(
          {
            available: [{ repoPath: "packages/template-composer" }],
            plan: {
              mainEventId: "event:main",
              fingerprint,
              requestedParts: ["packages/template-composer"],
              includedParts: ["packages/template-composer", "packages/shared"],
              requiredParts: ["packages/shared"],
              inheritedParts: [],
              manifest: "systemEpoch: 57\n",
            },
          },
          `Prepared the template plan with fingerprint ${fingerprint}. Nothing was published.`,
          {
            code: [
              "const available = await extensions.invoke('@workspace-extensions/template-composer', 'authoringParts', []);",
              "const plan = await extensions.invoke('@workspace-extensions/template-composer', 'inspectAuthoring', [{ name: 'Composer', description: 'Template composer', parts: ['packages/template-composer'] }]);",
              "return { available, plan };",
            ].join("\n"),
          }
        )
      )
    ).toEqual({ passed: true, reason: undefined });
  });

  it("accepts a structured console receipt when the composer is held in a variable", () => {
    const test = templateTests.find(({ name }) => name === "templates-authoring-prepare")!;
    const fingerprint = `v1-sha256:${"b".repeat(64)}`;
    const plan = {
      fingerprint,
      selectedParts: ["packages/template-composer"],
      includedParts: ["packages/template-composer"],
      requiredParts: [],
      inheritedParts: [],
      manifest: "systemEpoch: 57\n",
    };
    expect(
      test.validate(
        execution(
          undefined,
          `The exact fingerprint is ${fingerprint}. Nothing was published.`,
          {
            code: [
              "const composer = '@workspace-extensions/template-composer';",
              "const available = await rpc.call('main', 'extensions.invoke', [composer, 'authoringParts', []]);",
              "const plan = await rpc.call('main', 'extensions.invoke', [composer, 'inspectAuthoring', [{ name: 'Composer', description: 'Template composer', parts: ['packages/template-composer'] }]]);",
              "console.log(JSON.stringify(plan));",
            ].join("\n"),
            console: JSON.stringify(plan),
          }
        )
      )
    ).toEqual({ passed: true, reason: undefined });
  });

  it("rejects an authoring trajectory that published in the preparation-only scenario", () => {
    const test = templateTests.find(({ name }) => name === "templates-authoring-prepare")!;
    expect(
      test.validate(
        execution(
          {
            mainEventId: "event:main",
            fingerprint: `v1-sha256:${"a".repeat(64)}`,
            requestedParts: ["packages/template-composer"],
            includedParts: ["packages/template-composer"],
            manifest: "systemEpoch: 57\n",
          },
          "Published.",
          {
            code: [
              "await extensions.invoke('@workspace-extensions/template-composer', 'authoringParts', []);",
              "const plan = await extensions.invoke('@workspace-extensions/template-composer', 'inspectAuthoring', [{ name: 'Composer', description: 'Template composer', parts: ['packages/template-composer'] }]);",
              "await extensions.invoke('@workspace-extensions/template-composer', 'publishAuthoring', [{ plan }]);",
              "return plan;",
            ].join("\n"),
          }
        )
      )
    ).toMatchObject({ passed: false });
  });

  it("accepts the reported exact receipt after an earlier draft inspection", () => {
    const test = templateTests.find(({ name }) => name === "templates-authoring-prepare")!;
    const firstFingerprint = `v1-sha256:${"c".repeat(64)}`;
    const finalFingerprint = `v1-sha256:${"d".repeat(64)}`;
    const exactPlan = (fingerprint: string) => ({
      mainEventId: "event:main",
      fingerprint,
      requestedParts: ["packages/template-composer"],
      includedParts: ["packages/template-composer"],
      requiredParts: [],
      inheritedParts: [],
      manifest: "systemEpoch: 57\n",
    });
    expect(
      test.validate(
        execution(
          {
            drafts: [exactPlan(firstFingerprint), exactPlan(finalFingerprint)],
          },
          `Prepared the final template plan with fingerprint ${finalFingerprint}. Nothing was published.`,
          {
            code: [
              "const composer = '@workspace-extensions/template-composer';",
              "await extensions.invoke(composer, 'authoringParts', []);",
              "await extensions.invoke(composer, 'inspectAuthoring', [{ name: 'Draft', description: 'First draft', parts: ['packages/template-composer'] }]);",
              "return await extensions.invoke(composer, 'inspectAuthoring', [{ name: 'Final', description: 'Final draft', parts: ['packages/template-composer'] }]);",
            ].join("\n"),
          }
        )
      )
    ).toEqual({ passed: true, reason: undefined });
  });

  it("reconstructs one receipt when shared plan values are serialized separately", () => {
    const test = templateTests.find(({ name }) => name === "templates-authoring-prepare")!;
    const fingerprint = `v1-sha256:${"e".repeat(64)}`;
    expect(
      test.validate(
        execution(
          {
            summary: {
              fingerprint,
              requestedParts: ["packages/template-composer"],
              includedParts: ["packages/template-composer"],
            },
            plan: {
              fingerprint,
              mainEventId: "event:main",
              requestedParts: "[Circular]",
              includedParts: "[Circular]",
              manifest: "systemEpoch: 57\n",
            },
          },
          `Prepared the template plan with fingerprint ${fingerprint}. Nothing was published.`,
          {
            code: [
              "const composer = '@workspace-extensions/template-composer';",
              "await extensions.invoke(composer, 'authoringParts', []);",
              "return await extensions.invoke(composer, 'inspectAuthoring', [{ name: 'Composer', description: 'Template composer', parts: ['packages/template-composer'] }]);",
            ].join("\n"),
          }
        )
      )
    ).toEqual({ passed: true, reason: undefined });
  });
});
