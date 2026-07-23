import { describe, expect, it } from "vitest";

import type { ChatMessage } from "@workspace/agentic-core";
import type { TestCase, TestExecutionResult } from "../types.js";
import { agentCapabilityTests } from "./agent-capabilities.js";
import { approvalPermissionTests } from "./approvals-permissions.js";
import { edgeCaseTests } from "./edge-cases.js";
import { harnessResilienceTests } from "./harness-resilience.js";
import { projectLifecycleTests } from "./project-lifecycle.js";

type Invocation = {
  name: string;
  arguments?: Record<string, unknown>;
  status?: "complete" | "error";
  isError?: boolean;
  result?: unknown;
};

function invocationMessage(invocation: Invocation, index: number): ChatMessage {
  const status = invocation.status ?? "complete";
  return {
    id: `invocation-message-${index}`,
    kind: "message",
    senderId: "agent",
    complete: true,
    contentType: "invocation",
    content: JSON.stringify({
      id: `invocation-${index}`,
      name: invocation.name,
      arguments: invocation.arguments,
      execution: {
        status,
        terminalOutcome: status === "complete" ? "success" : "tool_error",
        isError: invocation.isError ?? status === "error",
        result: invocation.result,
      },
    }),
  };
}

function execution(invocations: Invocation[], final = "The requested behavior was observed.") {
  return {
    duration: 0,
    messages: [
      {
        id: "prompt",
        kind: "message",
        senderId: "user",
        complete: true,
        content: "prompt",
      },
      ...invocations.map(invocationMessage),
      {
        id: "final",
        kind: "message",
        senderId: "agent",
        complete: true,
        content: final,
      },
    ],
  } as TestExecutionResult;
}

function evalCall(
  code: string,
  returnValue: unknown,
  extra: Record<string, unknown> = {}
): Invocation {
  return {
    name: "eval",
    arguments: { code, ...extra },
    result: { details: { returnValue } },
  };
}

function scenario(tests: TestCase[], name: string): TestCase {
  const test = tests.find((candidate) => candidate.name === name);
  if (!test) throw new Error(`Missing scenario ${name}`);
  return test;
}

