import { describe, expect, it } from "vitest";
import { mergeValidateStateArgs } from "./stateArgsValidator.js";

describe("validated panel state merge patches", () => {
  it("merges and deletes before applying schema defaults and coercion", () => {
    const current = { retained: true, removed: "old", count: 1 };
    expect(
      mergeValidateStateArgs(
        current,
        { removed: null, count: "2" },
        {
          type: "object",
          properties: {
            retained: { type: "boolean" },
            count: { type: "integer" },
            label: { type: "string", default: "new" },
          },
          additionalProperties: false,
        }
      )
    ).toEqual({ retained: true, count: 2, label: "new" });
    expect(current).toEqual({ retained: true, removed: "old", count: 1 });
  });

  it("rejects a patch that violates the active schema without changing state", () => {
    const current = { count: 1 };
    expect(() =>
      mergeValidateStateArgs(
        current,
        { count: -1 },
        {
          type: "object",
          properties: { count: { type: "integer", minimum: 0 } },
        }
      )
    ).toThrow("Invalid stateArgs");
    expect(current).toEqual({ count: 1 });
  });
});
