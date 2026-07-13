import type { TestCase } from "../types.js";
import {
  finalMessageHasAll,
  finalMessageHasNumericField,
  noIncompleteInvocations,
  requireEvalEvidence,
} from "./_helpers.js";

function checked(result: Parameters<typeof finalMessageHasAll>[0], tokens: string[]) {
  const msg = finalMessageHasAll(result, tokens);
  if (!msg.passed) return msg;
  return noIncompleteInvocations(result);
}

export const serverLogTests: TestCase[] = [
  {
    name: "server-log-query-stats",
    description: "Query recent server host logs bounded and report log statistics",
    category: "server-logs",
    prompt:
      "Inspect the server's own host logs: fetch a bounded batch of recent entries at warning level or above and report overall log statistics. Keep the evidence bounded. Finish with SERVER_LOG_QUERY_OK, SERVER_LOG_STATS_OK, and count:<number>.",
    validate: (result) => {
      const base = checked(result, ["SERVER_LOG_QUERY_OK", "SERVER_LOG_STATS_OK"]);
      if (!base.passed) return base;
      const count = finalMessageHasNumericField(result, "count");
      if (!count.passed) return count;
      return requireEvalEvidence(result, ["serverLog"]);
    },
  },
  {
    name: "server-log-tail",
    description: "Tail the newest server host log entries",
    category: "server-logs",
    prompt:
      "Grab the newest few entries from the server's host log tail and report how many you saw and the level of the newest one. Finish with SERVER_LOG_TAIL_OK and entries:<count>.",
    validate: (result) => {
      const base = checked(result, ["SERVER_LOG_TAIL_OK", "entries:"]);
      if (!base.passed) return base;
      return requireEvalEvidence(result, ["serverLog"]);
    },
  },
];
