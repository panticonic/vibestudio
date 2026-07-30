import { describe, expect, it } from "vitest";
import { workspaceStateEngineMethods } from "./workspaceStateEngine.js";

describe("workspace state entity source identity", () => {
  it("accepts an honest absent execution version for an inert session", () => {
    expect(
      workspaceStateEngineMethods.entityActivate.args.parse([
        {
          kind: "session",
          source: { repoPath: "agent-cli", effectiveVersion: "" },
          contextId: "ctx-system-tests",
          key: "system-tests",
        },
      ])
    ).toEqual([
      {
        kind: "session",
        source: { repoPath: "agent-cli", effectiveVersion: "" },
        contextId: "ctx-system-tests",
        key: "system-tests",
      },
    ]);
  });
});
