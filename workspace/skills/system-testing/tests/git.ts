import type { TestCase } from "../types.js";
import { finalMessageHasAll, noIncompleteInvocations } from "./_helpers.js";

function checked(result: Parameters<typeof finalMessageHasAll>[0], tokens: string[]) {
  const msg = finalMessageHasAll(result, tokens);
  if (!msg.passed) return msg;
  return noIncompleteInvocations(result);
}

export const gitTests: TestCase[] = [
  {
    name: "init-commit",
    description: "Initialize a git repo, create a file, and commit",
    category: "git",
    prompt: "Exercise creating a git commit. Finish with GIT_COMMIT_OK and hash:<short-hash>.",
    validate: (result) => checked(result, ["GIT_COMMIT_OK", "hash:"]),
  },
  {
    name: "branch-checkout",
    description: "Create and switch branches",
    category: "git",
    prompt: "Exercise git branching. Finish with GIT_BRANCH_OK and branch:feature.",
    validate: (result) => checked(result, ["GIT_BRANCH_OK", "branch:feature"]),
  },
  {
    name: "diff-status",
    description: "Modify a file and check git status/diff",
    category: "git",
    prompt: "Exercise git status or diff. Finish with GIT_STATUS_OK and modified-file.",
    validate: (result) => checked(result, ["GIT_STATUS_OK", "modified-file"]),
  },
  {
    name: "log-history",
    description: "Make multiple commits and view the log",
    category: "git",
    prompt: "Exercise git history. Finish with GIT_LOG_OK and commits:3.",
    validate: (result) => checked(result, ["GIT_LOG_OK", "commits:3"]),
  },
  {
    name: "stash-pop",
    description: "Stash changes, verify clean state, then pop",
    category: "git",
    prompt: "Exercise git stash and restore. Finish with GIT_STASH_OK, clean-after-stash, and restored-after-pop.",
    validate: (result) => checked(result, ["GIT_STASH_OK", "clean-after-stash", "restored-after-pop"]),
  },
  {
    name: "push-to-remote",
    description: "Push a commit to the workspace git server",
    category: "git",
    prompt: "Exercise pushing a git commit. Finish with GIT_PUSH_OK or GIT_PUSH_MISMATCH.",
    validate: (result) => {
      const ok = finalMessageHasAll(result, ["GIT_PUSH_OK"]);
      if (ok.passed) return noIncompleteInvocations(result);
      return checked(result, ["GIT_PUSH_MISMATCH"]);
    },
  },
];
