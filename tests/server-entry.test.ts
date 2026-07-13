import { describe, expect, it } from "vitest";
import { createServerInvocation } from "../scripts/cli/lib/server-entry.mjs";

describe("server entry invocation", () => {
  it("runs the live TypeScript hub directly so it owns signal handling", () => {
    expect(createServerInvocation(["src/server/index.ts", "--gateway-port", "3031"])).toEqual({
      command: process.execPath,
      args: ["--import", "tsx", "src/server/index.ts", "--gateway-port", "3031"],
    });
  });

  it("runs built servers directly with Node", () => {
    expect(createServerInvocation(["dist/server.mjs", "--gateway-port", "3031"])).toEqual({
      command: process.execPath,
      args: ["dist/server.mjs", "--gateway-port", "3031"],
    });
  });
});
