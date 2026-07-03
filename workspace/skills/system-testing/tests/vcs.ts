import type { ChatMessage } from "@workspace/agentic-core";
import type { HeadlessSession, SessionSnapshot } from "@workspace/agentic-session";
import type { TestCase, TestExecutionResult, TestOrchestrationContext } from "../types.js";
import { finalMessageHasAll, noIncompleteInvocations } from "./_helpers.js";

function checked(result: Parameters<typeof finalMessageHasAll>[0], tokens: string[]) {
  const msg = finalMessageHasAll(result, tokens);
  if (!msg.passed) return msg;
  return noIncompleteInvocations(result);
}

function uniqueRepoPath(): string {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return `projects/system-test-vcs-divergence-${suffix}`;
}

async function orchestrateVcsMergeThenPush(
  context: TestOrchestrationContext
): Promise<TestExecutionResult> {
  const startedAt = Date.now();
  const repoPath = uniqueRepoPath();
  const sessions: Array<{ role: "agent-a" | "agent-b"; session: HeadlessSession }> = [];
  const cleanupErrors: string[] = [];
  let agentAPhase1Messages: ChatMessage[] = [];
  let error: string | undefined;

  try {
    const agentA = await context.runner.spawn();
    sessions.push({ role: "agent-a", session: agentA });
    await context.sendAndWait(agentA, agentAPreparePrompt(repoPath), "agent A prepare unpushed commit");
    agentAPhase1Messages = [...agentA.messages] as ChatMessage[];

    const agentB = await context.runner.spawn();
    sessions.push({ role: "agent-b", session: agentB });
    await context.sendAndWait(agentB, agentBPushPrompt(repoPath), "agent B push competing main commit");

    await context.sendAndWait(agentA, agentAFinalPrompt(repoPath), "agent A merge and push after divergence");
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const execution = buildOrchestratedExecution({
    sessions,
    agentAPhase1Messages,
    repoPath,
    startedAt,
    error,
  });

  for (const { role, session } of [...sessions].reverse()) {
    try {
      await session.close();
    } catch (err) {
      cleanupErrors.push(`${role} close: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      const snapshot = session.snapshot();
      cleanupErrors.push(...snapshot.cleanupErrors.map((entry) => `${role} ${entry.phase}: ${entry.message}`));
    } catch (err) {
      cleanupErrors.push(`${role} cleanup snapshot: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (cleanupErrors.length > 0) {
    execution.cleanupErrors = [...(execution.cleanupErrors ?? []), ...cleanupErrors];
    execution.error ??= `Headless cleanup failed: ${cleanupErrors.join("; ")}`;
  }
  return execution;
}

function buildOrchestratedExecution(args: {
  sessions: Array<{ role: "agent-a" | "agent-b"; session: HeadlessSession }>;
  agentAPhase1Messages: ChatMessage[];
  repoPath: string;
  startedAt: number;
  error?: string;
}): TestExecutionResult {
  const agentA = args.sessions.find((entry) => entry.role === "agent-a")?.session;
  const agentB = args.sessions.find((entry) => entry.role === "agent-b")?.session;
  const agentAPhase2Messages = agentA
    ? ([...agentA.messages] as ChatMessage[]).slice(args.agentAPhase1Messages.length)
    : [];
  const messages = [
    ...args.agentAPhase1Messages,
    ...(agentB ? ([...agentB.messages] as ChatMessage[]) : []),
    ...agentAPhase2Messages,
  ];
  const snapshots = args.sessions.map(({ role, session }) => safeSnapshot(role, session));
  const primarySnapshot = snapshots.find((entry) => entry.role === "agent-a")?.snapshot;
  return {
    messages,
    duration: Date.now() - args.startedAt,
    ...(args.error ? { error: args.error } : {}),
    ...(primarySnapshot ? { snapshot: primarySnapshot } : {}),
    diagnostics: {
      orchestrated: true,
      repoPath: args.repoPath,
      sessions: snapshots.map(({ role, snapshot, error }) => ({
        role,
        channelId: sessionChannelId(args.sessions.find((entry) => entry.role === role)?.session),
        title: snapshot?.title ?? null,
        messageCount: snapshot?.messages.length ?? 0,
        invocationCount: snapshot?.invocations.length ?? 0,
        debugEventCount: snapshot?.debugEvents.length ?? 0,
        cleanupErrorCount: snapshot?.cleanupErrors.length ?? 0,
        ...(error ? { snapshotError: error } : {}),
      })),
    },
  };
}

function safeSnapshot(
  role: "agent-a" | "agent-b",
  session: HeadlessSession
): { role: "agent-a" | "agent-b"; snapshot?: SessionSnapshot; error?: string } {
  try {
    return { role, snapshot: session.snapshot() };
  } catch (err) {
    return { role, error: err instanceof Error ? err.message : String(err) };
  }
}

function sessionChannelId(session: HeadlessSession | undefined): string | null {
  return (session as { channelId?: string | null } | undefined)?.channelId ?? null;
}

function agentAPreparePrompt(repoPath: string): string {
  return `You are Agent A in a two-agent VCS divergence system test.

Use the documented runtime VCS API only. Use your own context head only; do not pass, invent, or spoof any custom ctx:* head.

Fixed repoPath: ${repoPath}

Phase A1:
1. Seed the repo on main: write a small base file in ${repoPath}, commit it, then push it with vcs.push.
2. After that seed push succeeds, make a second Agent A change in the same repo and commit it, but do not push that second commit.
3. Report the seed push status and the unpushed Agent A commit evidence.

Finish this phase with exactly:
VCS_DIVERGENCE_A_READY repo:${repoPath}`;
}

function agentBPushPrompt(repoPath: string): string {
  return `You are Agent B in the two-agent VCS divergence system test.

The harness created you after Agent A seeded ${repoPath} on main. Use the documented runtime VCS API only. Use your own context head only; do not pass, invent, or spoof any custom ctx:* head.

Make a normal Agent B change in repoPath ${repoPath}, commit it, and push it to main with vcs.push. This is the legitimate concurrent main advance for Agent A's pending commit.

Report the push status and finish with exactly:
VCS_DIVERGENCE_B_PUSHED repo:${repoPath} status:`;
}

function agentAFinalPrompt(repoPath: string): string {
  return `Continue as Agent A in the same original context.

Agent B has now pushed a separate commit to main for repoPath ${repoPath}. Exercise the documented divergence recovery path:
1. Call vcs.push for ${repoPath} before merging and record whether it returns a structured diverged result. Do not treat a returned diverged status as a tool failure.
2. Reconcile by calling vcs.merge({ source: "main", repoPaths: [${JSON.stringify(repoPath)}] }). If the merge leaves a pending resolution or uncommitted merge edits, resolve or seal them with vcs.commit(message). If vcs.merge already produced a clean merge commit, do not invent an extra commit.
3. Call vcs.push for ${repoPath} again and report the final structured status.

Finish with exactly:
VCS_MERGE_PUSH_OK status:<final-status> diverged:yes pushed:yes`;
}

export const vcsTests: TestCase[] = [
  {
    name: "vcs-status",
    description: "Inspect a repo's per-repo GAD VCS status",
    category: "vcs",
    prompt:
      "Use the runtime vcs API to inspect a repo's status with vcs.status(repoPath) for this context. Finish with VCS_STATUS_OK, dirty:<true-or-false>, and uncommitted:<count>.",
    validate: (result) => checked(result, ["VCS_STATUS_OK", "dirty:", "uncommitted:"]),
  },
  {
    name: "vcs-edit-uncommitted",
    description: "Record a working edit and confirm it stays uncommitted (no head advance)",
    category: "vcs",
    prompt:
      "Record a small temporary file edit with vcs.edit and confirm it is tracked as an UNCOMMITTED working change: it must not advance the commit head or appear in vcs.log. Verify via vcs.status (or vcs.contextStatus) that the repo reports uncommitted changes while vcs.log shows no new commit. Finish with VCS_EDIT_OK and uncommitted:<count>.",
    validate: (result) => checked(result, ["VCS_EDIT_OK", "uncommitted:"]),
  },
  {
    name: "vcs-commit-state",
    description: "Commit working edits and report the advanced state hash",
    category: "vcs",
    prompt:
      "Record a small temporary file edit with vcs.edit, then seal it into a deliberate snapshot with vcs.commit(message) and report the resulting state hash from the commit. Finish with VCS_COMMIT_OK and state:.",
    validate: (result) => checked(result, ["VCS_COMMIT_OK", "state:"]),
  },
  {
    name: "vcs-log-history",
    description: "Make multiple commits and inspect the VCS log",
    category: "vcs",
    prompt:
      "Make two deliberate commits — each is a vcs.edit followed by vcs.commit(message) — then inspect vcs.log and report the observed entries. Finish with VCS_LOG_OK and commits:2.",
    validate: (result) => checked(result, ["VCS_LOG_OK", "commits:2"]),
  },
  {
    name: "vcs-state-diff",
    description: "Diff two committed GAD states",
    category: "vcs",
    prompt:
      "Produce two committed VCS states that differ by one temporary file edit — commit the first, edit again, commit the second — then compare the two commit state hashes with vcs.diff. Finish with VCS_DIFF_OK and changed-path.",
    validate: (result) => checked(result, ["VCS_DIFF_OK", "changed-path"]),
  },
  {
    name: "vcs-discard-edits",
    description: "Discard uncommitted working edits and confirm they are gone",
    category: "vcs",
    prompt:
      "Record a temporary file edit with vcs.edit, confirm the repo has uncommitted changes, then drop them with vcs.discardEdits(repoPath) and confirm the repo reports zero uncommitted changes afterward. Finish with VCS_DISCARD_OK and discarded:.",
    validate: (result) => checked(result, ["VCS_DISCARD_OK", "discarded:"]),
  },
  {
    name: "vcs-push-status",
    description: "Inspect a repo's unpushed changes without pushing (pre-push)",
    category: "vcs",
    prompt:
      "Inspect a repo's pre-push status with vcs.pushStatus([repoPath]) without calling vcs.push, and report whether it has uncommitted edits and how far it is ahead. Finish with VCS_PUSH_STATUS_OK, ahead:, and uncommitted:.",
    validate: (result) => checked(result, ["VCS_PUSH_STATUS_OK", "ahead:", "uncommitted:"]),
  },
  {
    name: "vcs-push-fast-forward",
    description: "Commit then fast-forward push a repo's changes into its main",
    category: "vcs",
    prompt:
      "Record a temporary file edit with vcs.edit, seal it with vcs.commit(message), then ship it with vcs.push — a fast-forward push of your committed changes into the repo's main. Push is ff-only: it rejects while edits are uncommitted, so commit first. Report the push status. Finish with VCS_PUSH_OK and status:.",
    validate: (result) => checked(result, ["VCS_PUSH_OK", "status:"]),
  },
  {
    name: "vcs-merge-then-push",
    description: "Reconcile divergence with vcs.merge, then fast-forward push",
    category: "vcs",
    prompt:
      "Harness-orchestrated two-agent divergence path: Agent A commits locally, Agent B advances main from an independent context, then Agent A observes diverged, merges, and pushes. Finish with VCS_MERGE_PUSH_OK, status:, diverged:yes, and pushed:yes.",
    orchestrate: orchestrateVcsMergeThenPush,
    validate: (result) =>
      checked(result, ["VCS_MERGE_PUSH_OK", "status:", "diverged:yes", "pushed:yes"]),
  },
];
