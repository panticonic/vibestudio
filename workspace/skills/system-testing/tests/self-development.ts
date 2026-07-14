import type { TestCase } from "../types.js";
import {
  finalMessageHasAll,
  noIncompleteInvocations,
  requireAnyEvalEvidence,
} from "./_helpers.js";

function verified(
  marker: string,
  evidence: readonly (readonly string[])[]
): TestCase["validate"] {
  return (result) => {
    const final = finalMessageHasAll(result, [marker]);
    if (!final.passed) return final;
    const complete = noIncompleteInvocations(result);
    if (!complete.passed) return complete;
    return requireAnyEvalEvidence(result, evidence);
  };
}

const gitEvidence = [["git."], ["gitInterop"], ["importProject"]] as const;
const devHostEvidence = [["devHost."], ["createDevHostClient"], ["devHostMethods"]] as const;
const workspaceEvidence = [["vcs."], ["context"], ["projects/vibestudio"]] as const;

export const selfDevelopmentGitTests: TestCase[] = [
  {
    name: "git-import-non-main-default",
    description: "Import a repository whose remote default branch is not main",
    category: "git-interop",
    resources: ["workspace-config:git"],
    workspaceRepoFixture: true,
    prompt:
      "Create a disposable Git repository whose symbolic remote HEAD names a branch other than main, import it, and prove the imported project records and contains that exact default branch state. Finish with GIT_IMPORT_NON_MAIN_DEFAULT_OK.",
    validate: verified("GIT_IMPORT_NON_MAIN_DEFAULT_OK", gitEvidence),
  },
  {
    name: "git-import-fidelity-rejection",
    description: "Reject an unrepresentable Git tree without partial publication",
    category: "git-interop",
    resources: ["workspace-config:git"],
    workspaceRepoFixture: true,
    expectedToolFailures: [{ name: "eval", errorIncludes: "symbolic" }],
    prompt:
      "Attempt to import a disposable Git commit containing an unrepresentable tracked entry such as a symbolic link. Prove the import reports the offending entry and publishes no partial workspace project. Finish with GIT_IMPORT_FIDELITY_REJECTION_OK.",
    validate: verified("GIT_IMPORT_FIDELITY_REJECTION_OK", gitEvidence),
  },
  {
    name: "git-import-post-commit-resume",
    description: "Resume durable finalization after a committed Git import interruption",
    category: "git-interop",
    resources: ["workspace-config:git"],
    workspaceRepoFixture: true,
    prompt:
      "Exercise or inspect a durable Git import through a post-publication finalization interruption, resume the same operation ID, and prove it reaches complete without a second protected-main publication. Finish with GIT_IMPORT_POST_COMMIT_RESUME_OK.",
    validate: verified("GIT_IMPORT_POST_COMMIT_RESUME_OK", gitEvidence),
  },
  {
    name: "git-import-concurrent-config-preserved",
    description: "Preserve a concurrent Git configuration edit when import compensation runs",
    category: "git-interop",
    resources: ["workspace-config:git"],
    workspaceRepoFixture: true,
    prompt:
      "Verify the durable import transaction never overwrites a concurrent remote or upstream configuration edit during failure compensation, and report the repair state and observed value. Finish with GIT_IMPORT_CONCURRENT_CONFIG_PRESERVED_OK.",
    validate: verified("GIT_IMPORT_CONCURRENT_CONFIG_PRESERVED_OK", gitEvidence),
  },
];

