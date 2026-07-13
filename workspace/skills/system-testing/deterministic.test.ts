import { describe, expect, it } from "vitest";
import { validateDeterministicSummary } from "./deterministic-validator.js";

describe("deterministic system-test validation", () => {
  it("parses the final fenced summary without consuming earlier invocation JSON", () => {
    const result = validateDeterministicSummary([
        { content: '{"code":"return summarize(result)","total":"not the summary"}' },
        {
          content: [
            "```json",
            '{"total":1,"passed":1,"failed":0,"errored":0,"skipped":0,"duration":12,"failures":[]}',
            "```",
          ].join("\n"),
        },
      ]);

    expect(result).toMatchObject({ passed: true });
  });
});
