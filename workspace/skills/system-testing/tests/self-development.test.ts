import { describe, expect, it } from "vitest";
import type { TestExecutionResult } from "../types.js";
import { selfDevelopmentTests } from "./self-development.js";

const digest = (character: string) => character.repeat(64);
const generation = "1".repeat(32);

function execution(
  scenario: string,
  operations: Array<{
    service: "development" | "vcs" | "attachedHosts";
    method: string;
    result: unknown;
  }>,
  prerequisite = { available: true, reason: null as string | null }
): TestExecutionResult {
  return {
    duration: 0,
    messages: [],
    diagnostics: {
      selfDevelopment: {
        scenario,
        source: "system-test-harness",
        operations,
        prerequisite,
      },
    },
  };
}

function validate(name: string, value: unknown) {
  const test = selfDevelopmentTests.find((candidate) => candidate.name === name);
  if (!test) throw new Error(`Missing ${name}`);
  const operations: Array<{
    service: "development" | "vcs" | "attachedHosts";
    method: string;
    result: unknown;
  }> = [{ service: "development", method: "get", result: value }];
  if (name === "self-development-dirty-semantic-state") {
    operations.unshift({
      service: "vcs",
      method: "edit",
      result: { applicationId: "application:dirty" },
    });
  }
  if (name === "self-development-native-checkpoint") {
    operations.unshift({
      service: "development",
      method: "listNativeTools",
      result: [
        {
          toolId: "claude-code",
          executorId: "executor",
          available: true,
          unavailableReason: null,
          interactiveTerminal: true,
        },
      ],
    });
  }
  if (name === "self-development-build-failure-recovery") {
    const evidence = value as {
      armed: unknown;
      recovered: unknown;
      events: unknown[];
    };
    operations.push(
      {
        service: "development",
        method: "faultFailBuildAfterSnapshotRetained",
        result: evidence.armed,
      },
      {
        service: "development",
        method: "events",
        result: { events: evidence.events, nextAfter: null },
      },
      {
        service: "development",
        method: "retry",
        result: evidence.recovered,
      }
    );
  }
  if (name === "self-development-child-eval") {
    const evidence = value as { started: unknown; result: unknown };
    operations.push(
      { service: "attachedHosts", method: "eval.start", result: evidence.started },
      { service: "attachedHosts", method: "eval.get", result: evidence.result }
    );
  }
  if (name === "self-development-child-approval") {
    const evidence = value as {
      invocation: unknown;
      events: unknown[];
    };
    operations.push(
      {
        service: "attachedHosts",
        method: "permissions.list",
        result: evidence.invocation,
      },
      {
        service: "attachedHosts",
        method: "listApprovalAudit.after",
        result: { events: evidence.events, nextCursor: null },
      }
    );
  }
  return test.validate(execution(name, operations));
}