export const selfDevelopmentTests: TestCase[] = [
  {
    name: "host-toolchain-path-isolation",
    description: "Use only the manifest-owned host toolchain in a sanitized child environment",
    category: "self-development",
    resources: ["dev-host:lifecycle"],
    prompt:
      "Verify a host-created development child with an empty ambient PATH still resolves the host-published Vibestudio CLI and package manager, and that no parent PATH entry is inherited. Finish with HOST_TOOLCHAIN_PATH_ISOLATION_OK.",
    validate: verified("HOST_TOOLCHAIN_PATH_ISOLATION_OK", devHostEvidence),
  },
  {
    name: "host-toolchain-owned-runtime",
    description: "Launch development children with the exact published runtime",
    category: "self-development",
    resources: ["dev-host:lifecycle"],
    prompt:
      "Verify the development supervisor launches its build, child hub, and managed client using the runtime digest named by the active host toolchain manifest, even when ambient Node is unavailable. Finish with HOST_TOOLCHAIN_OWNED_RUNTIME_OK.",
    validate: verified("HOST_TOOLCHAIN_OWNED_RUNTIME_OK", devHostEvidence),
  },
  {
    name: "context-mirror-native-edit-roundtrip",
    description: "Round-trip a native working-tree edit into canonical GAD state",
    category: "self-development",
    resources: ["context-workspace:mirror"],
    prompt:
      "Create a managed writable projects/vibestudio context workspace, make a native file edit there, flush it, and prove the exact bytes and provenance appear as an uncommitted canonical working edit. Finish with CONTEXT_MIRROR_NATIVE_EDIT_ROUNDTRIP_OK.",
    validate: verified("CONTEXT_MIRROR_NATIVE_EDIT_ROUNDTRIP_OK", workspaceEvidence),
  },
  {
    name: "context-mirror-cas-conflict-preserves-local",
    description: "Keep local bytes and conflict journal after a stale mirror write",
    category: "self-development",
    resources: ["context-workspace:mirror"],
    prompt:
      "Cause the same mirrored file to change both canonically and in the native working tree, flush the native edit with its stale base, and prove neither side is overwritten and the conflict remains actionable. Finish with CONTEXT_MIRROR_CAS_CONFLICT_PRESERVES_LOCAL_OK.",
    validate: verified("CONTEXT_MIRROR_CAS_CONFLICT_PRESERVES_LOCAL_OK", workspaceEvidence),
  },
  {
    name: "dev-host-launch-dirty-context",
    description: "Launch the exact uncommitted projects/vibestudio working state",
    category: "self-development",
    resources: ["dev-host:lifecycle", "projects/vibestudio"],
    prompt:
      "Make a visible uncommitted projects/vibestudio edit, launch an isolated development host from the current context, and prove status names the dirty count, source state, execution input, and active build that contain it. Finish with DEV_HOST_LAUNCH_DIRTY_CONTEXT_OK.",
    validate: verified("DEV_HOST_LAUNCH_DIRTY_CONTEXT_OK", devHostEvidence),
  },
  {
    name: "dev-host-immutable-snapshot-race",
    description: "Keep an in-flight development build bound to its original source snapshot",
    category: "self-development",
    resources: ["dev-host:lifecycle", "projects/vibestudio"],
    prompt:
      "Advance projects/vibestudio while a development build is in flight. Prove the first artifact contains only its recorded immutable input and the later state is a distinct coalesced candidate. Finish with DEV_HOST_IMMUTABLE_SNAPSHOT_RACE_OK.",
    validate: verified("DEV_HOST_IMMUTABLE_SNAPSHOT_RACE_OK", devHostEvidence),
  },
  {
    name: "dev-host-state-bound-approval",
    description: "Pause a changed source candidate for a new exact execution approval",
    category: "self-development",
    resources: ["dev-host:lifecycle", "projects/vibestudio"],
    prompt:
      "Advance an owned development launch beyond its approved execution input. Prove the latest candidate pauses awaiting exact-state approval while eval and status still identify the last-good active generation. Finish with DEV_HOST_STATE_BOUND_APPROVAL_OK.",
    validate: verified("DEV_HOST_STATE_BOUND_APPROVAL_OK", devHostEvidence),
  },
  {
    name: "dev-host-process-authority-isolation",
    description: "Prevent development subprocesses from inheriting parent provider authority",
    category: "self-development",
    resources: ["dev-host:lifecycle"],
    prompt:
      "Inspect a managed development build and child environment and prove it contains no parent extension RPC token, management token, bearer credential, or undeclared secret while normal direct eval still works through the supervisor. Finish with DEV_HOST_PROCESS_AUTHORITY_ISOLATION_OK.",
    validate: verified("DEV_HOST_PROCESS_AUTHORITY_ISOLATION_OK", devHostEvidence),
  },
  {
    name: "dev-host-candidate-startup-rollback",
    description: "Restore the correctly labelled retained last-good host after candidate startup failure",
    category: "self-development",
    resources: ["dev-host:lifecycle", "projects/vibestudio"],
    prompt:
      "Introduce a development candidate that fails startup or readiness after build validation. Prove retained-data handoff restores the old active process and labels, and status reports the candidate failure without claiming promotion. Finish with DEV_HOST_CANDIDATE_STARTUP_ROLLBACK_OK.",
    validate: verified("DEV_HOST_CANDIDATE_STARTUP_ROLLBACK_OK", devHostEvidence),
  },
  {
    name: "dev-host-direct-eval",
    description: "Evaluate against an isolated child host through typed direct RPC",
    category: "self-development",
    resources: ["dev-host:lifecycle", "projects/vibestudio"],
    prompt:
      "Launch or use an owned isolated development host, call devHost.eval without a CLI relay, and prove the result comes from the active child build and source identity. Finish with DEV_HOST_DIRECT_EVAL_OK.",
    validate: verified("DEV_HOST_DIRECT_EVAL_OK", devHostEvidence),
  },
  {
    name: "dev-client-current-host",
    description: "Pair a dev-built Electron client only to the current host",
    category: "self-development",
    resources: ["dev-host:lifecycle", "desktop-client"],
    prompt:
      "Launch the current-host-client development target and prove its verified ready identity names this host and workspace while the ordinary desktop remains running. Finish with DEV_CLIENT_CURRENT_HOST_OK.",
    validate: verified("DEV_CLIENT_CURRENT_HOST_OK", devHostEvidence),
  },
  {
    name: "dev-client-profile-isolation",
    description: "Isolate each managed dev client's profile, singleton, and global side effects",
    category: "self-development",
    resources: ["dev-host:lifecycle", "desktop-client"],
    prompt:
      "Verify two managed development clients can coexist with the ordinary desktop using distinct private profiles and singleton identities, without protocol registration, updater, or default-app mutation. Finish with DEV_CLIENT_PROFILE_ISOLATION_OK.",
    validate: verified("DEV_CLIENT_PROFILE_ISOLATION_OK", devHostEvidence),
  },
  {
    name: "dev-client-version-skew-rejection",
    description: "Reject an incompatible current-host client before issuing pairing material",
    category: "self-development",
    resources: ["dev-host:lifecycle", "desktop-client"],
    expectedToolFailures: [{ name: "eval", errorIncludes: "incompatible" }],
    prompt:
      "Attempt a current-host-client launch whose declared RPC contract is incompatible. Prove it fails before consuming a pairing invite or changing any desktop profile. Finish with DEV_CLIENT_VERSION_SKEW_REJECTION_OK.",
    validate: verified("DEV_CLIENT_VERSION_SKEW_REJECTION_OK", devHostEvidence),
  },
  {
    name: "claude-code-materialize-edit-complete",
    description: "Complete a Claude edit through its synchronized writable context workspace",
    category: "self-development",
    resources: ["claude-code", "context-workspace:mirror"],
    prompt:
      "Launch a Claude Code subagent in its managed writable context workspace, make one projects/vibestudio edit, settle the agent, and prove the edit flushed to canonical GAD state with no pending synchronization. Finish with CLAUDE_CODE_MATERIALIZE_EDIT_COMPLETE_OK.",
    validate: verified("CLAUDE_CODE_MATERIALIZE_EDIT_COMPLETE_OK", workspaceEvidence),
  },
  {
    name: "claude-code-no-parent-authority",
    description: "Give Claude only its linked-agent credential and sanitized toolchain environment",
    category: "self-development",
    resources: ["claude-code"],
    prompt:
      "Inspect a managed Claude Code child environment and prove it has its linked-agent credential and host toolchain but no parent extension RPC token, admin token, or unrelated bearer credential. Finish with CLAUDE_CODE_NO_PARENT_AUTHORITY_OK.",
    validate: verified("CLAUDE_CODE_NO_PARENT_AUTHORITY_OK", [["claude"], ...devHostEvidence]),
  },
  {
    name: "claude-code-crash-cleanup",
    description: "Report a Claude crash and settle its mirror and linked-agent lifecycle",
    category: "self-development",
    resources: ["claude-code", "context-workspace:mirror"],
    prompt:
      "Cause or inspect a managed Claude Code process crash and prove it becomes a visible terminal failure while final synchronization, process, and linked-agent cleanup all settle. Finish with CLAUDE_CODE_CRASH_CLEANUP_OK.",
    validate: verified("CLAUDE_CODE_CRASH_CLEANUP_OK", [["claude"], ...workspaceEvidence]),
  },
];
