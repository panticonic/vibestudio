import {
  CONTENT_WORKSPACE_REPO_FIXTURE,
  type TestCase,
  type TestExecutionResult,
  type TestResult,
  type WorkspaceRepoFixtureSpec,
} from "../types.js";
import { findLastAgentMessage, getToolCalls, noIncompleteInvocations } from "./_helpers.js";

function hasEvidence(
  result: TestExecutionResult,
  guidance: RegExp,
  finalClaims: RegExp[],
  actionEvidence?: RegExp[]
): TestResult {
  const completed = getToolCalls(result).filter(
    (call) => call.execution?.status === "complete" && call.execution.isError !== true
  );
  const docsEvidence = completed
    .filter(
      (call) => call.name === "read" || call.name === "docs_search" || call.name === "docs_open"
    )
    .map((call) => JSON.stringify(call.execution?.result ?? null))
    .join("\n");
  if (!guidance.test(docsEvidence)) {
    return {
      passed: false,
      reason: "No completed documentation read supplied the relevant workspace guidance",
    };
  }
  if (actionEvidence) {
    const actions = completed
      .filter(
        (call) => call.name !== "read" && call.name !== "docs_search" && call.name !== "docs_open"
      )
      .map(
        (call) =>
          `${call.name}\n${JSON.stringify(call.arguments ?? {})}\n${JSON.stringify(call.execution?.result ?? null)}`
      )
      .join("\n");
    if (!actionEvidence.every((pattern) => pattern.test(actions))) {
      return {
        passed: false,
        reason: "Canonical tool evidence did not demonstrate the documented workflow",
      };
    }
  }
  const final = findLastAgentMessage(result);
  if (!finalClaims.every((claim) => claim.test(final))) {
    return {
      passed: false,
      reason: "Final response did not apply the observed documentation semantically",
    };
  }
  return noIncompleteInvocations(result);
}

function appliedDocsProbe(
  name: string,
  description: string,
  task: string,
  guidance: RegExp,
  finalClaims: RegExp[],
  options?: { workspaceRepoFixture?: WorkspaceRepoFixtureSpec; actionEvidence?: RegExp[] }
): TestCase {
  return {
    name,
    description,
    category: "docs-probes",
    prompt: task,
    ...(options?.workspaceRepoFixture
      ? { workspaceRepoFixture: options.workspaceRepoFixture }
      : {}),
    validate: (result) => hasEvidence(result, guidance, finalClaims, options?.actionEvidence),
  };
}

export const docsProbeTests: TestCase[] = [
  appliedDocsProbe(
    "docs-sandbox-vcs-decision",
    "Choose and verify the safe workspace VCS path from a browser/eval context",
    "A user asks you to commit workspace source changes from inside a browser panel. Determine what you would do.",
    /sandbox|runtime|vcs|version.control/iu,
    [/browser|panel/iu, /workspace|semantic|vcs|version.control/iu, /not|avoid|cannot|instead/iu]
  ),
  appliedDocsProbe(
    "docs-interaction-surface-choice",
    "Choose an interaction surface for a fallible user workflow",
    "A setup flow has links and an operation that can fail. What interaction approach fits it?",
    /interaction|action.bar|panel/iu,
    [/link/iu, /fail|error/iu, /action|panel|surface/iu]
  ),
  appliedDocsProbe(
    "docs-workspace-dev-change-loop",
    "Create, publish, and inspect a real isolated panel",
    "Create, publish, and inspect a tiny isolated panel project.",
    /workspace-dev|workflow|panel/iu,
    [/panel|project/iu, /publish/iu, /open|inspect/iu],
    {
      workspaceRepoFixture: CONTENT_WORKSPACE_REPO_FIXTURE,
      actionEvidence: [
        /\bcreate_project\b|createProject/iu,
        /\bcommit\b|vcs\.commit/iu,
        /\bpush\b|vcs\.push/iu,
        /openPanel/iu,
      ],
    }
  ),
  appliedDocsProbe(
    "docs-worker-fork-rpc-plan",
    "Plan a worker fork and verify the runtime routing concept",
    "Plan how to fork a worker that might expose Durable Objects and call one later.",
    /worker|durable|rpc|routing/iu,
    [/fork|clone/iu, /durable object/iu, /route|rpc|service/iu]
  ),
  appliedDocsProbe(
    "docs-appdev-target-triage",
    "Triage a target-specific app bug without editing source",
    "A user reports a bug seen only in the Electron shell. Triage it.",
    /appdev|electron|target/iu,
    [/electron/iu, /triage|diagnos|inspect/iu, /without|before|not edit|read.only/iu]
  ),
  appliedDocsProbe(
    "docs-extensiondev-risk-plan",
    "Produce an approval/fetch/migration risk plan for an extension",
    "A new extension needs network fetches, stored credentials, and a schema change. Plan it.",
    /extensiondev|approval|credential|migration/iu,
    [/approval/iu, /credential/iu, /migration|schema/iu, /network|fetch/iu]
  ),
  appliedDocsProbe(
    "docs-browser-import-safety",
    "Classify risky browser import artifacts and avoid unsafe import behavior",
    "A user asks to import all browser data automatically from every detected profile. Respond with the right workflow.",
    /browser|import|profile|discovery/iu,
    [/discover|profile/iu, /confirm|select|approval|ask/iu, /not|avoid|unsafe|sensitive/iu]
  ),
  appliedDocsProbe(
    "docs-credentialed-apis",
    "Diagnose missing auth for credentialed APIs without leaking secrets",
    "A credentialed API call fails because no connection is configured. Diagnose the next step.",
    /credential|oauth|api.integrations/iu,
    [/credential|oauth|connection/iu, /connect|authorize|user/iu, /secret|safe|not expose/iu]
  ),
  appliedDocsProbe(
    "docs-headless-gad-diagnostics",
    "Gather bounded diagnostics for a stalled agent",
    "A headless agent has no final message after a tool call. Investigate briefly.",
    /headless|diagnostic|gad|agent/iu,
    [/pending|in.flight|stalled|running/iu, /bounded|recent|limit|brief/iu, /tool|invocation/iu]
  ),
  appliedDocsProbe(
    "docs-agent-operating-policy",
    "Choose the next action under workspace and web-fact uncertainty",
    "A new workspace has ambiguous setup state and the user asks a question that may require current web facts. Choose the next action.",
    /operating|policy|workspace|web/iu,
    [/workspace/iu, /inspect|check|read/iu, /web|current|browse/iu, /uncertain|if|depending/iu]
  ),
];
