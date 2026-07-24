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

function publication() {
  return {
    published: true,
    committedEventId: "event:committed",
    publishedEventId: "event:committed",
    mainEventId: "event:committed",
    effectId: "effect:published",
    appliedAt: "2026-07-24T00:00:00.000Z",
  };
}

function preflight(projectType: "panel" | "package" | "worker") {
  return {
    ok: true,
    projectType,
    packageName: `@workspace${projectType === "panel" ? "-panels" : projectType === "worker" ? "-workers" : ""}/test`,
    entry: projectType === "package" ? null : "index.ts",
    authorityRequestCount: 0,
    importedPackages: [],
    checked: ["package identity"],
  };
}

function bootEvidence(panelId: string) {
  const identity = {
    panelId,
    attemptId: `attempt:${panelId}`,
    runtimeEntityId: `entity:${panelId}`,
    buildKey: `build:${panelId}`,
  };
  return {
    ready: { phase: "ready", ...identity },
    snapshot: {
      ...identity,
      capturedAt: 1,
      document: { kind: "synth", structure: { role: "document" } },
    },
  };
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
      scenario(approvalPermissionTests, "permissions-list").validate(
        execution([
          evalCall(
            'const grants = await rpc.call("main", "permissions.list", []); return { grants };',
            { grants: [] }
          ),
        ])
      ).passed
    ).toBe(true);
    expect(
      scenario(approvalPermissionTests, "approvals-list").validate(
        execution([evalCall("return approvals.list();", [])])
      ).passed
    ).toBe(true);
    expect(
      scenario(approvalPermissionTests, "approvals-list").validate(
        execution([
          evalCall(
            "const list = await approvals.list(); return { count: list.length, list };",
            { count: 0, list: [] }
          ),
        ])
      ).passed
    ).toBe(true);
    expect(
      scenario(approvalPermissionTests, "approvals-list").validate(
        execution([
          evalCall(
            "const decisions = await approvals.list(); return { count: decisions.length, decisions };",
            { count: 0, decisions: [] }
          ),
        ])
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
          evalCall(
            [
              "const before = await rpc.call('main', 'userlandApproval.list', []);",
              `const request = await rpc.call('main', 'userlandApproval.request', [{ subject: { id: '${subject}' } }]);`,
              "const after = await rpc.call('main', 'userlandApproval.list', []);",
              "return { beforeCount: before.length, request, after };",
            ].join("\n"),
            {
              beforeCount: 0,
              request: { kind: "choice", choice: "allow" },
              after: [{ subject: { id: subject }, choice: "allow" }],
            }
          ),
          evalCall(
            [
              `const revokeResult = await rpc.call('main', 'userlandApproval.revoke', ['${subject}']);`,
              "const finalList = await rpc.call('main', 'userlandApproval.list', []);",
              "return { revokeResult, finalCount: finalList.length, finalList };",
            ].join("\n"),
            { revokeResult: true, finalCount: 0, finalList: [] }
          ),
        ])
      )
    ).toEqual({ passed: true, reason: undefined });
    expect(
      test.validate(
        execution([
          evalCall(
            [
              `const subject = { id: "${subject}", label: "Harmless check" };`,
              "const before = await approvals.list();",
              "const decision = await approvals.request({ subject, title: 'Allow check?' });",
              "const afterApprove = await approvals.list();",
              "const revoked = await approvals.revoke(subject.id);",
              "const afterRevoke = await approvals.list();",
              "return {",
              "  subjectId: subject.id,",
              "  beforeCount: before.length,",
              "  decision,",
              "  afterApproveCount: afterApprove.length,",
              "  revoked,",
              "  afterRevokeCount: afterRevoke.length,",
              "  afterRevokeHasSubject: afterRevoke.some((entry) => entry.subject.id === subject.id),",
              "};",
            ].join("\n"),
            {
              subjectId: subject,
              beforeCount: 0,
              decision: { kind: "choice", choice: "allow" },
              afterApproveCount: 1,
              revoked: true,
              afterRevokeCount: 0,
              afterRevokeHasSubject: false,
            }
          ),
        ])
      )
    ).toEqual({ passed: true, reason: undefined });
    expect(
      test.validate(
        execution([
          evalCall(
            [
              `const subject = { id: "${subject}", label: "Harmless check" };`,
              "const before = await approvals.list();",
              "const decision = await approvals.request({ subject, title: 'Allow check?' });",
              "const afterApprove = await approvals.list();",
              "const revoked = await approvals.revoke(subject.id);",
              "const afterRevoke = await approvals.list();",
              "return {",
              "  beforeCount: before.length,",
              "  decision,",
              "  afterApproveCount: afterApprove.length,",
              "  revoked,",
              "  afterRevokeCount: afterRevoke.length,",
              "  leakedDecision: afterRevoke.some((entry) => entry.subject.id === subject.id),",
              "};",
            ].join("\n"),
            {
              beforeCount: 0,
              decision: { kind: "choice", choice: "allow" },
              afterApproveCount: 1,
              revoked: true,
              afterRevokeCount: 0,
              leakedDecision: false,
            }
          ),
        ])
      )
    ).toEqual({ passed: true, reason: undefined });
    expect(
      test.validate(
        execution([
          evalCall(
            [
              `const subjectId = "${subject}";`,
              "const before = await approvals.list();",
              "const request = await approvals.request({ subject: { id: subjectId } });",
              "const afterApprove = await approvals.list();",
              "await approvals.revoke(subjectId);",
              "const afterRevoke = await approvals.list();",
              "return {",
              "  beforeCount: before.length,",
              "  request,",
              "  afterApproveCount: afterApprove.length,",
              "  afterRevokeCount: afterRevoke.length,",
              "  removed: !afterRevoke.some((entry) => entry.subject.id === subjectId),",
              "};",
            ].join("\n"),
            {
              beforeCount: 0,
              request: { kind: "choice", choice: "allow" },
              afterApproveCount: 1,
              afterRevokeCount: 0,
              removed: true,
            }
          ),
        ])
      )
    ).toEqual({ passed: true, reason: undefined });
    expect(
      test.validate(
        execution([
          evalCall(
            [
              `const subjectId = "${subject}";`,
              "const request = await approvals.request({ subject: { id: subjectId } });",
              "const afterRequest = await approvals.list();",
              "if (request.kind === 'choice') await approvals.revoke(subjectId);",
              "const afterRevoke = await approvals.list();",
              "return { request, afterRequest, afterRevoke };",
            ].join("\n"),
            {
              request: { kind: "choice", choice: "allow" },
              afterRequest: [{ subject: { id: subject }, choice: "allow" }],
              afterRevoke: [],
            }
          ),
        ])
      )
    ).toEqual({ passed: true, reason: undefined });
    expect(
      test.validate(
        execution([
          evalCall(
            [
              `const subjectId = "${subject}";`,
              "const subject = { id: subjectId };",
              "const before = await approvals.list();",
              "const request = await approvals.request({ subject });",
              "const afterRequest = await approvals.list();",
              "const revoked = await approvals.revoke(subjectId);",
              "const afterRevoke = await approvals.list();",
              "return {",
              "  beforeCount: before.length,",
              "  request,",
              "  afterRequestMatch: afterRequest.filter((entry) => entry.subject.id === subjectId),",
              "  revoked,",
              "  afterRevokeMatch: afterRevoke.filter((entry) => entry.subject.id === subjectId),",
              "  afterRevokeCount: afterRevoke.length,",
              "};",
            ].join("\n"),
            {
              beforeCount: 0,
              request: { kind: "choice", choice: "allow" },
              afterRequestMatch: [{ subject: { id: subject }, choice: "allow" }],
              revoked: true,
              afterRevokeMatch: [],
              afterRevokeCount: 0,
            }
          ),
        ])
      )
    ).toEqual({ passed: true, reason: undefined });
    expect(
      test.validate(
        execution([
          evalCall("const before = await approvals.list(); return before;", []),
          evalCall(
            [
              `const subjectId = "${subject}";`,
              "const requested = await approvals.request({ subject: { id: subjectId } });",
              "return { requested, listAfter: await approvals.list() };",
            ].join("\n"),
            {
              requested: { kind: "choice", choice: "allow" },
              listAfter: [{ subject: { id: subject }, choice: "allow" }],
            }
          ),
          evalCall(
            [`await approvals.revoke("${subject}");`, "return await approvals.list();"].join("\n"),
            []
          ),
        ])
      )
    ).toEqual({ passed: true, reason: undefined });
    expect(
      test.validate(
        execution([
          evalCall(
            [
              `const subject = { id: "${subject}", label: "Harmless check" };`,
              "const before = await rpc.call('main', 'userlandApproval.list', []);",
              "const request = await rpc.call('main', 'userlandApproval.request', [{ subject }]);",
              "const mid = await rpc.call('main', 'userlandApproval.list', []);",
              "const revoked = await rpc.call('main', 'userlandApproval.revoke', [subject.id]);",
              "const after = await rpc.call('main', 'userlandApproval.list', []);",
              "const filter = (entries) => entries.filter((entry) => entry.subject.id === subject.id);",
              "return { before: filter(before).length, request, mid: filter(mid), revoked, after: filter(after) };",
            ].join("\n"),
            {
              before: 0,
              request: { kind: "choice", choice: "allow" },
              mid: [{ subject: { id: subject }, choice: "allow" }],
              revoked: true,
              after: [],
            }
          ),
        ])
      )
    ).toEqual({ passed: true, reason: undefined });
    expect(
      test.validate(
        execution([
          evalCall(
            [
              `const subject = { id: "${subject}", label: "Harmless check" };`,
              "const prompt = { subject, title: 'Allow check?' };",
              "const before = await approvals.list();",
              "const approval = await approvals.request(prompt);",
              "const afterRequest = await approvals.list();",
              "const revoked = await approvals.revoke(subject.id);",
              "const afterRevoke = await approvals.list();",
              "return {",
              "  beforeCount: before.length,",
              "  approval,",
              "  afterRequestCount: afterRequest.length,",
              "  revoked,",
              "  afterRevokeCount: afterRevoke.length,",
              "  matchingAfterRevoke: afterRevoke.filter((entry) => entry.subject.id === subject.id),",
              "};",
            ].join("\n"),
            {
              beforeCount: 0,
              approval: { kind: "choice", choice: "allow" },
              afterRequestCount: 1,
              revoked: true,
              afterRevokeCount: 0,
              matchingAfterRevoke: [],
            }
          ),
        ])
      )
    ).toEqual({ passed: true, reason: undefined });
    expect(
      test.validate(
        execution([
          evalCall(
            [
              `const subjectId = "${subject}";`,
              "const before = await approvals.list();",
              "const decision = await approvals.request({ subject: { id: subjectId } });",
              "const afterRequest = await approvals.list();",
              "await approvals.revoke(subjectId);",
              "const afterRevoke = await approvals.list();",
              "return { before, decision, afterRequest, afterRevoke };",
            ].join("\n"),
            {
              before: [],
              decision: { kind: "choice", choice: "allow" },
              afterRequest: [{ subject: { id: subject }, choice: "allow" }],
              afterRevoke: [],
            }
          ),
        ])
      )
    ).toEqual({ passed: true, reason: undefined });
    expect(
      test.validate(
        execution([
          evalCall(
            [
              `const subjectId = "${subject}";`,
              "const before = await approvals.list();",
              "const requestResult = await approvals.request({ subject: { id: subjectId } });",
              "const afterRequest = await approvals.list();",
              "await approvals.revoke(subjectId);",
              "const afterRevoke = await approvals.list();",
              "return {",
              "  beforeCount: before.length,",
              "  requestResult,",
              "  afterRequestCount: afterRequest.length,",
              "  afterRevokeCount: afterRevoke.length,",
              "  beforeHas: before.some((entry) => entry.subject.id === subjectId),",
              "  afterRequestHas: afterRequest.some((entry) => entry.subject.id === subjectId),",
              "  afterRevokeHas: afterRevoke.some((entry) => entry.subject.id === subjectId),",
              "};",
            ].join("\n"),
            {
              beforeCount: 0,
              requestResult: { kind: "choice", choice: "allow" },
              afterRequestCount: 1,
              afterRevokeCount: 0,
              beforeHas: false,
              afterRequestHas: true,
              afterRevokeHas: false,
            }
          ),
        ])
      )
    ).toEqual({ passed: true, reason: undefined });
    expect(
      test.validate(
        execution([
          evalCall(
            [
              `const subject = { id: "${subject}", label: "Harmless check" };`,
              "const before = await approvals.list();",
              "const decision = await approvals.request({ subject, title: 'Allow check?', summary: 'Verify approval cleanup.' });",
              "const afterRequest = await approvals.list();",
              "const revoked = await approvals.revoke(subject.id);",
              "const finalList = await approvals.list();",
              "return { before, decision, afterRequest, revoked, finalList };",
            ].join("\n"),
            {
              before: [],
              decision: { kind: "choice", choice: "allow" },
              afterRequest: [{ subject: { id: subject }, choice: "allow" }],
              revoked: true,
              finalList: [],
            }
          ),
        ])
      )
    ).toEqual({ passed: true, reason: undefined });
    expect(
      test.validate(
        execution([
          evalCall("const before = await approvals.list(); return { before };", { before: [] }),
          evalCall(
            `return approvals.request({ subject: { id: "${subject}", label: "Harmless check" }, title: "Allow check?", summary: "Verify approval cleanup." });`,
            { kind: "choice", choice: "allow" }
          ),
          evalCall(
            [
              "const afterAllow = await approvals.list();",
              "const id = afterAllow[0].subject.id;",
              "const revokeResult = await approvals.revoke(id);",
              "const finalList = await approvals.list();",
              "return { afterAllow, revokeResult, finalList };",
            ].join("\n"),
            {
              afterAllow: [
                {
                  subject: { id: subject },
                  choice: "allow",
                },
              ],
              revokeResult: true,
              finalList: [],
            }
          ),
        ])
      )
    ).toEqual({ passed: true, reason: undefined });
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
            {
              created: "panels/new-panel",
              files: ["index.tsx"],
              preflight: preflight("panel"),
              publication: publication(),
              openedPanelId: "panel:1",
              ...bootEvidence("panel:1"),
            }
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
              preflight: preflight("panel"),
              publication: publication(),
              openedPanelId: "panel:2",
              ...bootEvidence("panel:2"),
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
            preflight: preflight("worker"),
          }),
        ])
      ).passed
    ).toBe(true);

    const applicationId = "application:package-edit";
    const result = execution([
      evalCall("return createProject({ projectType: 'package', name: 'new-package' });", {
        created: "packages/new-package",
        files: ["index.ts"],
        preflight: preflight("package"),
        publication: publication(),
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