describe("self-development semantic validators", () => {
  it("classifies every receipt-driven scenario as harness validation", () => {
    expect(selfDevelopmentTests).not.toHaveLength(0);
    expect(selfDevelopmentTests.every((test) => test.validation === "harness")).toBe(true);
  });

  it("binds a current-host client to typed ready attestation", () => {
    const run = {
      state: "ready",
      commitPoint: "ready",
      target: { kind: "client-device", client: "electron", executorId: "shell:desktop" },
      snapshot: { snapshotDigest: digest("a") },
      artifact: { executionDigest: digest("b") },
      client: {
        state: "ready",
        providerId: "desktop",
        childRuntimeId: "app:child",
        attestedAt: 2,
        executionDigest: digest("b"),
      },
    };
    expect(validate("self-development-current-client", run).passed).toBe(true);
    expect(validate("self-development-current-client", { ...run, client: null }).passed).toBe(
      false
    );
  });

  it("joins isolated readiness and route to one generation", () => {
    const run = {
      state: "ready",
      commitPoint: "ready",
      target: { kind: "isolated-host", includeClient: false },
      hostReadiness: "ready",
      instance: { state: "ready", generationId: generation, executionDigest: digest("a") },
      artifact: { executionDigest: digest("a") },
      attachedHost: {
        state: "ready",
        childGenerationId: generation,
        authorityCeilingDigest: digest("b"),
      },
    };
    expect(validate("self-development-isolated-host", run).passed).toBe(true);
    expect(
      validate("self-development-isolated-host", {
        ...run,
        attachedHost: { ...run.attachedHost, childGenerationId: "2".repeat(32) },
      }).passed
    ).toBe(false);
  });

  it("requires the build snapshot to preserve the exact dirty application", () => {
    const value = {
      session: {
        sessionId: "session",
        contextId: "child",
        parentContextId: "parent",
        basis: { parentWorkingHead: { kind: "application", applicationId: "application:dirty" } },
      },
      run: {
        sessionId: "session",
        state: "succeeded",
        commitPoint: "artifacts-verified",
        target: { kind: "build-only" },
        snapshot: {
          repoPath: "projects/vibestudio",
          repositoryState: { kind: "application", applicationId: "application:dirty" },
          contentRoot: `state:${digest("b")}`,
          snapshotDigest: digest("a"),
        },
        artifact: {
          executionDigest: digest("c"),
          sourceState: {
            kind: "workspace",
            state: { kind: "application", applicationId: "application:dirty" },
            contentRoots: [
              {
                repoPath: "projects/vibestudio",
                stateHash: `state:${digest("b")}`,
              },
            ],
          },
        },
      },
    };
    expect(validate("self-development-dirty-semantic-state", value).passed).toBe(true);
    value.run.snapshot.repositoryState.applicationId = "application:other";
    expect(validate("self-development-dirty-semantic-state", value).passed).toBe(false);
    value.run.snapshot.repositoryState.applicationId = "application:dirty";
    value.run.state = "failed";
    expect(validate("self-development-dirty-semantic-state", value).passed).toBe(false);
  });

  it("requires one exact checkpoint import in the development child", () => {
    const session = {
      mode: "native-tool",
      contextId: "child",
      repository: { repositoryId: "repository:projects/vibestudio" },
      native: {
        toolId: "claude-code",
        pendingChanges: "none",
        lastCheckpoint: {
          snapshotRevision: "snapshot:1",
          descriptorDigest: digest("a"),
          imported: {
            contextId: "child",
            eventId: "event:checkpoint",
            importedRepositoryIds: ["repository:projects/vibestudio"],
          },
        },
      },
    };
    expect(validate("self-development-native-checkpoint", session).passed).toBe(true);
    session.native.lastCheckpoint.imported.contextId = "parent";
    expect(validate("self-development-native-checkpoint", session).passed).toBe(false);
  });

  it("joins failure and recovery by the same run id", () => {
    const value = {
      armed: {
        faultId: "fault",
        runId: "run",
        phase: "after-snapshot-retained",
        armedAt: 1,
      },
      failed: {
        runId: "run",
        state: "failed",
        repair: {
          retryable: true,
          primaryError: { code: "ESYSTEMTEST_INJECTED_BUILD" },
        },
        commitPoint: "snapshot-retained",
        snapshot: { snapshotDigest: digest("a") },
      },
      recovered: {
        runId: "run",
        state: "succeeded",
        commitPoint: "artifacts-verified",
        snapshot: { snapshotDigest: digest("a") },
      },
      events: [
        {
          kind: "diagnostic",
          payload: {
            code: "ESYSTEMTEST_INJECTED_BUILD",
            faultId: "fault",
            phase: "after-snapshot-retained",
          },
        },
      ],
    };
    expect(validate("self-development-build-failure-recovery", value).passed).toBe(true);
    value.recovered.runId = "other";
    expect(validate("self-development-build-failure-recovery", value).passed).toBe(false);
  });

  it("joins ordinary child eval evidence to an attached run", () => {
    const value = {
      run: {
        runId: "run",
        instance: {
          state: "ready",
          generationId: generation,
          executionDigest: digest("a"),
        },
        attachedHost: {
          state: "ready",
          sessionId: "attached",
          childGenerationId: generation,
        },
      },
      started: { runId: "eval-run" },
      result: {
        developmentRunId: "run",
        attachedHostSessionId: "attached",
        evalRunId: "eval-run",
        evalSnapshot: { status: "done", result: { success: true, returnValue: 42 } },
      },
    };
    expect(validate("self-development-child-eval", value).passed).toBe(true);
    value.result.developmentRunId = "other";
    expect(validate("self-development-child-eval", value).passed).toBe(false);
  });

  it("requires exact invocation and presentation digests for child approval", () => {
    const value = {
      run: {
        runId: "run",
        attachedHost: {
          state: "ready",
          sessionId: "attached",
          childGenerationId: "1".repeat(32),
        },
      },
      invocation: {
        developmentRunId: "run",
        attachedHostSessionId: "attached",
      },
      events: [
        {
          sessionId: "attached",
          developmentRunId: "run",
          childGenerationId: "1".repeat(32),
          requestId: "request",
          service: "permissions",
          method: "list",
          invocationSnapshotDigest: digest("a"),
          preparedOperationDigest: digest("b"),
          shownPresentationDigest: digest("c"),
          decision: "once",
          challengedAt: 1,
          decidedAt: 2,
        },
      ],
    };
    expect(validate("self-development-child-approval", value).passed).toBe(true);
    value.events[0]!.invocationSnapshotDigest = "claimed";
    expect(validate("self-development-child-approval", value).passed).toBe(false);
  });

  it("requires typed stopped effects and a closed session", () => {
    const value = {
      run: {
        runId: "run",
        sessionId: "session",
        state: "stopped",
        instance: { state: "stopped", stoppedAt: 3 },
        client: { state: "stopped" },
        attachedHost: { state: "closed" },
      },
      session: { sessionId: "session", state: "closed", contextEffect: "retained" },
    };
    expect(validate("self-development-owned-cleanup", value).passed).toBe(true);
    value.run.instance.state = "ready";
    expect(validate("self-development-owned-cleanup", value).passed).toBe(false);
  });

  it("rejects agent-shaped evidence without a harness receipt", () => {
    const test = selfDevelopmentTests.find(
      ({ name }) => name === "self-development-current-client"
    )!;
    expect(
      test.validate({
        duration: 0,
        messages: [
          {
            id: "final",
            kind: "message",
            senderId: "agent",
            complete: true,
            content: JSON.stringify({ state: "ready", client: { state: "ready" } }),
          },
        ] as TestExecutionResult["messages"],
      }).passed
    ).toBe(false);
  });

  it("makes missing executor/fault prerequisites explicit and non-passing", () => {
    const test = selfDevelopmentTests.find(
      ({ name }) => name === "self-development-build-failure-recovery"
    )!;
    expect(
      test.validate(
        execution(test.name, [], {
          available: false,
          reason: "no reviewed disposable failure injector",
        })
      )
    ).toEqual({
      passed: false,
      reason: "Self-development prerequisite unavailable: no reviewed disposable failure injector",
    });
  });

  it("orchestrates every scenario through the harness instead of an agent prompt", () => {
    for (const test of selfDevelopmentTests) {
      expect(test.orchestrate, test.name).toBeTypeOf("function");
      expect(test.prompt, test.name).toContain("Harness-orchestrated");
      expect(test.prompt, test.name).not.toMatch(/return .*receipt|use .* through eval/iu);
    }
  });

  it("captures current-client evidence from runner RPC results without spawning an agent", async () => {
    const run = {
      runId: "run",
      sessionId: "session",
      state: "ready",
      commitPoint: "ready",
      target: { kind: "client-device", client: "electron", executorId: "shell:desktop" },
      snapshot: { snapshotDigest: digest("a") },
      artifact: { executionDigest: digest("b") },
      client: {
        state: "ready",
        providerId: "desktop",
        childRuntimeId: "app:child",
        attestedAt: 2,
        executionDigest: digest("b"),
      },
    };
    const calls: string[] = [];
    const runner = {
      resolveSelfDevelopmentRepository: async () => {
        calls.push("vcs.resolveRepository");
        return {
          contextId: "context",
          repositoryId: "repository",
          repoPath: "projects/vibestudio",
          workingHead: { kind: "event", eventId: "main" },
        };
      },
      callSelfDevelopment: async (method: string) => {
        calls.push(`development.${method}`);
        if (method === "listRecipes") {
          return [{ recipeId: "recipe", target: { kind: "client-device" } }];
        }
        if (method === "listClientExecutors") {
          return [{ executorId: "shell:desktop", current: false }];
        }
        if (method === "openSession") {
          return { kind: "opened", session: { sessionId: "session" } };
        }
        if (method === "start") return { ...run, state: "accepted" };
        if (method === "get") return run;
        if (method === "stop") return { ...run, state: "stopped" };
        if (method === "closeSession") return { sessionId: "session", state: "closed" };
        throw new Error(`Unexpected method ${method}`);
      },
    };
    const test = selfDevelopmentTests.find(
      ({ name }) => name === "self-development-current-client"
    )!;
    const result = await test.orchestrate!({
      runner: runner as never,
      remainingTimeMs: () => 10_000,
      sendAndWait: async () => {
        throw new Error("Agent turn must not be used");
      },
    });
    expect(test.validate(result)).toEqual({ passed: true, reason: undefined });
    expect(calls).toEqual([
      "vcs.resolveRepository",
      "development.listRecipes",
      "development.listClientExecutors",
      "development.openSession",
      "development.start",
      "development.get",
      "development.stop",
      "development.closeSession",
    ]);
    expect(result.messages).toEqual([]);
  });
});
