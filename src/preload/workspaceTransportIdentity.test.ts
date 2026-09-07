import { describe, expect, it } from "vitest";
import {
  readWorkspaceTransportIdentity,
  workspaceTransportArgument,
} from "./workspaceTransportIdentity";
describe("workspace transport identity", () => {
  it("roundtrips the native workspace and runtime identities without shell quoting", () => {
    const identity = { workspaceId: "workspace/one", runtimeId: '@workspace-apps/shell "quoted"' };
    expect(
      readWorkspaceTransportIdentity(["electron", workspaceTransportArgument(identity)])
    ).toEqual(identity);
  });
  it("rejects missing or incomplete routing metadata", () => {
    expect(() => readWorkspaceTransportIdentity([])).toThrow(/no workspace identity/);
    expect(() =>
      readWorkspaceTransportIdentity(["--vibestudio-workspace-identity=%7B%7D"])
    ).toThrow(/invalid/);
  });
});
