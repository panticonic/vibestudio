import { describe, expect, it } from "vitest";
import { EventService } from "@vibestudio/shared/eventsService";
import {
  approvalVisibleToUser,
  pendingApprovalCounts,
} from "@vibestudio/shared/approvalVisibility";
import type { PendingApproval } from "@vibestudio/shared/approvals";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { createApprovalQueue } from "./approvalQueue.js";
import { createShellApprovalService } from "./shellApprovalService.js";

const access = {
  isMember: (id: string) => ["alice", "bob"].includes(id),
  isAdmin: (id: string) => id === "bob",
};
const context = (userId: string) => ({
  caller: {
    ...createVerifiedCaller(`shell:${userId}`, "shell"),
    subject: { userId, handle: userId },
  },
});

describe("approval audience", () => {
  it("rejects private approvals with no eligible member before they enter the queue", () => {
    const events = new EventService();
    const queue = createApprovalQueue({ eventService: events, workspaceAccess: access });
    const capabilityAttempt = (requestedByUserId?: string) => () =>
      queue.request({
        kind: "capability",
        callerId: "system-owned-agent",
        callerKind: "do",
        repoPath: "agents/system-owned",
        effectiveVersion: "v1",
        capability: "credentials.use",
        title: "Use credential",
        ...(requestedByUserId ? { requestedByUserId } : {}),
      });
    const attempts = [
      capabilityAttempt(),
      capabilityAttempt("system"),
      capabilityAttempt("not-a-member"),
      () =>
        queue.requestCredentialInput({
          kind: "credential-input",
          callerId: "system-owned-agent",
          callerKind: "do",
          repoPath: "agents/system-owned",
          effectiveVersion: "v1",
          title: "Add credential",
          credentialLabel: "Provider",
          audience: [{ url: "https://api.example.test/", match: "origin" }],
          injection: { type: "header", name: "authorization", valueTemplate: "Bearer {token}" },
          accountIdentity: { providerUserId: "provider" },
          scopes: [],
          fields: [{ name: "token", label: "Token", type: "secret", required: true }],
          requestedByUserId: "system",
        }),
    ];

    for (const attempt of attempts) {
      let failure: unknown;
      try {
        void attempt();
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        code: "EACCES",
        errorKind: "access",
        errorData: {
          authorityFailure: {
            reasonCode: "receiver-rejected",
            remediation: { kind: "use-admitted-principal" },
          },
        },
      });
      expect(queue.listPending()).toEqual([]);
      expect(pendingApprovalCounts(queue.listPending())).toEqual({
        pendingApprovals: [],
        workspaceApprovalCount: 0,
      });
    }
  });

  it("counts ready workspace creation reviews while leaving native bootstrap decisions to their owner", async () => {
    const queue = createApprovalQueue({
      eventService: new EventService(),
      workspaceAccess: access,
    });
    const pending = (["panel", "app"] as const).map((kind) =>
      queue.requestWithHandle({
        kind: "unit-install-review",
        callerId: `system:${kind}`,
        callerKind: "system",
        repoPath: "meta",
        effectiveVersion: "",
        mode: "adopt-root",
        title: "Review workspace source",
        description: "Review the initial declared source",
        units: [
          {
            unitKind: kind,
            unitName: kind === "panel" ? "@workspace-panels/notes" : "@workspace-apps/shell",
            displayName: kind === "panel" ? "Notes" : "Shell",
            source: { kind: "workspace-repo", repo: `${kind}s/example`, ref: "main" },
            ev: "version",
            capabilities: [],
            ...(kind === "app" ? { target: "electron" as const } : {}),
          },
        ],
      })
    );
    try {
      expect(queue.listPending()).toHaveLength(2);
      expect(pendingApprovalCounts(queue.listPending())).toEqual({
        pendingApprovals: [],
        workspaceApprovalCount: 1,
      });
      const creation = queue.listPending().find((entry) => entry.callerId === "system:panel")!;
      expect(approvalVisibleToUser(creation, "bob", access)).toBe(true);
      expect(approvalVisibleToUser(creation, "alice", access)).toBe(false);
      await queue.resolveInstallReview(creation.approvalId, { decision: "cancel" });
      expect(pendingApprovalCounts(queue.listPending()).workspaceApprovalCount).toBe(0);
    } finally {
      for (const entry of queue.listPending())
        await queue.resolveInstallReview(entry.approvalId, { decision: "cancel" });
      await Promise.all(pending.map((entry) => entry.decision));
    }
  });

  it("keeps two users' same-caller grants separate and refuses another member's decision", async () => {
    const events = new EventService();
    const queue = createApprovalQueue({ eventService: events, workspaceAccess: access });
    const service = createShellApprovalService({ approvalQueue: queue, workspaceAccess: access });
    const request = {
      callerId: "shared-worker",
      callerKind: "worker" as const,
      repoPath: "workers/shared",
      effectiveVersion: "v1",
      credentialId: "credential",
      credentialLabel: "Private credential",
      allowedDecisions: ["once", "deny"] as Array<"once" | "deny">,
      audience: [{ url: "https://example.test/", match: "origin" as const }],
      injection: {
        type: "header" as const,
        name: "authorization",
        valueTemplate: "Bearer {token}",
      },
      accountIdentity: { providerUserId: "private-user" },
      scopes: [],
    };
    const alice = queue.request({ ...request, requestedByUserId: "alice" });
    const bob = queue.request({ ...request, requestedByUserId: "bob" });
    try {
      expect(queue.listPending()).toHaveLength(2);
      const alicePending = (await service.handler(
        context("alice"),
        "listPending",
        []
      )) as PendingApproval[];
      const bobPending = (await service.handler(
        context("bob"),
        "listPending",
        []
      )) as PendingApproval[];
      expect(alicePending).toHaveLength(1);
      expect(bobPending).toHaveLength(1);
      expect(alicePending[0]!.approvalId).not.toBe(bobPending[0]!.approvalId);
      await expect(
        service.handler(context("bob"), "resolve", [alicePending[0]!.approvalId, "once"])
      ).rejects.toThrow("No pending approval");
      await expect(
        queue.resolve(alicePending[0]!.approvalId, "once", {
          subject: { userId: "bob", handle: "bob" },
          via: "shell",
        })
      ).rejects.toThrow("not available to this account");
      expect(pendingApprovalCounts(queue.listPending())).toEqual({
        pendingApprovals: [
          { userId: "alice", count: 1 },
          { userId: "bob", count: 1 },
        ],
        workspaceApprovalCount: 0,
      });
      await service.handler(context("alice"), "resolve", [alicePending[0]!.approvalId, "once"]);
      await expect(alice).resolves.toBe("once");
      expect(queue.listPending()).toHaveLength(1);
    } finally {
      queue.cancelForCaller("shared-worker");
      await Promise.all([alice, bob]);
    }
  });

  it("classifies owned consent, workspace admission and non-actionable preparation once", () => {
    const base = {
      approvalId: "approval",
      callerId: "caller",
      callerKind: "worker",
      repoPath: "workers/shared",
      effectiveVersion: "v1",
      requestedAt: 1,
    };
    const privateApproval = {
      ...base,
      kind: "capability",
      requestedByUserId: "alice",
    } as PendingApproval;
    const unownedCredential = { ...base, kind: "credential" } as PendingApproval;
    const admission = {
      ...base,
      kind: "unit-install-review",
      mode: "install",
      parts: [],
    } as unknown as PendingApproval;
    const conflicting = {
      ...base,
      kind: "browser-permission",
      ownerUserId: "alice",
      requestedByUserId: "bob",
    } as PendingApproval;
    expect(approvalVisibleToUser(privateApproval, "bob", access)).toBe(false);
    expect(approvalVisibleToUser(unownedCredential, "bob", access)).toBe(false);
    expect(approvalVisibleToUser(admission, "alice", access)).toBe(false);
    expect(approvalVisibleToUser(admission, "bob", access)).toBe(true);
    expect(approvalVisibleToUser(conflicting, "alice", access)).toBe(false);
    expect(approvalVisibleToUser(conflicting, "bob", access)).toBe(false);
    expect(
      approvalVisibleToUser(privateApproval, "alice", { ...access, isMember: () => false })
    ).toBe(false);
    expect(
      pendingApprovalCounts([
        privateApproval,
        admission,
        unownedCredential,
        conflicting,
        { ...privateApproval, lifecycle: { state: "preparing" } },
      ])
    ).toEqual({
      pendingApprovals: [{ userId: "alice", count: 1 }],
      workspaceApprovalCount: 1,
    });
  });

  it("projects pending and resolved watch events for their authenticated owner", async () => {
    const events = new EventService();
    const queue = createApprovalQueue({ eventService: events, workspaceAccess: access });
    const open = (userId: string) =>
      events
        .openWatch({
          callerId: `shell:${userId}`,
          callerKind: "shell",
          userId,
          connectionId: userId,
          watchId: userId,
          events: ["shell-approval:pending-changed", "shell-approval:resolved"],
        })
        .body!.getReader();
    const alice = open("alice");
    const bob = open("bob");
    const read = async (reader: typeof alice) =>
      JSON.parse(new TextDecoder().decode((await reader.read()).value));
    await read(alice);
    await read(bob);
    const decision = queue.request({
      kind: "capability",
      callerId: "private-worker",
      callerKind: "worker",
      repoPath: "workers/private",
      effectiveVersion: "v1",
      capability: "external.open",
      title: "Private URL",
      requestedByUserId: "alice",
    });
    try {
      expect((await read(alice)).payload.pending).toHaveLength(1);
      expect((await read(bob)).payload.pending).toEqual([]);
      const id = queue.listPending()[0]!.approvalId;
      await queue.resolve(id, "once", {
        subject: { userId: "alice", handle: "alice" },
        via: "shell",
      });
      expect((await read(alice)).event).toBe("shell-approval:resolved");
      expect((await read(alice)).payload.pending).toEqual([]);
      const bobUpdate = await read(bob);
      expect(bobUpdate.event).toBe("shell-approval:pending-changed");
      expect(bobUpdate.payload.pending).toEqual([]);
      await expect(decision).resolves.toBe("once");
    } finally {
      queue.cancelForCaller("private-worker");
      await Promise.all([alice.cancel(), bob.cancel(), decision]);
    }
  });
});
