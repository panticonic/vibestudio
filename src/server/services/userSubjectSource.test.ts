import { describe, expect, it } from "vitest";
import { createUserSubjectSource, isSystemOwnedRuntime } from "./userSubjectSource.js";

describe("isSystemOwnedRuntime", () => {
  it("recognizes only system-owned DO and worker entity records", () => {
    const entityCache = {
      resolveActive: (callerId: string) =>
        callerId === "do:workers/model-settings:ModelSettingsDO:workspace-model-settings"
          ? ({ ownerUserId: "system" } as never)
          : null,
    };

    expect(
      isSystemOwnedRuntime(
        entityCache,
        "do:workers/model-settings:ModelSettingsDO:workspace-model-settings",
        "do"
      )
    ).toBe(true);
    expect(
      isSystemOwnedRuntime(
        entityCache,
        "do:workers/model-settings:ModelSettingsDO:workspace-model-settings",
        "panel"
      )
    ).toBe(false);
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
        callerId === "do:workers/gad-store:GadStore:workspace" && callerKind === "do",
    });

    expect(source.resolve("do:workers/gad-store:GadStore:workspace", "do")).toEqual({
      userId: "system",
      handle: "system",
    });
    expect(source.resolve("do:workers/gad-store:GadStore:other", "do")).toBeNull();
  });
});
