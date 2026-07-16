import type { ChatMessage } from "@workspace/agentic-core";
import type { HeadlessSession, SessionSnapshot } from "@workspace/agentic-session";
import {
  CONTENT_WORKSPACE_REPO_FIXTURE,
  type TestCase,
  type TestExecutionResult,
  type TestOrchestrationContext,
} from "../types.js";
import {
  finalMessageHasAll,
  noIncompleteInvocations,
  requireIncrementalIntegrationEvidence,
  requirePublishedCommitEvidence,
  requireVcsEvidence,
  requireWholeChainCommitEvidence,
} from "./_helpers.js";

function checked(result: TestExecutionResult, tokens: string[], evidence: string[]) {
  const message = finalMessageHasAll(result, tokens);
  if (!message.passed) return message;
  const invocations = noIncompleteInvocations(result);
  if (!invocations.passed) return invocations;
  return requireVcsEvidence(result, evidence);
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
      `Work in ${repoPath}. Publish a small shared baseline, then make and commit one additional compatible change but leave that second milestone local. Use the workspace guidance and retain the exact event identities you will need. Finish with VCS_A_LOCAL_READY repo:${repoPath}`,
      "agent A publishes the base and keeps one local commit"
    );
    firstPhase = [...agentA.messages] as ChatMessage[];

    const agentB = await context.runner.spawn({ context: "isolated" });
    sessions.push({ role: "agent-b", session: agentB });
    await context.sendAndWait(
      agentB,
      `A collaborator has published ${repoPath}. Make a distinct compatible change there, commit it, and publish it. Follow the workspace guidance and finish with VCS_B_PUBLISHED repo:${repoPath}`,
      "agent B advances main independently"
    );

    await context.sendAndWait(
      agentA,
      `Main advanced while your compatible local commit remained unpublished. Bring the incoming semantic changes into your context one local decision at a time, commit the combined history, and publish it. Prove both collaborators' intent remains and finish with VCS_INTEGRATE_OK incoming:accounted local:preserved pushed:true event:`,
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
      "Use the workspace guidance to orient me in this editing context without changing it. Report whether it is clean, its exact committed and working identities, and how it relates to protected main. Finish with VCS_STATUS_OK clean:, committed:, working:, relation:.",
    validate: (result) =>
      checked(
        result,
        ["VCS_STATUS_OK", "clean:", "committed:", "working:", "relation:"],
        ["vcs.status"]
      ),
  },
  {
    name: "vcs-edit-whole-chain-commit",
    description: "Author several local edits and commit the complete incremental chain",
    category: "vcs",
    workspaceRepoFixture: CONTENT_WORKSPACE_REPO_FIXTURE,
    prompt:
      "In the disposable project, make two small related edits as separate local steps. Confirm both are visible before committing, then commit the complete local chain as one milestone. Use the workspace guidance and finish with VCS_COMMIT_OK changes:2 event: clean:true.",
    validate: (result) => {
      const base = checked(
        result,
        ["VCS_COMMIT_OK", "changes:2", "event:", "clean:true"],
        ["vcs.edit", "vcs.commit", "vcs.status"]
      );
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
      "Make a distinctive small change in the disposable project, commit it, and publish that exact milestone to protected main. Verify main moved to the event you intended. Follow the workspace guidance and finish with VCS_PUSH_OK event: main: match:true.",
    validate: (result) => {
      const base = checked(
        result,
        ["VCS_PUSH_OK", "event:", "main:", "match:true"],
        ["vcs.edit", "vcs.commit", "vcs.push"]
      );
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
      const base = checked(
        result,
        ["VCS_INTEGRATE_OK", "incoming:accounted", "local:preserved", "pushed:true", "event:"],
        ["vcs.compare", "vcs.integrate", "vcs.commit", "vcs.push"]
      );
      return base.passed ? requireIncrementalIntegrationEvidence(result) : base;
    },
  },
];
