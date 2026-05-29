import type { TestCase } from "../types.js";
import { finalMessageHasAll, noIncompleteInvocations } from "./_helpers.js";

function checked(result: Parameters<typeof finalMessageHasAll>[0], markers: string[]) {
  const msg = finalMessageHasAll(result, markers);
  if (!msg.passed) return msg;
  return noIncompleteInvocations(result);
}

export const projectLifecycleTests: TestCase[] = [
  {
    name: "panel-create-commit-push-open",
    description: "Create and open a new panel project",
    category: "project-lifecycle",
    prompt: "Create and open a brand-new isolated panel project. Finish with PROJECT_PANEL_OK.",
    validate: (result) => checked(result, ["PROJECT_PANEL_OK"]),
  },
  {
    name: "panel-fork-dry-run-and-push",
    description: "Fork and open a panel project",
    category: "project-lifecycle",
    prompt: "Fork an existing panel into a new isolated panel and open the result. Finish with PROJECT_FORK_OK.",
    validate: (result) => checked(result, ["PROJECT_FORK_OK"]),
  },
  {
    name: "worker-fork-classmap-dry-run",
    description: "Plan a worker fork",
    category: "project-lifecycle",
    prompt: "Plan an isolated fork of a worker project. Finish with WORKER_FORK_OK.",
    validate: (result) => checked(result, ["WORKER_FORK_OK"]),
  },
  {
    name: "commit-and-push-existing-project",
    description: "Change and publish a package project",
    category: "project-lifecycle",
    prompt: "Create an isolated package project, change it once, and publish the change. Finish with COMMIT_AND_PUSH_OK.",
    validate: (result) => checked(result, ["COMMIT_AND_PUSH_OK"]),
  },
];