describe("capability and resilience prompts", () => {
  it("state user goals without proof protocols or API choreography", () => {
    const tests = [
      ...agentCapabilityTests,
      ...approvalPermissionTests,
      ...edgeCaseTests,
      ...harnessResilienceTests,
      ...projectLifecycleTests,
    ];
    for (const test of tests) {
      expect(test.prompt, test.name).not.toMatch(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/u);
      expect(test.prompt, test.name).not.toMatch(/finish with|respond with|return exactly/iu);
      expect(test.prompt, test.name).not.toMatch(
        /\b(?:createProject|forkProject|openPanel|approvals|permissions)\.\w+\s*\(/u
      );
    }
  });
});

describe("agent capability semantic validators", () => {
  it("joins persistent scope writes to a later matching read", () => {
    const test = scenario(agentCapabilityTests, "multi-turn");
    const result = execution([
      evalCall("scope.saved = { answer: 42 }; return scope.saved;", { answer: 42 }),
      evalCall("return scope.saved;", { answer: 42 }),
    ]);
    expect(test.validate(result)).toEqual({ passed: true, reason: undefined });
    expect(
      test.validate(execution([evalCall("return { answer: 42 };", { answer: 42 })])).passed
    ).toBe(false);
  });

  it("requires an observed failure before successful recovery", () => {
    const test = scenario(agentCapabilityTests, "error-recovery");
    const failure: Invocation = {
      name: "eval",
      arguments: { code: 'throw new Error("deliberate recovery failure")' },
      status: "error",
      result: "deliberate recovery failure",
    };
    expect(
      test.validate(
        execution([failure, evalCall("return { recovered: true };", { recovered: true })])
      )
    ).toEqual({ passed: true, reason: undefined });
    expect(
      test.validate(
        execution([evalCall("return { recovered: true };", { recovered: true }), failure])
      ).passed
    ).toBe(false);
  });

  it("requires canonical dynamic-import, console, and independent-scope results", () => {
    expect(
      scenario(agentCapabilityTests, "dynamic-import").validate(
        execution([
          evalCall("const pkg = await import('tiny'); return pkg.default('ok');", "ok", {
            imports: { tiny: "npm:just-camel-case" },
          }),
        ])
      ).passed
    ).toBe(true);
    expect(
      scenario(agentCapabilityTests, "console-streaming").validate(
        execution([
          {
            name: "eval",
            arguments: {
              code: "console.log('a'); console.info('b'); console.warn('c'); return true;",
            },
            result: { details: { returnValue: true, console: "a\nb\nc\n" } },
          },
        ])
      ).passed
    ).toBe(true);
    expect(
      scenario(agentCapabilityTests, "concurrent-scope").validate(
        execution([
          evalCall("scope.first = 1; scope.second = 2; scope.third = 3; return true;", true),
          evalCall("return { first: scope.first, second: scope.second, third: scope.third };", {
            first: 1,
            second: 2,
            third: 3,
          }),
        ])
      ).passed
    ).toBe(true);
  });
});

describe("approval semantic validators", () => {
  it("accepts read-only canonical permission and approval inventories", () => {
    expect(
      scenario(approvalPermissionTests, "permissions-list").validate(
        execution([evalCall('return rpc.call("main", "permissions.list", []);', [])])
      ).passed
    ).toBe(true);
    expect(
      scenario(approvalPermissionTests, "approvals-list").validate(
        execution([evalCall("return approvals.list();", [])])
      ).passed
    ).toBe(true);
  });

  it("joins a resolved request and matching revocation to restored inventory", () => {
    const test = scenario(approvalPermissionTests, "approval-request-then-withdraw");
    const subject = "system-test:harmless-resource";
    const result = execution([
      evalCall("return approvals.list();", []),
      evalCall(
        `return approvals.request({ subject: { id: "${subject}", label: "Harmless check" }, title: "Allow check?", summary: "Verify approval cleanup." });`,
        { kind: "choice", choice: "allow" }
      ),
      evalCall(`return approvals.revoke("${subject}");`, true),
      evalCall("return approvals.list();", []),
    ]);
    expect(test.validate(result)).toEqual({ passed: true, reason: undefined });
    expect(
      test.validate(
        execution([
          evalCall("return approvals.list();", []),
          evalCall(
            `return approvals.request({ subject: { id: "${subject}", label: "Harmless check" }, title: "Allow check?", summary: "Verify approval cleanup." });`,
            { kind: "choice", choice: "allow" }
          ),
          evalCall('return approvals.revoke("some-other-subject");', true),
          evalCall("return approvals.list();", []),
        ])
      ).passed
    ).toBe(false);
  });
});

describe("edge and harness semantic validators", () => {
  const recovery = evalCall("return { usable: true };", { usable: true });

  it("recognizes each intended eval failure and a later observable recovery", () => {
    const cases: Array<[string, Invocation]> = [
      [
        "eval-extra-argument",
        {
          name: "eval",
          arguments: { code: 42, unsupported: true },
          status: "error",
          result: "eval code must be a string; invalid args",
        },
      ],
      [
        "invalid-import",
        {
          name: "eval",
          arguments: { code: "return missing;", imports: { missing: "npm:not-real" } },
          status: "error",
          result: "Cannot find package; not found",
        },
      ],
      [
        "fs-not-found",
        {
          name: "eval",
          arguments: { code: 'return fs.readFile("missing.txt");' },
          status: "error",
          result: "ENOENT: file does not exist",
        },
      ],
    ];
    for (const [name, failure] of cases) {
      const test = scenario(edgeCaseTests, name);
      expect(test.validate(execution([failure, recovery])).passed, name).toBe(true);
      expect(test.validate(execution([recovery, failure])).passed, name).toBe(false);
    }
  });

  it("proves a huge return and an explicit timeout from canonical eval results", () => {
    expect(
      scenario(harnessResilienceTests, "eval-huge-return-bounded-terminal").validate(
        execution([
          {
            name: "eval",
            arguments: { code: "return 'x'.repeat(120000);" },
            result: {
              protocolContent: [
                {
                  type: "text",
                  text: "[eval] Return value: x… output truncated; recover with scope.$lastLargeReturn",
                },
              ],
              details: {
                returnValue: {
                  truncated: true,
                  originalChars: 120_002,
                  scopeKey: "$lastLargeReturn",
                  preview: "x".repeat(200),
                },
              },
            },
          },
        ])
      ).passed
    ).toBe(true);
    expect(
      scenario(harnessResilienceTests, "eval-timeout-error-visible").validate(
        execution([
          {
            name: "eval",
            arguments: { code: "await new Promise(() => {});", timeoutMs: 5 },
            status: "error",
            result: "Evaluation timed out after 5ms",
          },
          recovery,
        ])
      ).passed
    ).toBe(true);
  });
});

describe("project lifecycle semantic validators", () => {
  it("requires canonical create/fork results and an opened panel", () => {
    expect(
      scenario(projectLifecycleTests, "panel-create-commit-open").validate(
        execution([
          evalCall(
            "const created = await createProject(input); const opened = await openPanel(created.created); return { ...created, openedPanelId: opened.id };",
            { created: "panels/new-panel", files: ["index.tsx"], openedPanelId: "panel:1" }
          ),
        ])
      ).passed
    ).toBe(true);
    expect(
      scenario(projectLifecycleTests, "panel-fork-dry-run-and-commit").validate(
        execution([
          evalCall(
            "const plan = await forkProject(source, { dryRun: true }); const created = await forkProject(source, { dryRun: false }); const opened = await openPanel(created.created); return { ...created, openedPanelId: opened.id };",
            {
              source: "panels/source",
              created: "panels/forked",
              files: ["index.tsx"],
              committed: true,
              dryRun: false,
              openedPanelId: "panel:2",
            }
          ),
        ])
      ).passed
    ).toBe(true);
  });

  it("requires a dry-run worker plan and identity-joined package commit", () => {
    expect(
      scenario(projectLifecycleTests, "worker-fork-classmap-dry-run").validate(
        execution([
          evalCall("return forkProject(source, { dryRun: true });", {
            source: "workers/source",
            created: "workers/planned-fork",
            files: ["index.ts"],
            committed: false,
            dryRun: true,
          }),
        ])
      ).passed
    ).toBe(true);

    const applicationId = "application:package-edit";
    const result = execution([
      evalCall("return createProject({ projectType: 'package', name: 'new-package' });", {
        created: "packages/new-package",
        files: ["index.ts"],
      }),
      {
        name: "edit",
        arguments: { path: "packages/new-package/index.ts" },
        result: {
          details: {
            storage: "vcs",
            vcsResult: {
              applicationId,
              changeIds: ["change:package-edit"],
              workingHead: { kind: "application", applicationId },
            },
          },
        },
      },
      {
        name: "commit",
        result: {
          details: {
            result: {
              committedApplicationIds: [applicationId],
              event: { kind: "event", eventId: "event:package-edit" },
            },
          },
        },
      },
    ]);
    expect(scenario(projectLifecycleTests, "commit-existing-project").validate(result)).toEqual({
      passed: true,
      reason: undefined,
    });
  });
});
