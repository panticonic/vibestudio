import assert from "node:assert/strict";
import { test } from "node:test";
import {
  browserImportApprovalIdentity,
  browserImportApprovalRejection,
  nativeRpc,
  waitForApprovalSettlement,
} from "./desktop-shared-revocation.mjs";

function rpcPage(responseOwner) {
  let sent;
  return {
    get sent() {
      return sent;
    },
    async evaluate(run, input) {
      const previousWindow = globalThis.window;
      let receive;
      globalThis.window = {
        __vibestudioTransport: {
          identity: { runtimeId: "native:System:shell", workspaceId: "system-workspace" },
          onMessage(listener) {
            receive = listener;
            return () => {};
          },
          async send(envelope) {
            sent = envelope;
            queueMicrotask(() =>
              receive({
                delivery: { caller: responseOwner },
                message: {
                  type: "response",
                  requestId: envelope.message.requestId,
                  result: "ok",
                },
              })
            );
          },
        },
      };
      try {
        return await run(input);
      } finally {
        globalThis.window = previousWindow;
      }
    },
  };
}

test("native RPC sends an explicit hub destination", async () => {
  const page = rpcPage({ callerId: "hub", callerKind: "server" });
  assert.equal(await nativeRpc(page, { kind: "hub" }, "hubControl.listWorkspaces", []), "ok");
  assert.deepEqual(page.sent.destination, { kind: "hub" });
});

test("native RPC sends and verifies an explicit workspace destination", async () => {
  const page = rpcPage({
    callerId: "workspace",
    callerKind: "server",
    workspaceId: "workspace-a",
  });
  assert.equal(
    await nativeRpc(page, { kind: "workspace", workspaceId: "workspace-a" }, "vcs.mainState", []),
    "ok"
  );
  assert.deepEqual(page.sent.destination, { kind: "workspace", workspaceId: "workspace-a" });
});

test("native RPC rejects missing destinations and responses from another owner", async () => {
  const page = rpcPage({
    callerId: "workspace",
    callerKind: "server",
    workspaceId: "workspace-b",
  });
  await assert.rejects(
    nativeRpc(page, undefined, "hubControl.listWorkspaces", []),
    /requires an explicit hub or workspace destination/
  );
  await assert.rejects(
    nativeRpc(page, { kind: "workspace", workspaceId: "workspace-a" }, "vcs.mainState", []),
    /response came from the wrong owner/
  );
});

test("browser import approvals use structured owner, capability, and operation identity", () => {
  const base = {
    kind: "capability",
    repoPath: "extensions/browser-data",
    operationId: "operation:fixture-import",
    securityIdentity: "consent:fixture-import",
    grantResourceKey: "browser-data:personal",
    resource: { type: "browser-data", label: "Personal", value: "personal" },
  };
  assert.deepEqual(
    browserImportApprovalIdentity({
      ...base,
      capability: "userland:workers/browser-data/browser-data.write#definition-digest",
    }),
    {
      phase: "store",
      logicalKey: JSON.stringify({
        capability: "userland:workers/browser-data/browser-data.write#definition-digest",
        operationId: "operation:fixture-import",
        securityIdentity: "consent:fixture-import",
        grantResourceKey: "browser-data:personal",
        resource: { type: "browser-data", label: "Personal", value: "personal" },
      }),
    }
  );
  assert.equal(
    browserImportApprovalIdentity({
      ...base,
      capability: "service:browserEnvironment.startImportRead",
    })?.phase,
    "read"
  );
});

test("browser import approval matching rejects copy and unrelated requesters", () => {
  const request = {
    kind: "capability",
    repoPath: "extensions/browser-data",
    capability: "userland:workers/browser-data/browser-data.write#definition-digest",
    operationId: "operation:fixture-import",
  };
  assert.equal(
    browserImportApprovalIdentity({
      ...request,
      repoPath: "extensions/other",
      title: "Change browser data",
    }),
    null
  );
  assert.equal(browserImportApprovalIdentity({ ...request, operationId: undefined }), null);
  assert.equal(
    browserImportApprovalIdentity({ ...request, capability: "browser-data.write" }),
    null
  );
  assert.equal(
    browserImportApprovalIdentity({
      ...request,
      requester: { repoPath: "extensions/other" },
    }),
    null
  );
  assert.deepEqual(
    browserImportApprovalRejection({
      ...request,
      approvalId: "approval:unknown",
      capability: "userland:workers/browser-data/browser-data.future#digest",
    }),
    {
      approvalId: "approval:unknown",
      repoPath: "extensions/browser-data",
      requesterRepoPath: null,
      capability: "userland:workers/browser-data/browser-data.future#digest",
      operationId: "operation:fixture-import",
    }
  );
  assert.deepEqual(
    browserImportApprovalRejection({
      ...request,
      approvalId: "approval:missing-operation",
      operationId: undefined,
    }),
    {
      approvalId: "approval:missing-operation",
      repoPath: "extensions/browser-data",
      requesterRepoPath: null,
      capability: "userland:workers/browser-data/browser-data.write#definition-digest",
      operationId: null,
    }
  );
  assert.equal(browserImportApprovalRejection({ ...request, repoPath: "extensions/other" }), null);
});

test("browser import approval settlement waits for the clicked queue row to leave", async () => {
  let reads = 0;
  await waitForApprovalSettlement(
    async () => (++reads === 1 ? [{ approvalId: "approval:clicked" }] : []),
    "approval:clicked",
    Date.now() + 1_000
  );
  assert.equal(reads, 2);
});
