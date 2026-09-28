import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { createTestExecutionSession } from "@vibestudio/shared/serviceDispatcherTestUtils";
import { evaluateAuthority, requirementForPrincipals } from "@vibestudio/shared/authorization";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { authorizeVerifiedCaller } from "./authorityRuntime.js";
import {
  assertExecutionAuthorityMatches,
  executionAuthorityForCaller,
  retainExecutionAuthority,
} from "./executionAuthority.js";

describe("accepted website execution authority", () => {
  it("retains a cloned execution scope and rejects identity reuse across origins", () => {
    const origin = {
      kind: "website" as const,
      website: {
        subject: "website:a" as const,
        userId: "user:a" as const,
        workspaceId: "workspace:a",
        origin: "https://example.com",
        binding: { subject: "website:a" as const, generation: 1 },
      },
    };
    expect(retainExecutionAuthority(undefined, origin)).toEqual(origin);
    expect(() => assertExecutionAuthorityMatches(origin, undefined)).toThrow(
      /different launch subject/
    );
    expect(() => assertExecutionAuthorityMatches(undefined, origin)).toThrow(
      /different launch subject/
    );
    expect(() =>
      assertExecutionAuthorityMatches(origin, {
        ...origin,
        website: { ...origin.website, binding: { ...origin.website.binding, generation: 2 } },
      })
    ).toThrow(/different launch subject/);
    expect(() => assertExecutionAuthorityMatches(origin, origin)).not.toThrow();
    expect(
      executionAuthorityForCaller(createVerifiedCaller("agent:a", "do"), {
        resolveActive: () => ({ executionAuthority: origin }) as never,
      })
    ).toEqual(origin);
  });
  it("survives document disconnect without inheriting document, harness or unrelated task grants", () => {
    const store = new CapabilityGrantStore({
      statePath: mkdtempSync(join(tmpdir(), "execution-origin-")),
    });
    try {
      const subject = store.ensureWebsiteSubject({
        userId: "user:test",
        workspaceId: "test",
        origin: "https://example.com",
      });
      const website = {
        subject: subject.subject,
        userId: subject.userId,
        workspaceId: subject.workspaceId,
        origin: subject.identityKey,
        connected: true,
        binding: {
          subject: subject.subject,
          generation: subject.generation,
          documentId: "document:1",
        },
      };
      const page = {
        ...createVerifiedCaller("page:1", "panel", null, null, { userId: "test", handle: "test" }),
        website,
      };
      const authorityOrigin = executionAuthorityForCaller(page, { resolveActive: () => null })!;
      expect(authorityOrigin.website.binding.documentId).toBeUndefined();
      const session = {
        ...createTestExecutionSession({
          runtimeId: "eval:1",
          agentBinding: null,
          mode: "interactive",
        }),
        authorityOrigin,
      };
      const code = {
        callerId: "eval:1",
        callerKind: "do" as const,
        repoPath: session.executionImage.repoPath,
        effectiveVersion: session.executionImage.effectiveVersion,
        executionDigest: session.executionImage.executionDigest,
        requested: [
          { capability: "filesystem.read", resource: { kind: "prefix" as const, prefix: "" } },
        ],
      };
      const caller = createVerifiedCaller(
        "eval:1",
        "do",
        code,
        null,
        { userId: "test", handle: "test" },
        session
      );
      const facts = {
        workspaceId: "test",
        workspaceMember: true,
        sessionId: "eval-session:1",
        audience: "fs",
        capability: "filesystem.read",
        resourceKey: "private.txt",
        tier: "gated" as const,
        grantStore: store,
      };
      const decide = () =>
        evaluateAuthority({
          ...authorizeVerifiedCaller(caller, facts),
          requirement: requirementForPrincipals(["website", "code"], facts.capability),
          resourceKey: facts.resourceKey,
          tier: "gated",
        });
      for (const principal of [
        "user:test",
        session.executionImage.principal,
        session.taskAuthority!,
      ] as const) {
        store.issue({
          subject: principal,
          effect: "allow",
          capability: facts.capability,
          resource: { kind: "exact", key: facts.resourceKey },
          issuedBy: "user:test",
          provenance: "acquisition",
        });
      }
      expect(decide().allowed).toBe(false);
      store.issue({
        subject: subject.subject,
        effect: "allow",
        capability: facts.capability,
        resource: { kind: "exact", key: facts.resourceKey },
        constraints: {
          sourceWorkspaceId: "test",
          subjectGeneration: subject.generation,
          documentId: "document:1",
        },
        issuedBy: "user:test",
        provenance: "acquisition",
      });
      expect(decide().allowed).toBe(false);
      store.issue({
        subject: subject.subject,
        effect: "allow",
        capability: facts.capability,
        resource: { kind: "exact", key: facts.resourceKey },
        constraints: {
          sourceWorkspaceId: "test",
          subjectGeneration: subject.generation,
          taskAuthority: session.taskAuthority,
        },
        issuedBy: "user:test",
        provenance: "acquisition",
      });
      // No connected document is registered. Accepted work still uses its exact task consent.
      expect(decide().allowed).toBe(true);
      const toolCaller = {
        ...caller,
        executionSession: undefined,
        executionAuthority: authorityOrigin,
        taskAuthority: session.taskAuthority,
      };
      const toolAuthority = authorizeVerifiedCaller(toolCaller, facts);
      expect(toolAuthority.context.authorizingOrigin).toEqual({
        kind: "website",
        principal: subject.subject,
      });
      expect(
        evaluateAuthority({
          ...toolAuthority,
          requirement: requirementForPrincipals(["website", "code"], facts.capability),
          resourceKey: facts.resourceKey,
          tier: "gated",
        }).allowed
      ).toBe(true);
      session.taskAuthority = "task:unrelated";
      expect(decide().allowed).toBe(false);
      store.invalidateAuthoritySubject(subject.subject);
      expect(() => decide()).toThrow(/subject binding/);
    } finally {
      store.close();
    }
  });
});
