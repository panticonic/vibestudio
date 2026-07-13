import type { TestCase } from "../types.js";
import {
  completedToolNames,
  finalMessageHasAll,
  noIncompleteInvocations,
} from "./_helpers.js";

function checked(result: Parameters<typeof finalMessageHasAll>[0], tokens: string[]) {
  const msg = finalMessageHasAll(result, tokens);
  if (!msg.passed) return msg;
  return noIncompleteInvocations(result);
}

function checkedWithEval(result: Parameters<typeof finalMessageHasAll>[0], tokens: string[]) {
  const completed = completedToolNames(result);
  if (!completed.has("eval")) {
    return {
      passed: false,
      reason: `Expected a completed eval tool call; completed tools: ${[...completed].join(", ") || "(none)"}`,
    };
  }
  return checked(result, tokens);
}

export const evalLifecycleTests: TestCase[] = [
  {
    name: "eval-db-persistence",
    description: "The eval-local database persists rows across separate eval calls",
    category: "eval-lifecycle",
    prompt:
      "Demonstrate that your sandbox's built-in local database persists between separate tool calls: create a small table and insert rows in one step, then read them back in a later, separate step. Finish with EVAL_DB_OK and rows:<count>.",
    validate: (result) => checkedWithEval(result, ["EVAL_DB_OK", "rows:"]),
  },
  {
    name: "eval-scope-reset",
    description: "Resetting the sandbox produces a genuinely fresh persistent scope",
    category: "eval-lifecycle",
    prompt:
      "Demonstrate the sandbox reset lifecycle: persist a value in your sandbox scope, verify it survives into a separate step, then reset the sandbox and prove the old value is really gone afterward. Finish with EVAL_RESET_OK and fresh:yes.",
    validate: (result) => checkedWithEval(result, ["EVAL_RESET_OK", "fresh:yes"]),
  },
  {
    name: "eval-cancel-run",
    description: "A long-running sandbox run can be cancelled and the cancellation is visible",
    category: "eval-lifecycle",
    prompt:
      "Demonstrate cancelling long-running sandbox work: start something deliberately slow in a way that lets you cancel it, cancel it, and report the observed cancelled state. Do not leave any run pending. Finish with EVAL_CANCEL_OK and cancelled:yes, or EVAL_CANCEL_UNAVAILABLE with the concrete blocking reason.",
    expectedToolFailures: [{ name: "eval", errorIncludes: "cancel" }],
    validate: (result) => {
      const ok = finalMessageHasAll(result, ["EVAL_CANCEL_OK", "cancelled:yes"]);
      if (ok.passed) return noIncompleteInvocations(result);
      return checked(result, ["EVAL_CANCEL_UNAVAILABLE"]);
    },
  },
];
