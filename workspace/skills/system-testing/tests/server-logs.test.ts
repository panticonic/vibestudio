import { describe, expect, it } from "vitest";
import { serverLogTests } from "./server-logs.js";

describe("server-log system-test declarations", () => {
  it("preauthorizes only the exact read capability used by every log scenario", () => {
    for (const test of serverLogTests) {
      expect(test.authorityPolicy).toEqual({
        authority: [
          {
            ruleId: "inspect-server-host-logs",
            capability: { kind: "exact", key: "server-logs.read" },
            resource: { kind: "exact", key: "server-logs.read" },
            tier: "gated",
            decision: "once",
          },
        ],
      });
      expect(test.prompt).not.toMatch(/serverLog\.|authority|permission|approval/iu);
    }
  });
});
