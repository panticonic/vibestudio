import { describe, expect, it } from "vitest";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import {
  browserEnvironmentIdentity,
  browserEnvironmentIdentityFromContext,
} from "./browserEnvironmentIdentity.js";

describe("browserEnvironmentIdentity", () => {
  it("is stable for one verified user and workspace", () => {
    expect(browserEnvironmentIdentity("workspace-a", "user-a")).toEqual(
      browserEnvironmentIdentity("workspace-a", "user-a")
    );
  });

  it("separates users and workspaces without exposing either identifier", () => {
    const first = browserEnvironmentIdentity("workspace-a", "user-a");
    const otherUser = browserEnvironmentIdentity("workspace-a", "user-b");
    const otherWorkspace = browserEnvironmentIdentity("workspace-b", "user-a");
    expect(
      new Set([first.environmentKey, otherUser.environmentKey, otherWorkspace.environmentKey]).size
    ).toBe(3);
    expect(first.environmentKey).not.toContain("user-a");
    expect(first.environmentKey).not.toContain("workspace-a");
  });

  it("rejects absent and system identities", () => {
    expect(() => browserEnvironmentIdentity("workspace-a", undefined)).toThrow(/verified user/);
    expect(() => browserEnvironmentIdentity("workspace-a", "system")).toThrow(/verified user/);
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

  it("uses the runtime's own account when infrastructure authorized the call", () => {
    // A system-owned relay carries the call; the browser environment still
    // belongs to the account whose runtime is making it.
    const identity = browserEnvironmentIdentityFromContext("workspace-a", {
      caller: createVerifiedCaller("do:workers/agent-worker", "do", null, null, {
        userId: "user-a",
        handle: "alice",
      }),
      authorizingCaller: createVerifiedCaller("do:workers/pubsub-channel", "do", null, null, {
        userId: "system",
        handle: "system",
      }),
    });

    expect(identity.ownerUserId).toBe("user-a");
  });
});
