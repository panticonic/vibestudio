import type { TestCase } from "../types.js";
import {
  findLastAgentMessage,
  noIncompleteInvocations,
  successfulEvalCode,
  successfulEvalReturnValues,
} from "./_helpers.js";

function records(value: unknown, found: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const item of value) records(item, found);
    return found;
  }
  if (!value || typeof value !== "object") return found;
  const item = value as Record<string, unknown>;
  found.push(item);
  for (const child of Object.values(item)) records(child, found);
  return found;
}

function exactNumber(message: string, value: number): boolean {
  return new RegExp(`(?:^|\\D)${value}(?:\\D|$)`, "u").test(message);
}

function checked(
  result: Parameters<typeof noIncompleteInvocations>[0],
  methods: RegExp[],
  bounded: RegExp,
  prove: (values: unknown[], final: string) => boolean
) {
  const code = successfulEvalCode(result);
  if (!methods.every((method) => method.test(code)) || !bounded.test(code)) {
    return {
      passed: false,
      reason: "Canonical eval arguments omitted a required bounded server-log operation",
    };
  }
  const values = successfulEvalReturnValues(result);
  if (values.length === 0)
    return { passed: false, reason: "No canonical server-log result was observed" };
  const final = findLastAgentMessage(result);
  if (!prove(values, final)) {
    return {
      passed: false,
      reason: "Final response did not semantically report the observed server logs",
    };
  }
  return noIncompleteInvocations(result);
}

export const serverLogTests: TestCase[] = [
  {
    name: "server-log-query-stats",
    description: "Query recent server host logs bounded and report log statistics",
    category: "server-logs",
    prompt:
      "Inspect a bounded recent sample of the server's own host logs at warning level or higher, and summarize both what the sample contains and the overall log statistics.",
    validate: (result) =>
      checked(
        result,
        [/serverLog\.query/iu, /serverLog\.stats/iu],
        /\blimit\s*:\s*[1-9]\d*/u,
        (values, final) => {
          const all = records(values);
          const envelope = all.find(
            (item) =>
              Array.isArray(item["records"]) &&
              Number.isInteger(item["latestSeq"]) &&
              typeof item["serverBootId"] === "string"
          );
          const stats = all.find(
            (item) =>
              Number.isInteger(item["totalCaptured"]) &&
              Number.isInteger(item["bufferSize"]) &&
              typeof item["byLevel"] === "object"
          );
          if (!envelope || !stats) return false;
          const logRecords = envelope["records"] as unknown[];
          if (
            !logRecords.every(
              (item) =>
                item &&
                typeof item === "object" &&
                ["warn", "error"].includes(String((item as Record<string, unknown>)["level"] ?? ""))
            )
          ) {
            return false;
          }
          const count = logRecords.length;
          return (
            /server|host/iu.test(final) &&
            /warn|error/iu.test(final) &&
            /stat|total|count/iu.test(final) &&
            exactNumber(final, count) &&
            exactNumber(final, Number(stats["totalCaptured"]))
          );
        }
      ),
  },
  {
    name: "server-log-tail",
    description: "Tail the newest server host log entries",
    category: "server-logs",
    prompt:
      "Look at only the newest few entries in the server's host-log tail. Tell me how many you observed and the severity of the newest entry.",
    validate: (result) =>
      checked(result, [/serverLog\.tail/iu], /serverLog\.tail\(\s*[1-9]\d*/u, (values, final) => {
        const envelope = records(values).find(
          (item) =>
            Array.isArray(item["records"]) &&
            Number.isInteger(item["latestSeq"]) &&
            typeof item["serverBootId"] === "string"
        );
        if (!envelope) return false;
        const logRecords = envelope["records"] as unknown[];
        const newest = logRecords.at(-1);
        const newestLevel =
          newest && typeof newest === "object"
            ? (newest as Record<string, unknown>)["level"]
            : undefined;
        return (
          /newest|latest|tail/iu.test(final) &&
          exactNumber(final, logRecords.length) &&
          (typeof newestLevel === "string"
            ? final.toLowerCase().includes(newestLevel.toLowerCase())
            : /none|no entries|empty/iu.test(final))
        );
      }),
  },
];
