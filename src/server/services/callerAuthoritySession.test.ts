import { describe, expect, it } from "vitest";
import { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import type { EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { createTestExecutionSession } from "@vibestudio/shared/serviceDispatcherTestUtils";
import { authoritySessionIdForCaller } from "./callerAuthoritySession.js";

const owner = "do:workers/test:Agent:one";
const record: EntityRecord = {
  id: owner,
  kind: "do",
  source: { repoPath: "workers/test", effectiveVersion: "one" },
  contextId: "ctx-one",
  className: "Agent",
  key: "one",
  createdAt: 1,
  status: "active",
  cleanupComplete: true,
  authoritySessionId: "lifetime-one",
};

describe("authoritySessionIdForCaller", () => {
  it("uses the verified finite execution admission ahead of the durable entity lifetime", () => {
    const cache = new EntityCache();
    cache._onActivate(record);
    const session = createTestExecutionSession({ runtimeId: owner });
    const caller = createVerifiedCaller(owner, "do", null, null, null, session);
    expect(authoritySessionIdForCaller(caller, cache)).toBe(session.authoritySessionId);
  });

  it("uses current canonical lifetime through image replacement and changes only on reattach", () => {
    const cache = new EntityCache();
    const caller = createVerifiedCaller(owner, "do");
    cache._onActivate(record);
    expect(authoritySessionIdForCaller(caller, cache)).toBe("lifetime-one");
    cache._onActivate({ ...record, source: { ...record.source, effectiveVersion: "two" } });
    expect(authoritySessionIdForCaller(caller, cache)).toBe("lifetime-one");
    cache._onRetire({ ...record, status: "retired", cleanupComplete: false });
    expect(() => authoritySessionIdForCaller(caller, cache)).toThrow(
      "no active authority lifetime"
    );
    cache._onActivate({ ...record, authoritySessionId: "lifetime-two" });
    expect(authoritySessionIdForCaller(caller, cache)).toBe("lifetime-two");
  });

  it.each(["absent", "preparing", "missing-lifetime", "wrong-kind"])(
    "refuses an ordinary DO with %s canonical evidence rather than guessing a session",
    (condition) => {
      const cache = new EntityCache();
      if (condition !== "absent")
        cache._onActivate({
          ...record,
          ...(condition === "preparing" ? { status: "preparing" as const } : {}),
          ...(condition === "missing-lifetime" ? { authoritySessionId: undefined } : {}),
          ...(condition === "wrong-kind" ? { kind: "panel" as const } : {}),
        });
      expect(() => authoritySessionIdForCaller(createVerifiedCaller(owner, "do"), cache)).toThrow(
        "no active authority lifetime"
      );
    }
  );

  it("keeps existing cache-only transport ownership and uses a durable lifetime when present", () => {
    const cache = new EntityCache();
    const caller = createVerifiedCaller("panel:one", "panel");
    expect(authoritySessionIdForCaller(caller, cache)).toBe("panel:one");
    cache._onActivate({ ...record, id: "panel:one", kind: "panel" });
    expect(authoritySessionIdForCaller(caller, cache)).toBe("lifetime-one");
  });
});
