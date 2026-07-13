import type { TestCase } from "../types.js";
import {
  finalMessageHasAll,
  finalMessageHasAny,
  noIncompleteInvocations,
  requireAnyEvalEvidence,
} from "./_helpers.js";

function checked(result: Parameters<typeof finalMessageHasAll>[0], tokens: string[]) {
  const msg = finalMessageHasAll(result, tokens);
  if (!msg.passed) return msg;
  return noIncompleteInvocations(result);
}

/**
 * OK path is strict (marker + no pending tools + eval evidence for the git
 * interop surface); the UNAVAILABLE path is accepted only when reported as the
 * documented explicit fallback marker, because external Git connectivity and
 * provider availability legitimately vary per deployment.
 */
function checkedOrUnavailable(
  result: Parameters<typeof finalMessageHasAll>[0],
  okTokens: string[],
  unavailableMarker: string,
  evidenceAlternatives: readonly (readonly string[])[]
) {
  const ok = finalMessageHasAll(result, okTokens);
  if (ok.passed) {
    const pending = noIncompleteInvocations(result);
    if (!pending.passed) return pending;
    return requireAnyEvalEvidence(result, evidenceAlternatives);
  }
  return checked(result, [unavailableMarker]);
}

export const gitInteropTests: TestCase[] = [
  {
    name: "git-upstream-status",
    description: "Inspect external Git upstream tracking across workspace repos",
    category: "git-interop",
    resources: ["workspace-config:git"],
    prompt:
      "Find out whether any repos in this workspace track an external Git upstream and report their sync state. Finish with GIT_UPSTREAM_STATUS_OK and tracked:<count>.",
    validate: (result) => checked(result, ["GIT_UPSTREAM_STATUS_OK", "tracked:"]),
  },
  {
    name: "git-publish-local-remote",
    description: "Publish a workspace repo to a disposable external Git remote and push",
    category: "git-interop",
    resources: ["workspace-config:git"],
    prompt:
      "Connect a small disposable workspace repo to an external Git remote that you can reach without real credentials (create a throwaway local one if that is the documented way), ship the repo's main there, and verify the remote actually received it. Finish with GIT_PUBLISH_OK and pushed:<commit-count>, or GIT_PUBLISH_UNAVAILABLE with the concrete blocking reason.",
    validate: (result) =>
      checkedOrUnavailable(
        result,
        ["GIT_PUBLISH_OK", "pushed:"],
        "GIT_PUBLISH_UNAVAILABLE",
        [["git."], ["gitInterop"], ["@vibestudio/git"]]
      ),
  },
  {
    name: "git-import-project",
    description: "Import an external Git project into the workspace",
    category: "git-interop",
    resources: ["workspace-config:git"],
    prompt:
      "Import an external Git project into this workspace from a repository URL reachable without credentials (a throwaway local repository is fine), then confirm the imported project is present and tracked. Finish with GIT_IMPORT_OK and imported:<path>, or GIT_IMPORT_UNAVAILABLE with the concrete blocking reason.",
    validate: (result) =>
      checkedOrUnavailable(
        result,
        ["GIT_IMPORT_OK", "imported:"],
        "GIT_IMPORT_UNAVAILABLE",
        [["importProject"], ["git."], ["gitInterop"]]
      ),
  },
  {
    name: "git-commit-mapping",
    description: "Report the workspace-commit to git-commit mapping for an exported repo",
    category: "git-interop",
    resources: ["workspace-config:git"],
    prompt:
      "For a repo that has been exported to external Git (set one up first if none exists and the environment allows it), report how workspace commits map to git commits. Finish with GIT_MAPPING_OK and mapped:<count>, or GIT_MAPPING_UNAVAILABLE with the concrete blocking reason.",
    validate: (result) => {
      const ok = finalMessageHasAny(result, ["GIT_MAPPING_OK", "GIT_MAPPING_UNAVAILABLE"]);
      if (!ok.passed) return ok;
      return noIncompleteInvocations(result);
    },
  },
];
