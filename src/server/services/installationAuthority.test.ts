import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { evaluateAuthority, requirementForPrincipals } from "@vibestudio/shared/authorization";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { authorizeVerifiedCaller } from "./authorityRuntime.js";

const capability = "model.use";
const resource = { kind: "exact" as const, key: "account:1" };
const userId = "user:alice" as const;
const workspaceId = "ws-1";
const runtimeId = "worker:example";
function caller(version = "v1", requested = true, owner = "alice") {
  return {
    ...createVerifiedCaller(
      runtimeId,
      "worker",
      {
        callerId: runtimeId,
        callerKind: "worker",
        repoPath: "workers/example",
        effectiveVersion: version,
        executionDigest: "b".repeat(64),
        requested: requested ? [{ capability, resource }] : [],
      },
      null,
      { userId: owner, handle: owner }
    ),
    workspaceId,
  };
}

describe("host-attested installation continuity", () => {
  it("preserves revision grants across restart without widening them, then applies explicit continuing consent", () => {
    const statePath = mkdtempSync(join(tmpdir(), "installation-authority-"));
    let store = new CapabilityGrantStore({ statePath });
    const installation = store.createInstallationSubject({ userId, workspaceId });
    const register = (version: string) =>
      store.registerInstallationExecution({
        subject: installation.subject,
        generation: installation.generation,
        executionId: `execution-${version}`,
        runtimeId,
        codePrincipal: `code:workers/example@${version}`,
        userId,
        workspaceId,
        isCurrent: () => true,
      });
    const facts = () => ({
      workspaceId,
      workspaceMember: true,
      sessionId: "s1",
      audience: "model",
      capability,
      resourceKey: resource.key,
      tier: "gated" as const,
      grantStore: store,
    });
    const check = (version = "v1", requested = true, owner = "alice") =>
      evaluateAuthority({
        ...authorizeVerifiedCaller(caller(version, requested, owner), facts()),
        requirement: requirementForPrincipals(["code"], capability),
        resourceKey: resource.key,
        tier: "gated",
      }).allowed;
    const grant = {
      subject: installation.subject,
      capability,
      resource,
      effect: "allow" as const,
      issuedBy: userId,
      provenance: "acquisition" as const,
      scope: "system" as const,
      constraints: {
        subjectGeneration: 0,
        sourceWorkspaceId: workspaceId,
        lineageAtConsent: [],
      },
    };
    try {
      expect(check()).toBe(false);
      expect(() => store.issue({ ...grant, scope: undefined })).toThrow(/explicit scope/);
      expect(() =>
        store.issue({
          ...grant,
          constraints: {
            ...grant.constraints,
            requestingCodePrincipal: "code:missing-revision",
          },
        })
      ).toThrow(/exact code principal/);
      const retire = register("v1");
      expect(() => store.issue({ ...grant, scope: "version" })).toThrow(/requesting revision/);
      const reviewed = store.issue({
        ...grant,
        scope: "version",
        constraints: {
          ...grant.constraints,
          requestingCodePrincipal: "code:workers/example@v1",
        },
      });
      expect(check()).toBe(true);
      expect(check("v1", false)).toBe(false); // continuity does not widen the live manifest
      expect(check("v1", true, "bob")).toBe(false);
      expect(check("v2")).toBe(false); // registration is pinned to the current exact code
      retire();
      expect(check()).toBe(false);
      store.close();
      store = new CapabilityGrantStore({ statePath });
      expect(store.getAuthoritySubject(installation.subject)).toEqual(installation);
      expect(check()).toBe(false); // persisted identity is not evidence of a live execution
      const retireV2 = register("v2");
      expect(check("v2")).toBe(false); // saved per-version consent remains per-version
      expect(store.grantsForSubjects([installation.subject], capability)[0]?.id).toBe(reviewed.id);
      store.issue(grant); // explicit consent to future revisions, independent of receiver constraints
      expect(check("v2")).toBe(true);
      const binding = store.installationForCaller({
        runtimeId,
        codePrincipal: "code:workers/example@v2",
        userId,
        workspaceId,
      })!.binding;
      const signal = store.subjectExecutionSignal(binding);
      store.invalidateAuthoritySubject(installation.subject);
      expect(signal.aborted).toBe(true);
      expect(check("v2")).toBe(false);
      expect(() => store.issue(grant)).toThrow(/current subject/);
      retireV2();
      const replacement = store.createInstallationSubject({ userId, workspaceId });
      expect(replacement.subject).not.toBe(installation.subject);
      store.registerInstallationExecution({
        subject: replacement.subject,
        generation: 0,
        executionId: "replacement",
        runtimeId,
        codePrincipal: "code:workers/example@v2",
        userId,
        workspaceId,
        isCurrent: () => true,
      });
      expect(check("v2")).toBe(false); // same path/version cannot inherit another installation
    } finally {
      store.close();
    }
  });

  it("requires explicit host evidence and retires outdated execution bindings", () => {
    const store = new CapabilityGrantStore({
      statePath: mkdtempSync(join(tmpdir(), "installation-evidence-")),
    });
    try {
      const subject = store.createInstallationSubject({ userId, workspaceId });
      expect(() =>
        store.registerSubjectExecution({
          subject: subject.subject,
          generation: 0,
          documentId: "bypass",
        })
      ).toThrow(/registerInstallationExecution/);
      let current = true;
      const input = {
        subject: subject.subject,
        generation: 0,
        executionId: "e1",
        runtimeId,
        codePrincipal: "code:workers/example@v1" as const,
        userId,
        workspaceId,
        isCurrent: () => current,
      };
      for (const mismatch of [
        { userId: "user:bob" as const },
        { workspaceId: "ws-2" },
        { generation: 1 },
      ])
        expect(() => store.registerInstallationExecution({ ...input, ...mismatch })).toThrow();
      expect(() =>
        store.registerInstallationExecution({ ...input, codePrincipal: "code:missing-revision" })
      ).toThrow(/evidence/);
      const retire = store.registerInstallationExecution(input);
      expect(() => store.registerInstallationExecution({ ...input, executionId: "e2" })).toThrow(
        /retire/
      );
      current = false;
      expect(store.installationForCaller(input)).toBeUndefined();
      retire();
      current = true;
      store.registerInstallationExecution({ ...input, executionId: "e2" });
      expect(store.installationForCaller(input)?.binding.documentId).toBe("e2");
    } finally {
      store.close();
    }
  });
});
