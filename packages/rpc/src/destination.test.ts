import { describe, expect, it } from "vitest";
import {
  isLocalRpcDestination,
  isWorkspaceRpcDestination,
  rpcDestinationKey,
  rpcDestinationMatchesCaller,
  workspaceRpcDestination,
} from "./destination.js";

describe("RPC destinations", () => {
  it("keeps omitted routing local and explicitly addressed workspaces exact", () => {
    expect(isLocalRpcDestination(undefined, "personal")).toBe(true);
    expect(isLocalRpcDestination({ kind: "workspace", workspaceId: "personal" }, "personal")).toBe(
      true
    );
    expect(isLocalRpcDestination({ kind: "workspace", workspaceId: "project" }, "personal")).toBe(
      false
    );
    expect(isLocalRpcDestination({ kind: "workspace", workspaceId: "" }, "")).toBe(false);
  });

  it("never treats a hub address as a workspace with a similar name", () => {
    expect(isLocalRpcDestination({ kind: "hub" }, "hub")).toBe(false);
    expect(workspaceRpcDestination(undefined)).toBeUndefined();
    expect(() => workspaceRpcDestination({ kind: "hub" })).toThrow("workspace RPC destination");
    expect(rpcDestinationKey({ kind: "hub" })).not.toBe(
      rpcDestinationKey({ kind: "workspace", workspaceId: "hub" })
    );
  });

  it("rejects malformed workspace addresses at the runtime boundary", () => {
    expect(isWorkspaceRpcDestination({ kind: "workspace", workspaceId: 42 })).toBe(false);
    expect(isWorkspaceRpcDestination({ kind: "workspace", workspaceId: "" })).toBe(false);
    expect(() => workspaceRpcDestination({ kind: "workspace", workspaceId: 42 } as never)).toThrow(
      "workspace RPC destination"
    );
  });

  it("matches hub replies only to the authenticated hub owner, not workspace code", () => {
    const destination = { kind: "hub" } as const;
    expect(
      rpcDestinationMatchesCaller(destination, { callerId: "hub", callerKind: "server" })
    ).toBe(true);
    expect(
      rpcDestinationMatchesCaller(destination, {
        callerId: "hub",
        callerKind: "worker",
        workspaceId: "project",
      })
    ).toBe(false);
    expect(
      rpcDestinationMatchesCaller(destination, { callerId: "other", callerKind: "server" })
    ).toBe(false);
    expect(
      rpcDestinationMatchesCaller(
        { kind: "workspace", workspaceId: "hub" },
        { callerId: "hub", callerKind: "server" }
      )
    ).toBe(false);
  });
});
