import { describe, expect, it } from "vitest";
import { createUserSubjectSource, isSystemOwnedRuntime } from "./userSubjectSource.js";

describe("isSystemOwnedRuntime", () => {
  it("recognizes every system-owned executable runtime entity", () => {
    const entityCache = {
      resolveActive: (callerId: string) =>
        callerId.startsWith("system-owned:") ? ({ ownerUserId: "system" } as never) : null,
    };

    for (const callerKind of ["panel", "do", "worker"] as const) {
      expect(isSystemOwnedRuntime(entityCache, `system-owned:${callerKind}`, callerKind)).toBe(
        true
      );
    }
    expect(isSystemOwnedRuntime(entityCache, "system-owned:shell", "shell")).toBe(false);
    expect(isSystemOwnedRuntime(entityCache, "human-owned:panel", "panel")).toBe(false);
  });
});

describe("createUserSubjectSource", () => {
  it("denies a shell whose device owner was revoked after authentication", () => {
    const source = createUserSubjectSource({
      deviceAuthStore: { userFor: () => "usr_revoked" },
      userStore: {
        getUser: () => ({
          id: "usr_revoked",
          handle: "revoked",
          displayName: "Revoked",
          role: "member",
          createdAt: 1,
          revokedAt: 2,
        }),
        listUsers: () => [],
      },
      entityCache: { resolveActive: () => null },
    });

    expect(source.resolve(`shell:dev_${"d".repeat(24)}`, "shell")).toBeNull();
  });

  it("does not fabricate a human account for extension code", () => {
    const source = createUserSubjectSource({
      deviceAuthStore: { userFor: () => null },
      userStore: { getUser: () => null, listUsers: () => [] },
      entityCache: { resolveActive: () => null },
    });

    expect(source.resolve("@workspace-extensions/example", "extension")).toBeNull();
  });

  it("attributes only an explicitly declared system runtime to the synthetic system subject", () => {
    const source = createUserSubjectSource({
      deviceAuthStore: { userFor: () => null },
      userStore: { getUser: () => null, listUsers: () => [] },
      entityCache: { resolveActive: () => null },
      isSystemRuntime: (callerId, callerKind) =>
        callerId === "do:workers/workspace-source:GadWorkspaceDO:workspace" && callerKind === "do",
    });

    expect(source.resolve("do:workers/workspace-source:GadWorkspaceDO:workspace", "do")).toEqual({
      userId: "system",
      handle: "system",
    });
    expect(source.resolve("do:workers/workspace-source:GadWorkspaceDO:other", "do")).toBeNull();
  });
});
