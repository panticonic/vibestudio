import { describe, expect, it } from "vitest";
import { evaluateAuthority, requirementForPrincipals } from "./authorization.js";
import { createVerifiedCaller } from "./serviceDispatcher.js";
import { testAuthority } from "./serviceDispatcherTestUtils.js";

describe("service dispatcher test authority", () => {
  it("keeps under-declared workspace code on the code branch and fails it closed", () => {
    const caller = createVerifiedCaller("panel:settings", "panel", {
      callerId: "panel:settings",
      callerKind: "panel",
      repoPath: "about/settings",
      effectiveVersion: "settings-v1",
      executionDigest: "a".repeat(64),
      requested: [
        {
          capability: "settings.read",
          resource: { kind: "prefix", prefix: "" },
        },
      ],
    });
    const resolved = testAuthority(
      caller,
      "settings.write",
      "service:settings.update"
    );

    expect(resolved.context.authorizingOrigin.kind).toBe("code");
    expect(
      evaluateAuthority({
        context: resolved.context,
        grants: resolved.grants,
        requirement: requirementForPrincipals(["code"], "settings.write"),
        resourceKey: "service:settings.update",
      })
    ).toMatchObject({ allowed: false, code: "fixed-code-not-requested" });
  });
});
