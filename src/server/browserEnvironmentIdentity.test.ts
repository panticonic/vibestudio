import { describe, expect, it } from "vitest";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import {
  browserEnvironmentIdentity,
  browserEnvironmentIdentityFromContext,
} from "./browserEnvironmentIdentity.js";

describe("browserEnvironmentIdentity", () => {
  it("is stable for one verified user and workspace", () => {
    const caller = { subject: { userId: "user-a", handle: "alice" } };
    expect(browserEnvironmentIdentity("workspace-a", caller)).toEqual(
      browserEnvironmentIdentity("workspace-a", caller)
    );
  });

  it("separates users and workspaces without exposing either identifier", () => {
    const first = browserEnvironmentIdentity("workspace-a", {
      subject: { userId: "user-a", handle: "alice" },
    });
    const otherUser = browserEnvironmentIdentity("workspace-a", {
      subject: { userId: "user-b", handle: "bob" },
    });
    const otherWorkspace = browserEnvironmentIdentity("workspace-b", {
      subject: { userId: "user-a", handle: "alice" },
    });
    expect(
      new Set([first.environmentKey, otherUser.environmentKey, otherWorkspace.environmentKey]).size
    ).toBe(3);
    expect(first.environmentKey).not.toContain("user-a");
    expect(first.environmentKey).not.toContain("workspace-a");
  });

  it("rejects absent and system identities", () => {
    expect(() => browserEnvironmentIdentity("workspace-a", { subject: undefined })).toThrow(
      /verified user/
    );
    expect(() =>
      browserEnvironmentIdentity("workspace-a", {
        subject: { userId: "system", handle: "system" },
      })
    ).toThrow(/verified user/);
  });

  it("uses the verified authorizing user for extension-mediated calls", () => {
    const identity = browserEnvironmentIdentityFromContext("workspace-a", {
      caller: createVerifiedCaller("extension:browser-data", "extension", null, null, {
        userId: "system",
        handle: "system",
      }),
      authorizingCaller: createVerifiedCaller("shell:dev_alice", "shell", null, null, {
        userId: "user-a",
        handle: "alice",
      }),
    });

    expect(identity.ownerUserId).toBe("user-a");
  });
});
