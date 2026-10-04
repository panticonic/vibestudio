import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import {
  createInvocationSnapshot,
  invocationSnapshotDigest,
} from "@vibestudio/shared/authority/invocationSnapshot";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { AcquisitionCoordinator } from "./acquisitionCoordinator.js";

const roots: string[] = [];
const owners = new Set<CapabilityGrantStore>();
afterEach(() => {
  vi.restoreAllMocks();
  for (const owner of owners) owner.close();
  owners.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root() {
  const path = mkdtempSync(join(tmpdir(), "target-authority-commit-"));
  roots.push(path);
  return path;
}
function open(path: string) {
  const grants = new CapabilityGrantStore({ statePath: path });
  owners.add(grants);
  return grants;
}
function close(grants: CapabilityGrantStore) {
  grants.close();
  owners.delete(grants);
}
const request = {
  targetSubject: "task:one" as const,
  authorityPlanDigest: "plan:one",
  operationKey: "gateway.fetch:example",
  capability: "workspace.gateway.access",
  capabilityDefinitionDigest: "definition:one",
  resource: { kind: "origin" as const, origin: "https://example.com" },
  tier: "gated" as const,
  sourceUser: "user:alice" as const,
  review: {
    action: "read example.com",
    domain: "web" as const,
    verb: "see" as const,
    declaredBy: "host:gateway.fetch",
  },
};
function issue(grants: CapabilityGrantStore) {
  return grants.issue({
    subject: request.targetSubject,
    effect: "allow",
    capability: request.capability,
    resource: request.resource,
    scope: "task",
    issuedBy: request.sourceUser,
    provenance: "acquisition",
    capabilityDefinitionDigest: request.capabilityDefinitionDigest,
  }).id!;
}

describe("standing authority shares grant ownership", () => {
  it("rolls back a grant when its exact target decision fails and retries once", () => {
    const path = root();
    let grants = open(path);
    const pending = grants.targetRequests.ensure(request);
    const sql = new DatabaseSync(grants.databasePath);
    try {
      sql.exec(
        "CREATE TRIGGER reject_target BEFORE UPDATE ON target_authority_requests BEGIN SELECT RAISE(ABORT,'rejected target outcome'); END"
      );
      expect(() =>
        grants.targetRequests.settle(pending.requestId, "granted", () => issue(grants))
      ).toThrow("rejected target outcome");
      expect(grants.listAuthorityGrants()).toEqual([]);
      expect(grants.targetRequests.get(pending.requestId)).toEqual(pending);
      sql.exec("DROP TRIGGER reject_target");
    } finally {
      sql.close();
    }
    const settled = grants.targetRequests.settle(pending.requestId, "granted", () => issue(grants));
    const unexpected = vi.fn(() => issue(grants));
    expect(grants.targetRequests.settle(pending.requestId, "denied", unexpected)).toEqual(settled);
    expect(unexpected).not.toHaveBeenCalled();
    close(grants);
    grants = open(path);
    expect(grants.targetRequests.get(pending.requestId)).toEqual(settled);
    expect(grants.listAuthorityGrants().map((g) => g.id)).toEqual([settled.grantId]);
  });

  it("rolls back every request and grant in a multi-row human rules decision", async () => {
    const grants = open(root());
    const failed = new Error("second grant refused");
    const original = grants.issue.bind(grants);
    vi.spyOn(grants, "issue")
      .mockImplementationOnce(original)
      .mockImplementationOnce(() => {
        throw failed;
      });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const coordinator = new AcquisitionCoordinator({
      grantStore: grants,
      approvalQueue: {
        requestWithHandle: (input: { authorityFacets: { selectionKey: string }[] }) => ({
          approvalId: "rules",
          decision: Promise.resolve("task"),
          resolution: Promise.resolve({
            decision: "task",
            selectedAuthorityFacetKeys: input.authorityFacets.map((f) => f.selectionKey),
          }),
        }),
      } as never,
    });
    const asks = coordinator.requestTaskRulesForTarget([
      { ...request, renderedAction: request.review.action },
      {
        ...request,
        operationKey: "other",
        resource: { kind: "origin", origin: "https://other.example" },
        renderedAction: request.review.action,
      },
    ]);
    const snapshot = createInvocationSnapshot({
      service: "gateway",
      method: "fetch",
      capability: request.capability,
      capabilityDefinitionDigest: request.capabilityDefinitionDigest,
      resourceType: "network",
      resourceKey: request.resource.origin,
      provider: "-",
      providerExecutionDigest: "-",
      preparedStateDigest: "-",
      args: [request.resource.origin],
      callerPrincipal: "session:joined",
      sessionId: "joined",
      taskAuthority: request.targetSubject,
      missionSubject: "-",
      snippetDigest: "a".repeat(64),
      codeLineage: { class: "internal", chain: [] },
      initiatorChain: [request.sourceUser],
    });
    const waiter = coordinator.requestAndWait({
      snapshot,
      snapshotDigest: invocationSnapshotDigest(snapshot),
      tier: "gated",
      caller: createVerifiedCaller("do:workers/test:Agent:joined", "do"),
      resource: request.resource,
      renderedAction: request.review.action,
    });
    await expect(waiter).rejects.toBe(failed);
    await vi.waitFor(() =>
      expect(logged).toHaveBeenCalledWith(
        "[AuthorityAcquisition] task rules presentation failed:",
        failed
      )
    );
    expect(grants.listAuthorityGrants()).toEqual([]);
    expect(asks.map((ask) => grants.targetRequests.get(ask.requestId)?.state)).toEqual([
      "pending",
      "pending",
    ]);
  });

  it("does not associate a rejected replay with a new plan", () => {
    const grants = open(root());
    const pending = grants.targetRequests.ensure(request);
    expect(() =>
      grants.targetRequests.ensure({
        ...request,
        authorityPlanDigest: "foreign-plan",
        review: { ...request.review, action: "changed action" },
      })
    ).toThrow("different facts");
    expect(grants.targetRequests.forPlan(request.targetSubject, "foreign-plan")).toEqual([]);
    expect(grants.targetRequests.pending()).toEqual([pending]);
  });

  it("refuses new requests and grant issuance after persisted target retirement", () => {
    const path = root();
    let grants = open(path);
    grants.targetRequests.registerSubject(
      request.targetSubject,
      request.authorityPlanDigest,
      request.sourceUser,
      "do:controller"
    );
    const pending = grants.targetRequests.ensure(request);
    grants.targetRequests.retireSubject(request.targetSubject);
    close(grants);
    grants = open(path);
    expect(() => grants.targetRequests.ensure({ ...request, operationKey: "new" })).toThrow(
      "retired"
    );
    const write = vi.fn(() => issue(grants));
    expect(grants.targetRequests.settle(pending.requestId, "granted", write).state).toBe(
      "cancelled"
    );
    expect(write).not.toHaveBeenCalled();
    expect(grants.listAuthorityGrants()).toEqual([]);
  });

  it("preserves grants and invocation receipts through current-schema reopen", () => {
    const path = root();
    let grants = open(path);
    const grantId = issue(grants);
    const acquisition = grants.acquisitions.admit({
      requestKey: "ordinary",
      ownerRuntimeId: "do:owner",
      sessionId: "session",
      facts: { value: "original" },
    });
    close(grants);
    grants = open(path);
    expect(grants.listAuthorityGrants().map((g) => g.id)).toEqual([grantId]);
    expect(
      grants.acquisitions.get(acquisition.acquisitionId, {
        ownerRuntimeId: "do:owner",
        sessionId: "session",
      })
    ).toEqual(acquisition);
    expect(grants.targetRequests.ensure(request).state).toBe("pending");
  });
});
