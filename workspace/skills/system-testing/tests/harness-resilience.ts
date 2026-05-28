import type { TestCase } from "../types.js";
import { completedToolNames, finalMessageHasAll, noIncompleteInvocations } from "./_helpers.js";

function checked(result: Parameters<typeof finalMessageHasAll>[0], markers: string[]) {
  const msg = finalMessageHasAll(result, markers);
  if (!msg.passed) return msg;
  return noIncompleteInvocations(result);
}

export const harnessResilienceTests: TestCase[] = [
  {
    name: "eval-thrown-error-then-continues",
    description: "A failed eval surfaces an error and the same turn can still produce a final response",
    category: "harness-resilience",
    prompt: "Exercise recovery after an eval failure. Finish with HARNESS_THROW_OK, HARNESS_RECOVER_OK, and final-visible.",
    validate: (result) => {
      const completed = completedToolNames(result);
      if (!completed.has("eval")) {
        return { passed: false, reason: `Expected at least one completed eval call; completed tools: ${[...completed].join(", ") || "(none)"}` };
      }
      return finalMessageHasAll(result, ["HARNESS_THROW_OK", "HARNESS_RECOVER_OK", "final-visible"]);
    },
  },
  {
    name: "eval-huge-return-bounded-terminal",
    description: "A large eval return is bounded/terminal and does not silently stall the turn",
    category: "harness-resilience",
    prompt: "Exercise a very large eval return. Finish with HUGE_RETURN_OK, bounded-summary, and final-visible.",
    validate: (result) => checked(result, ["HUGE_RETURN_OK", "bounded-summary", "final-visible"]),
  },
  {
    name: "eval-timeout-error-visible",
    description: "A deliberately timed eval timeout/error is visible and does not leave a pending tool",
    category: "harness-resilience",
    prompt: "Exercise visible timeout/error recovery. Finish with TIMEOUT_VISIBLE_OK, TIMEOUT_RECOVERY_OK, and no-pending-tool.",
    validate: (result) => checked(result, ["TIMEOUT_VISIBLE_OK", "TIMEOUT_RECOVERY_OK", "no-pending-tool"]),
  },
  {
    name: "invalid-tool-args-visible-retry",
    description: "Tool validation errors are visible and retry succeeds without poisoning the transcript",
    category: "harness-resilience",
    prompt: "Exercise invalid tool arguments and recovery. Finish with INVALID_ARGS_VISIBLE_OK and INVALID_ARGS_RECOVER_OK.",
    validate: (result) => checked(result, ["INVALID_ARGS_VISIBLE_OK", "INVALID_ARGS_RECOVER_OK"]),
  },
  {
    name: "post-tool-followup-turn",
    description: "A follow-up user-like instruction after tool use still gets a fresh assistant response",
    category: "harness-resilience",
    prompt: "Exercise a follow-up response after tool use. Finish with FOLLOWUP_BASE_OK and FOLLOWUP_RESPONSE_OK.",
    validate: (result) => checked(result, ["FOLLOWUP_BASE_OK", "FOLLOWUP_RESPONSE_OK"]),
  },
];
