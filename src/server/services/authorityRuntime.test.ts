import { describe, expect, it } from "vitest";
import { evaluateAuthority, requirementForPrincipals } from "@vibestudio/shared/authorization";
import { createHostCaller, createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import {
  authorizeVerifiedCaller,
  attestDirectRpc,
  directAuthorityCapability,
} from "./authorityRuntime.js";

const digest = "a".repeat(64);

describe("authority runtime", () => {
  it("binds code authority to the exact execution and target", () => {
    const attestation = attestDirectRpc({
      caller: createVerifiedCaller(
        "do:workers/example:ExampleDO:key",
        "do",
        {
          callerId: "do:workers/example:ExampleDO:key",
          callerKind: "do",
          repoPath: "product/eval",
          executionDigest: digest,
          requested: [{ capability: "rpc:chatOp", resource: { kind: "prefix", prefix: "" } }],
        },
        null,
        { userId: "u1", handle: "u1" }
      ),
      source: "workers/target",
      className: "TargetDO",
      objectKey: "object-1",
      method: "chatOp",
      workspaceId: "ws-1",
      workspaceMember: true,
      sessionId: "s-1",
      now: 100,
    });
    const capability = directAuthorityCapability("chatOp");
    expect(attestation.context.code).toBe(`code:product/eval@${digest}`);
    expect(
      evaluateAuthority({
        context: attestation.context,
        requirement: requirementForPrincipals(["code"], capability),
        resourceKey: attestation.resourceKey,
        grants: attestation.grants,
        now: 101,
      }).allowed
    ).toBe(true);
    expect(
      evaluateAuthority({
        context: attestation.context,
        requirement: requirementForPrincipals(["code"], `${capability}.other`),
        resourceKey: attestation.resourceKey,
        grants: attestation.grants,
        now: 101,
      }).allowed
    ).toBe(false);
  });

  it("does not lend the host principal to a relayed user request", () => {
    const attestation = attestDirectRpc({
      caller: createVerifiedCaller("panel:one", "panel", null, null, {
        userId: "u1",
        handle: "u1",
      }),
      source: "workers/target",
      className: "TargetDO",
      objectKey: "object-1",
      method: "read",
      workspaceId: "ws-1",
      workspaceMember: true,
      sessionId: "s-1",
      now: 100,
    });
    expect(attestation.context.host).toBeNull();
    expect(attestation.context.actingUser).toBe("user:u1");
  });

  it("never derives the host principal from a server runtime label", () => {
    const input = {
      source: "workers/target",
      className: "TargetDO",
      objectKey: "object-1",
      method: "read",
      workspaceId: "ws-1",
      workspaceMember: true,
      sessionId: "s-1",
      now: 100,
    } as const;
    expect(
      attestDirectRpc({ caller: createVerifiedCaller("main", "server"), ...input }).context.host
    ).toBeNull();
    expect(attestDirectRpc({ caller: createHostCaller("main"), ...input }).context.host).toMatch(
      /^host:[0-9a-f]{64}$/
    );
  });

  it("does not grant a newly invented direct method", () => {
    const method = "futureMethodThatWasNeverReviewed";
    const attestation = attestDirectRpc({
      caller: createVerifiedCaller("worker:example", "worker", {
        callerId: "worker:example",
        callerKind: "worker",
        repoPath: "product/eval",
        executionDigest: digest,
        requested: [{ capability: `rpc:${method}`, resource: { kind: "prefix", prefix: "" } }],
      }),
      source: "workers/target",
      className: "TargetDO",
      objectKey: "object-1",
      method,
      workspaceId: "ws-1",
      workspaceMember: true,
      sessionId: "s-1",
      now: 100,
    });
    expect(
      evaluateAuthority({
        context: attestation.context,
        requirement: requirementForPrincipals(["code"], directAuthorityCapability(method)),
        resourceKey: attestation.resourceKey,
        grants: attestation.grants,
        now: 101,
      })
    ).toMatchObject({ allowed: false, code: "missing-grant" });
  });

  it("keeps exact code identity while withholding a live provider grant", () => {
    const attestation = attestDirectRpc({
      caller: createVerifiedCaller("@workspace-extensions/other", "extension", {
        callerId: "@workspace-extensions/other",
        callerKind: "extension",
        repoPath: "product/eval",
        executionDigest: digest,
        requested: [{ capability: "rpc:getCookies", resource: { kind: "prefix", prefix: "" } }],
      }),
      source: "product/browser-data",
      className: "BrowserDataDO",
      objectKey: "global",
      method: "getCookies",
      workspaceId: "ws-1",
      workspaceMember: true,
      sessionId: "s-1",
      grantCode: false,
      now: 100,
    });
    const capability = directAuthorityCapability("getCookies");
    expect(attestation.context.code).toBe(`code:product/eval@${digest}`);
    expect(
      evaluateAuthority({
        context: attestation.context,
        requirement: requirementForPrincipals(["code"], capability),
        resourceKey: attestation.resourceKey,
        grants: attestation.grants,
        now: 101,
      })
    ).toMatchObject({ allowed: false, code: "missing-grant" });
  });

  it("does not let code borrow its acting user's grant", () => {
    const capability = "service:app.getInfo";
    const resourceKey = capability;
    const resolved = authorizeVerifiedCaller(
      createVerifiedCaller(
        "app:unreviewed",
        "app",
        {
          callerId: "app:unreviewed",
          callerKind: "app",
          repoPath: "apps/unreviewed",
          executionDigest: digest,
          requested: [{ capability, resource: { kind: "exact", key: resourceKey } }],
        },
        null,
        { userId: "u1", handle: "u1" }
      ),
      {
        workspaceId: "ws-1",
        workspaceMember: true,
        sessionId: "s-confused-deputy",
        audience: "service:app",
        capability,
        resourceKey,
        now: 100,
      }
    );
    expect(resolved.context.actingUser).toBe("user:u1");
    expect(
      evaluateAuthority({
        context: resolved.context,
        requirement: requirementForPrincipals(["user", "code"], capability),
        resourceKey,
        grants: resolved.grants,
        now: 101,
      })
    ).toMatchObject({ allowed: false, code: "missing-grant" });
  });
});
