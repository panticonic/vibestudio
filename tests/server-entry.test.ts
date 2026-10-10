import { describe, expect, it } from "vitest";
import { createServerInvocation } from "../scripts/cli/lib/server-entry.mjs";

describe("server entry invocation", () => {
  it("runs source generation servers directly so they own signal handling", () => {
    expect(createServerInvocation(["/generation/server.mjs", "--gateway-port", "3031"])).toEqual({
      command: process.execPath,
      args: ["/generation/server.mjs", "--gateway-port", "3031"],
    });
  });

  it("runs built servers directly with Node", () => {
    expect(createServerInvocation(["dist/server.mjs", "--gateway-port", "3031"])).toEqual({
      command: process.execPath,
      args: ["dist/server.mjs", "--gateway-port", "3031"],
    });
  });
});
