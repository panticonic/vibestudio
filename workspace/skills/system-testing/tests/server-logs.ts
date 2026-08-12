import type { TestAuthorityPolicy, TestCase } from "../types.js";
import {
  findLastAgentMessage,
  hasLoadedSkill,
  noIncompleteInvocations,
  successfulEvalCode,
  successfulEvalReturnValues,
} from "./_helpers.js";

const serverLogReadAuthority: TestAuthorityPolicy = {
  authority: [
    {
      ruleId: "inspect-server-host-logs",
      capability: { kind: "exact", key: "server-logs.read" },
      resource: { kind: "exact", key: "server-logs.read" },
      tier: "gated",
      decision: "once",
    },
  ],
};

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

function startupDiagnosisChecked(result: Parameters<typeof noIncompleteInvocations>[0]) {
  if (!hasLoadedSkill(result, "server-logs")) {
    return {
      passed: false,
      reason: "The vague incident did not route through server-log guidance",
    };
  }

  const code = successfulEvalCode(result);
  const boundedInspection =
    /serverLog\.tail\(\s*[1-9]\d*/u.test(code) ||
    /serverLog\.query\(\s*\{[\s\S]*?\blimit\s*:\s*[1-9]\d*/u.test(code);
  if (!boundedInspection) {
    return {
      passed: false,
      reason: "The startup diagnosis did not use one bounded host-log inspection",
    };
  }

  const envelope = records(successfulEvalReturnValues(result)).find(
    (item) =>
      Array.isArray(item["records"]) &&
      Number.isInteger(item["latestSeq"]) &&
      typeof item["serverBootId"] === "string"
  );
  if (!envelope) {
    return { passed: false, reason: "No coordinated server-log snapshot was observed" };
  }

  const final = findLastAgentMessage(result);
  const bootId = String(envelope["serverBootId"]);
  const latestSeq = Number(envelope["latestSeq"]);
  if (
    !final.includes(bootId) ||
    !exactNumber(final, latestSeq) ||
    !/(?:start|startup|boot|slow|delay|build|normal|warn|error|incident)/iu.test(final)
  ) {
    return {
      passed: false,
      reason:
        "The final diagnosis did not preserve the observed boot/sequence coordinates and explain the startup evidence",
    };
  }
  return noIncompleteInvocations(result);
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
    name: "server-log-startup-diagnosis",
    description:
      "Use recent host logs to distinguish a concrete startup incident from normal activity",
    category: "server-logs",
    authorityPolicy: serverLogReadAuthority,
    prompt:
      "Something in this workspace seemed slow to start a moment ago. Can you check the recent server logs and tell me what happened?",
    validation: "agent-evidence",
    validate: startupDiagnosisChecked,
  },
  {
    name: "server-log-query-stats",
    description: "Query recent server host logs bounded and report log statistics",
    category: "server-logs",
    authorityPolicy: serverLogReadAuthority,
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
    authorityPolicy: serverLogReadAuthority,
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
