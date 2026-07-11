import type { TestCase } from "../types.js";
import { finalMessageHasAll, getToolCalls, noIncompleteInvocations } from "./_helpers.js";

function checked(result: Parameters<typeof finalMessageHasAll>[0], tokens: string[]) {
  const msg = finalMessageHasAll(result, tokens);
  if (!msg.passed) return msg;
  return noIncompleteInvocations(result);
}

function successfulNpmEval(result: Parameters<typeof finalMessageHasAll>[0]) {
  const found = getToolCalls(result).some((call) => {
    if (call.name !== "eval" || call.execution?.status !== "complete" || call.execution.isError) {
      return false;
    }
    const imports = call.arguments?.["imports"];
    return (
      imports !== null &&
      typeof imports === "object" &&
      !Array.isArray(imports) &&
      Object.values(imports as Record<string, unknown>).some(
        (value) => typeof value === "string" && value.startsWith("npm:")
      )
    );
  });
  return {
    passed: found,
    reason: found
      ? undefined
      : "Expected a successful eval invocation with an npm import-map entry",
  };
}

export const buildTests: TestCase[] = [
  {
    name: "build-workspace-package",
    description: "Build a workspace package and verify success",
    category: "build",
    prompt: "Exercise building a workspace UI unit. Finish with BUILD_WORKSPACE_OK.",
    validate: (result) => checked(result, ["BUILD_WORKSPACE_OK"]),
  },
  {
    name: "build-npm-package",
    description: "Build an npm package and get a bundle",
    category: "build",
    prompt:
      "Exercise building or resolving a small pure-JavaScript npm dependency " +
      "(e.g. left-pad) that does not rely on Node.js built-in modules like " +
      "child_process/fs/os. In eval imports, use the package name as the key " +
      'and a version-only npm ref as the value, e.g. { "left-pad": "npm:1.3.0" }. ' +
      "Finish with BUILD_NPM_OK.",
    validate: (result) => {
      const marker = checked(result, ["BUILD_NPM_OK"]);
      return marker.passed ? successfulNpmEval(result) : marker;
    },
  },
  {
    name: "build-at-state-ref",
    description: "Build a workspace package at a specific GAD state ref",
    category: "build",
    prompt:
      "Exercise building a workspace unit at an immutable GAD state ref from vcs.log. " +
      "vcs.log returns a repo-rooted outputStateHash; convert it to a workspace-rooted " +
      "state with vcs.workspaceViewWithRepoAt(repoPath, outputStateHash) before passing " +
      "it to build.getBuild. Finish with BUILD_STATE_REF_OK or BUILD_STATE_REF_UNAVAILABLE.",
    validate: (result) => {
      const ok = finalMessageHasAll(result, ["BUILD_STATE_REF_OK"]);
      if (ok.passed) return noIncompleteInvocations(result);
      return checked(result, ["BUILD_STATE_REF_UNAVAILABLE"]);
    },
  },
  {
    name: "import-built-package",
    description: "Import a built package and inspect its exports",
    category: "build",
    prompt: "Exercise importing a workspace-built package. Finish with BUILD_IMPORT_OK.",
    validate: (result) => checked(result, ["BUILD_IMPORT_OK"]),
  },
];
