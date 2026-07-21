import type { ChatMessage } from "@workspace/agentic-core";
import type { HeadlessSession, SessionSnapshot } from "@workspace/agentic-session";
import {
  CONTENT_WORKSPACE_REPO_FIXTURE,
  type TestCase,
  type TestExecutionResult,
  type TestOrchestrationContext,
} from "../types.js";
import {
  findLastAgentMessage,
  getToolCalls,
  hasAgentResponse,
  noIncompleteInvocations,
  requireIncrementalIntegrationEvidence,
  requirePublishedCommitEvidence,
  requireVcsEvidence,
  requireWholeChainCommitEvidence,
} from "./_helpers.js";

function checked(result: TestExecutionResult, evidence: string[]) {
  if (!hasAgentResponse(result)) return { passed: false, reason: "No agent response received" };
  const invocations = noIncompleteInvocations(result);
  if (!invocations.passed) return invocations;
  return requireVcsEvidence(result, evidence);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireCanonicalStatus(result: TestExecutionResult) {
  const status = getToolCalls(result).find(
    (call) =>
      call.name === "vcs" &&
      call.arguments?.["operation"] === "status" &&
      call.execution?.status === "complete" &&
      call.execution.isError !== true
  );
  const envelope = status?.execution?.result;
  const details = isRecord(envelope) ? envelope["details"] : undefined;
  const canonical = isRecord(details) ? details["result"] : undefined;
  if (
    !isRecord(canonical) ||
    typeof canonical["contextId"] !== "string" ||
    typeof canonical["clean"] !== "boolean" ||
    !isRecord(canonical["committed"]) ||
    !isRecord(canonical["workingHead"]) ||
    typeof canonical["mainEventId"] !== "string" ||
    !["at", "ahead", "behind", "diverged"].includes(String(canonical["mainRelation"]))
  ) {
    return {
      passed: false,
      reason:
        "No completed status call exposed canonical context, state, cleanliness, and main-relation evidence",
    };
  }
  const committed = canonical["committed"];
  const working = canonical["workingHead"];
  const committedId = isRecord(committed) ? committed["eventId"] : undefined;
  const workingId = isRecord(working)
    ? working["kind"] === "event"
      ? working["eventId"]
      : working["applicationId"]
    : undefined;
  const final = findLastAgentMessage(result).toLowerCase();
  const requiredClaims = [
    committedId,
    workingId,
    canonical["mainEventId"],
    canonical["mainRelation"],
    canonical["clean"] === true ? "clean" : "dirty",
  ].filter((value): value is string => typeof value === "string");
  if (requiredClaims.some((claim) => !final.includes(claim.toLowerCase()))) {
    return {
      passed: false,
      reason:
        "The final orientation did not report the exact committed, working, main-relation, and cleanliness facts returned by status",
    };
  }
  const mutations = getToolCalls(result).filter(
    (call) =>
      call.execution?.status === "complete" &&
      call.execution.isError !== true &&
      (["edit", "write", "move_file", "copy_file", "commit"].includes(call.name) ||
        (call.name === "vcs" &&
          ["edit", "move", "copy", "integrate", "revert", "commit", "discard", "push"].includes(
            String(call.arguments?.["operation"])
          )))
  );
  return mutations.length === 0
    ? { passed: true }
    : { passed: false, reason: "Status orientation unexpectedly mutated the workspace" };
}

/** Two real contexts advance independently; integration happens as local steps in A. */
async function orchestrateIncrementalIntegration(
  context: TestOrchestrationContext
): Promise<TestExecutionResult> {
  const startedAt = Date.now();
  const fixtureName = context.runner.workspaceRepoName;
  if (!fixtureName) throw new Error("incremental integration requires a repository fixture");
  const repoPath = `projects/${fixtureName}`;
  const sessions: Array<{ role: "agent-a" | "agent-b"; session: HeadlessSession }> = [];
  const cleanupErrors: string[] = [];
  let firstPhase: ChatMessage[] = [];
  let error: string | undefined;

  try {
    const agentA = await context.runner.spawn({ context: "task" });
    sessions.push({ role: "agent-a", session: agentA });
    await context.sendAndWait(
      agentA,
      `Work in ${repoPath}. Publish a small shared baseline, then make and commit one additional compatible change but leave that second milestone local. Use the workspace guidance and report when the repository is ready for a collaborator.`,
      "agent A publishes the base and keeps one local commit"
    );
    firstPhase = [...agentA.messages] as ChatMessage[];

    const agentB = await context.runner.spawn({ context: "isolated" });
    sessions.push({ role: "agent-b", session: agentB });
    await context.sendAndWait(
      agentB,
      `A collaborator has published ${repoPath}. Make a distinct compatible change there, commit it, and publish it. Follow the workspace guidance and report what happened.`,
      "agent B advances main independently"
    );

    await context.sendAndWait(
      agentA,
      `Main advanced while your compatible local commit remained unpublished. Bring the incoming semantic changes into your context one local decision at a time, commit the combined history, and publish it. Verify that both collaborators' intent remains and report what happened.`,
      "agent A incrementally integrates and publishes"
    );
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }

  const agentA = sessions.find(({ role }) => role === "agent-a")?.session;
  const agentB = sessions.find(({ role }) => role === "agent-b")?.session;
  const messages = [
    ...firstPhase,
    ...(agentB ? ([...agentB.messages] as ChatMessage[]) : []),
    ...(agentA ? ([...agentA.messages] as ChatMessage[]).slice(firstPhase.length) : []),
  ];
  const snapshots = sessions.map(({ role, session }) => safeSnapshot(role, session));
  const execution: TestExecutionResult = {
    messages,
    duration: Date.now() - startedAt,
    ...(error ? { error } : {}),
    ...(snapshots.find(({ role }) => role === "agent-a")?.snapshot
      ? { snapshot: snapshots.find(({ role }) => role === "agent-a")!.snapshot }
      : {}),
    diagnostics: {
      orchestrated: true,
      repoPath,
      sessions: snapshots.map(({ role, snapshot, error: snapshotError }) => ({
        role,
        messageCount: snapshot?.messages.length ?? 0,
        invocationCount: snapshot?.invocations.length ?? 0,
        ...(snapshotError ? { snapshotError } : {}),
      })),
    },
  };

  for (const { role, session } of [...sessions].reverse()) {
    try {
      await session.close();
      cleanupErrors.push(
        ...session
          .snapshot()
          .cleanupErrors.map((entry) => `${role} ${entry.phase}: ${entry.message}`)
      );
    } catch (cause) {
      cleanupErrors.push(`${role}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  if (cleanupErrors.length > 0) {
    execution.cleanupErrors = cleanupErrors;
    execution.error ??= `Headless cleanup failed: ${cleanupErrors.join("; ")}`;
  }
  return execution;
}

function safeSnapshot(
  role: "agent-a" | "agent-b",
  session: HeadlessSession
): {
  role: "agent-a" | "agent-b";
  snapshot?: SessionSnapshot;
  error?: string;
} {
  try {
    return { role, snapshot: session.snapshot() };
  } catch (cause) {
    return { role, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

export const vcsTests: TestCase[] = [
  {
    name: "vcs-status-orientation",
    description: "Orient on committed, working, and protected-main state without mutation",
    category: "vcs",
    prompt:
      "Orient me in this editing context without changing it. Explain its current workspace state and relationship to protected main using exact identities where they matter.",
    validate: (result) => {
      const base = checked(result, ["vcs.status"]);
      return base.passed ? requireCanonicalStatus(result) : base;
    },
  },
  {
    name: "vcs-edit-whole-chain-commit",
    description: "Author several local edits and commit the complete incremental chain",
    category: "vcs",
    workspaceRepoFixture: CONTENT_WORKSPACE_REPO_FIXTURE,
    prompt:
      "In the disposable project, make two small related edits as separate local steps, then preserve the complete local chain as one clean milestone. Report what happened.",
    validate: (result) => {
      const base = checked(result, ["vcs.edit", "vcs.commit", "vcs.status"]);
      return base.passed ? requireWholeChainCommitEvidence(result) : base;
    },
  },
  {
    name: "vcs-push",
    description: "Publish one exact committed event to protected main",
    category: "vcs",
    resources: ["vcs:protected-main"],
    workspaceRepoFixture: CONTENT_WORKSPACE_REPO_FIXTURE,
    prompt:
      "Make a distinctive small change in the disposable project and publish that exact clean milestone to protected main. Verify it and explain what happened.",
    validate: (result) => {
      const base = checked(result, ["vcs.edit", "vcs.commit", "vcs.push"]);
      return base.passed ? requirePublishedCommitEvidence(result) : base;
    },
  },
  {
    name: "vcs-incremental-integration",
    description: "Incorporate concurrent semantic changes through local incremental decisions",
    category: "vcs",
    resources: ["vcs:protected-main"],
    workspaceRepoFixture: CONTENT_WORKSPACE_REPO_FIXTURE,
    prompt: "Harness-orchestrated two-context semantic integration.",
    orchestrate: orchestrateIncrementalIntegration,
    validate: (result) => {
      if (!hasAgentResponse(result)) return { passed: false, reason: "No agent response received" };
      const invocations = noIncompleteInvocations(result);
      if (!invocations.passed) return invocations;
      const operations = requireVcsEvidence(result, [
        "vcs.compare",
        "vcs.integrate",
        "vcs.commit",
        "vcs.push",
        "vcs.status",
      ]);
      return operations.passed ? requireIncrementalIntegrationEvidence(result) : operations;
    },
  },
];
