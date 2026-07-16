import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@workspace/agentic-core";
import { summarizeEntry, summarizeFailures } from "./diagnostics.js";
import type { TestSuiteResultEntry } from "./types.js";

function entryWithMessages(messages: ChatMessage[]): TestSuiteResultEntry {
  return {
    test: {
      name: "typed-transcript",
      category: "smoke",
      description: "captures typed transcript rows",
      prompt: "exercise typed transcript",
    },
    result: { passed: false, reason: "validation failed" },
    execution: {
      messages,
      duration: 123,
    },
  };
}

function passingEntryWithToolFailure(messages: ChatMessage[]): TestSuiteResultEntry {
  return {
    ...entryWithMessages(messages),
    result: { passed: true },
    execution: {
      messages,
      duration: 123,
      toolFailures: [
        {
          id: "call-1",
          name: "eval",
          status: "error",
          error: "ReferenceError: missingVar is not defined",
          source: "message",
        },
      ],
    },
  };
}

describe("system-testing diagnostics", () => {
  it("preserves structured invocation payloads for stage report drill-down", () => {
    const invocation = {
      id: "call-1",
      transportCallId: "transport-1",
      name: "read",
      arguments: { path: "README.md" },
      execution: {
        status: "complete" as const,
        terminalOutcome: "success" as const,
        description: "Read README.md",
        result: { bytes: 42, preview: "hello" },
        isError: false,
      },
    };
    const messages: ChatMessage[] = [
      {
        id: "prompt-1",
        senderId: "headless",
        kind: "message",
        complete: true,
        content: "prompt",
      },
      {
        id: "invocation:call-1",
        senderId: "agent",
        kind: "message",
        contentType: "invocation",
        complete: true,
        content: JSON.stringify(invocation),
        invocation,
        senderMetadata: { name: "Agent", type: "agent", handle: "agent" },
      },
    ];

    const diagnostic = summarizeEntry(entryWithMessages(messages), {
      messages: 10,
      invocations: 10,
      text: 120,
    });

    expect(diagnostic.conversation[1]).toMatchObject({
      uiType: "invocation",
      text: "Read README.md",
      invocation: {
        id: "call-1",
        transportCallId: "transport-1",
        name: "read",
        status: "complete",
        terminalOutcome: "success",
        arguments: { path: "README.md" },
        result: { bytes: 42, preview: "hello" },
      },
    });
    expect(diagnostic.conversation[1]!.rawContent).toContain('"name":"read"');
    expect(diagnostic.invocations).toHaveLength(1);
    expect(diagnostic.invocations[0]).toMatchObject({
      name: "read",
      status: "complete",
      arguments: { path: "README.md" },
      result: { bytes: 42, preview: "hello" },
    });
  });

  it("summarizes non-message transcript payload types", () => {
    const messages: ChatMessage[] = [
      {
        id: "prompt-1",
        senderId: "headless",
        kind: "message",
        complete: true,
        content: "prompt",
      },
      {
        id: "diag-1",
        senderId: "agent",
        kind: "system",
        complete: true,
        content: "",
        diagnostic: {
          severity: "error",
          title: "Model retry limit reached",
          detail:
            "Model retry limit reached for t:chan-1:env-1: 3 consecutive model failures occurred.",
          code: "model_retry_limit_exceeded",
        },
      },
    ];

    const diagnostic = summarizeEntry(entryWithMessages(messages));

    expect(diagnostic.conversation[1]).toMatchObject({
      uiType: "diagnostic",
      type: "system",
      text: "Model retry limit reached\nModel retry limit reached for t:chan-1:env-1: 3 consecutive model failures occurred.",
      diagnostic: {
        severity: "error",
        code: "model_retry_limit_exceeded",
        title: "Model retry limit reached",
      },
    });
  });

  it("classifies passing tests with tool failures as investigation items", () => {
    const messages: ChatMessage[] = [
      {
        id: "prompt-1",
        senderId: "headless",
        kind: "message",
        complete: true,
        content: "prompt",
      },
      {
        id: "answer-1",
        senderId: "agent",
        kind: "message",
        complete: true,
        content: "Recovered.",
      },
    ];

    const diagnostic = summarizeEntry(passingEntryWithToolFailure(messages));

    expect(diagnostic.passed).toBe(true);
    expect(diagnostic.likelyIssue).toBe("tool-failure-observed:eval");
    expect(diagnostic.toolFailures).toEqual([
      expect.objectContaining({
        name: "eval",
        status: "error",
      }),
    ]);
  });

  it("includes passing tests with tool failures in bounded failure summaries", () => {
    const messages: ChatMessage[] = [
      {
        id: "prompt-1",
        senderId: "headless",
        kind: "message",
        complete: true,
        content: "prompt",
      },
    ];
    const suite = {
      total: 1,
      passed: 1,
      failed: 0,
      errored: 0,
      skipped: 0,
      duration: 123,
      results: [passingEntryWithToolFailure(messages)],
    };

    const report = summarizeFailures(suite);

    expect(report.failureCount).toBe(1);
    expect(report.failures[0]).toMatchObject({
      name: "typed-transcript",
      passed: true,
      likelyIssue: "tool-failure-observed:eval",
    });
  });

  it("does not diagnose a deliberately exercised tool failure as a system defect", () => {
    const messages: ChatMessage[] = [
      {
        id: "prompt-1",
        senderId: "headless",
        kind: "message",
        complete: true,
        content: "prompt",
      },
    ];
    const entry = passingEntryWithToolFailure(messages);
    entry.execution.toolFailures![0]!.expected = true;

    expect(summarizeEntry(entry).likelyIssue).toBe("passed");
    expect(
      summarizeFailures({
        total: 1,
        passed: 1,
        failed: 0,
        errored: 0,
        skipped: 0,
        duration: 1,
        results: [entry],
      }).failureCount
    ).toBe(0);
  });

  it("includes bounded workspace repo fixture teardown diagnostics", () => {
    const entry = entryWithMessages([]);
    entry.execution.diagnostics = {
      workspaceRepoFixture: {
        testName: "fixture-test",
        contextId: "context:fixture-test",
        kind: "buildable-package",
        section: "packages",
        repoName: "system-test-fixture-test-1234",
        repositoryId: "repository:fixture-test-1234",
        repoPath: "packages/system-test-fixture-test-1234",
        seedFilePaths: ["package.json", "src/index.ts"],
        importWorkUnitId: "work:import",
        taskBaseEventId: "event:main",
        importChangeIds: ["change:repository-create", "change:file-create"],
        publishedFixtureRemoved: {
          repositoryId: "repository:fixture-test-1234",
          repoPath: "packages/system-test-fixture-test-1234",
        },
        unexpectedPublishedRepositoriesRemoved: [
          { repositoryId: "repository:escaped", repoPath: "projects/outside-fixture" },
        ],
        counteractedChangeIds: ["change:repository-create", "change:file-create"],
      },
    };

    expect(summarizeEntry(entry).workspaceRepoFixture).toEqual({
      testName: "fixture-test",
      contextId: "context:fixture-test",
      kind: "buildable-package",
      section: "packages",
      repoName: "system-test-fixture-test-1234",
      repositoryId: "repository:fixture-test-1234",
      repoPath: "packages/system-test-fixture-test-1234",
      seedFilePaths: ["package.json", "src/index.ts"],
      importWorkUnitId: "work:import",
      taskBaseEventId: "event:main",
      importChangeCount: 2,
      publishedFixtureRemoved: {
        repositoryId: "repository:fixture-test-1234",
        repoPath: "packages/system-test-fixture-test-1234",
      },
      unexpectedPublishedRepositoriesRemoved: [
        { repositoryId: "repository:escaped", repoPath: "projects/outside-fixture" },
      ],
      counteractedChangeCount: 2,
    });
  });

  it("reports normalized session cleanup once when the raw snapshot retains it", () => {
    const entry = entryWithMessages([]);
    entry.execution.cleanupErrors = ["unsubscribeHeadlessAgent: relay failed"];
    entry.execution.snapshot = {
      channelId: "channel-cleanup",
      agentEntityId: "agent-cleanup",
      agentTargetId: "agent-cleanup",
      agentContextId: "context-cleanup",
      ownsAgentContext: false,
      messages: [],
      invocations: [],
      debugEvents: [],
      cleanupErrors: [
        {
          phase: "unsubscribeHeadlessAgent",
          message: "relay failed",
          at: 1,
        },
      ],
      participants: {},
      localMethodNames: [],
      connected: false,
      duration: 1,
      title: null,
    };

    expect(summarizeEntry(entry).cleanupErrors).toEqual(["unsubscribeHeadlessAgent: relay failed"]);
  });

  it("keeps structured failures and handles in bounded diagnostics", () => {
    const entry = entryWithMessages([]);
    entry.execution.error = "fixture setup failed";
    entry.execution.failure = {
      phase: "workspace-fixture-setup",
      error: {
        name: "RemoteRpcError",
        message: "fixture setup failed",
        code: "InternalFailure",
        errorKind: "application",
        errorData: { code: "InternalFailure", handle: "diagnostic:vcs:setup" },
        diagnosticHandles: ["diagnostic:vcs:setup"],
      },
    };
    entry.execution.cleanupFailures = [
      {
        phase: "workspace-fixture-cleanup",
        error: {
          name: "RemoteRpcError",
          message: "fixture cleanup failed",
          code: "InternalFailure",
          errorData: { handle: "diagnostic:vcs:cleanup" },
          diagnosticHandles: ["diagnostic:vcs:cleanup"],
        },
      },
    ];

    const diagnostic = summarizeEntry(entry);

    expect(diagnostic.failure).toEqual(entry.execution.failure);
    expect(diagnostic.cleanupFailures).toEqual(entry.execution.cleanupFailures);
    expect(JSON.stringify(diagnostic)).toContain("diagnostic:vcs:setup");
    expect(JSON.stringify(diagnostic)).toContain("diagnostic:vcs:cleanup");
  });
});
