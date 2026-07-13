import type { TestCase } from "../types.js";
import { finalMessageHasAll, noIncompleteInvocations } from "./_helpers.js";

function checked(result: Parameters<typeof finalMessageHasAll>[0], tokens: string[]) {
  const msg = finalMessageHasAll(result, tokens);
  if (!msg.passed) return msg;
  return noIncompleteInvocations(result);
}

export const vcsAdvancedTests: TestCase[] = [
  {
    name: "vcs-revert-commit",
    description: "Revert a committed change and verify the restored content",
    category: "vcs-advanced",
    prompt:
      "Commit a small change to a temporary file, then undo that committed change through workspace VCS and verify the file content is back to its previous state, reporting whether the reversal itself is committed or still a working change. Finish with VCS_REVERT_OK and restored:<true-or-false>.",
    validate: (result) => checked(result, ["VCS_REVERT_OK", "restored:"]),
  },
  {
    name: "vcs-preview-build-working",
    description: "Build working (uncommitted) content on demand without committing",
    category: "vcs-advanced",
    prompt:
      "Make an uncommitted working change to a small buildable workspace unit and get a build of that working content without committing or pushing anything, then confirm the head did not advance. Finish with VCS_PREVIEW_OK and committed:no.",
    validate: (result) => checked(result, ["VCS_PREVIEW_OK", "committed:no"]),
  },
  {
    name: "vcs-read-and-list-at-head",
    description: "Read a file and list files at the current head including working content",
    category: "vcs-advanced",
    prompt:
      "Record a working edit to a temporary file, then read that file's content back through the VCS view of the current head (not the plain filesystem) and list files there to prove the working content is visible. Finish with VCS_READFILE_OK, content-match, and files:<count>.",
    validate: (result) => checked(result, ["VCS_READFILE_OK", "content-match", "files:"]),
  },
  {
    name: "vcs-file-history",
    description: "Trace one file's commit history across multiple commits",
    category: "vcs-advanced",
    prompt:
      "Commit two separate changes to the same temporary file, then trace that single file's history and report the entries you observed. Finish with VCS_FILE_HISTORY_OK and entries:2.",
    validate: (result) => checked(result, ["VCS_FILE_HISTORY_OK", "entries:2"]),
  },
  {
    name: "vcs-pending-merge-inspect",
    description: "Inspect the pending-merge state of the current context",
    category: "vcs-advanced",
    prompt:
      "Check whether this context has a merge in progress and report the pending-merge state and any unresolved conflicts. Finish with VCS_PENDING_MERGE_OK and pending:<yes-or-no>.",
    validate: (result) => checked(result, ["VCS_PENDING_MERGE_OK", "pending:"]),
  },
  {
    name: "vcs-rebase-context",
    description: "Bring the working context up to date with the repo's main",
    category: "vcs-advanced",
    prompt:
      "Bring your working context up to date with the latest main and report whether anything actually changed or you were already current. Finish with VCS_REBASE_OK and status:<result>.",
    validate: (result) => checked(result, ["VCS_REBASE_OK", "status:"]),
  },
  {
    name: "vcs-edit-provenance",
    description: "Attribute a recorded edit to the actor and turn that produced it",
    category: "vcs-advanced",
    prompt:
      "Record a working edit to a temporary file, then find out through the VCS provenance surface which actor recorded that edit and in which turn. Finish with VCS_PROVENANCE_OK and actor:<id>.",
    validate: (result) => checked(result, ["VCS_PROVENANCE_OK", "actor:"]),
  },
  {
    name: "vcs-semantic-recall",
    description: "Semantically recall past VCS activity",
    category: "vcs-advanced",
    prompt:
      "Commit a small change with a distinctive message, then use the VCS memory recall surface to find that activity again from a natural-language description. Finish with VCS_RECALL_OK and matched:<count>, or VCS_RECALL_UNAVAILABLE with the concrete blocking reason.",
    validate: (result) => {
      const ok = finalMessageHasAll(result, ["VCS_RECALL_OK", "matched:"]);
      if (ok.passed) return noIncompleteInvocations(result);
      return checked(result, ["VCS_RECALL_UNAVAILABLE"]);
    },
  },
];
