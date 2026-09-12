import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { taskAuthorityPrincipal } from "./taskAuthorityRegistry.js";

const stores: CapabilityGrantStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function store(): CapabilityGrantStore {
  const created = new CapabilityGrantStore({
    statePath: mkdtempSync(join(tmpdir(), "capability-grant-scope-")),
  });
  stores.push(created);
  return created;
}

const TASK_SUBJECT = taskAuthorityPrincipal({
  workspaceId: "workspace:one",
  contextId: "context:agent",
  channelId: "channel:task",
});

describe("grant scope inference", () => {
  it("scopes a task principal's grant to the task without a taskRef constraint", () => {
    const grants = store();

    // The shape test-policy consent mints: a task principal, constrained only
    // by lineage. Reading scope from the constraint alone called this "system",
    // the broadest scope there is, and authority.listTaskRules — which selects
    // scope "task" — then reported no rules for a task that plainly had one.
    const issued = grants.issue({
      effect: "allow",
      subject: TASK_SUBJECT,
      capability: "permissions.read",
      resource: { kind: "exact", key: "permissions.read" },
      constraints: { lineageAtConsent: ["none"] },
      issuedBy: "user:usr_alice",
      provenance: "acquisition",
    });

    expect(issued.scope).toBe("task");
    expect(grants.listActiveAuthorityGrants().map((grant) => grant.scope)).toEqual(["task"]);
  });

  it("keeps a one-shot invocation grant to that same principal once-scoped", () => {
    const grants = store();

    const issued = grants.issue({
      effect: "allow",
      subject: TASK_SUBJECT,
      capability: "permissions.read",
      resource: { kind: "exact", key: "permissions.read" },
      constraints: { lineageAtConsent: ["none"], invocationDigest: "a".repeat(64) },
      issuedBy: "user:usr_alice",
      provenance: "acquisition",
    });

    expect(issued.scope).toBe("once");
  });

  it("leaves an unbound subject's grant at the broad scope it really has", () => {
    const grants = store();

    const issued = grants.issue({
      effect: "allow",
      subject: "user:usr_alice",
      capability: "permissions.read",
      resource: { kind: "exact", key: "permissions.read" },
      constraints: { lineageAtConsent: [] },
      issuedBy: "user:usr_alice",
      provenance: "acquisition",
    });

    expect(issued.scope).toBe("system");
  });
});
