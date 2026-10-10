import { mainRpcMethods } from "@vibestudio/service-schemas/mainRpc";
import { wireClientFor } from "@vibestudio/rpc/internal";
import { sha256HexSyncText } from "@vibestudio/content-addressing";
import { describe, expect, it, vi } from "vitest";
import { createTestDO } from "@vibestudio/durable/test-utils";
import type { BuildPerformanceProfileWire } from "@vibestudio/service-schemas/build";
import { EVAL_OPERATION_JOURNAL_PREVIEW_CHARS } from "@vibestudio/service-schemas/eval";
import { EvalDO } from "./EvalDO.js";
import { ExecutionJournal } from "./executionJournal.js";

function profile(): BuildPerformanceProfileWire {
  return {
    version: 1,
    source: "panels/example",
    ref: "ctx:owner",
    startedAt: 1,
    firstRun: { elapsedMs: 10, cacheState: "built-during-profile" },
    verifiedCacheRun: { elapsedMs: 1, sameBuildKeys: true },
    report: {
      repoPath: "panels/example",
      kind: "panel",
      status: "ok",
      stateHash: "state:exact",
      diagnostics: [],
      builds: [{ target: "runtime", buildKey: "build:exact", diagnosticIndexes: [] }],
    },
    targets: [
      {
        target: "runtime",
        buildKey: "build:exact",
        builtAt: "now",
        artifactCount: 1,
        artifactBytes: 42,
        largestArtifacts: [],
        executableModuleCount: 1,
        executableSourceBytes: 42,
        bundleReport: { initial: { bytes: 42 }, source: "PRIVATE BUNDLE CONTENT" },
      },
    ],
  } as unknown as BuildPerformanceProfileWire;
}

describe("execution-owned native operation evidence", () => {
  it("records a settled provider transport call before guest mutation without retaining secrets", async () => {
    const { instance } = await createTestDO(EvalDO);
    const nativeRpc = wireClientFor(
      (instance as unknown as { rpc: { call: (...args: unknown[]) => Promise<unknown> } })
        .rpc as import("@vibestudio/rpc").RpcClient
    );
    vi.spyOn(nativeRpc, "call").mockResolvedValueOnce([]);
    const owner = (
      instance as unknown as {
        createExecutionContext: (input: { contextId: string }) => {
          rpc: typeof nativeRpc;
          operationJournal: ExecutionJournal;
        };
      }
    ).createExecutionContext({ contextId: "owner" });
    const returned = (await owner.rpc.call("main", "extensions.invokeProvider", [
      "gitInterop",
      "upstreamStatus",
      [{ secret: "PRIVATE ARGUMENT" }],
    ])) as unknown[];
    returned.push({ secret: "PRIVATE GUEST MUTATION" });
    const journal = owner.operationJournal.close();
    expect(journal.entries).toEqual([
      {
        type: "extension.invocation",
        receipt: {
          protocol: "extension-invocation-observation.v1",
          transport: "invokeProvider",
          providerKey: "gitInterop",
          method: "upstreamStatus",
          result: { kind: "array", length: 0 },
        },
      },
    ]);
    expect(JSON.stringify(journal)).not.toContain("PRIVATE");
  });

  it.each([
    [{}, { kind: "object", keyCount: 0 }],
    [{ privateKey: "PRIVATE RESULT" }, { kind: "object", keyCount: 1 }],
    ["PRIVATE RESULT", { kind: "string", length: 14 }],
    [false, { kind: "boolean" }],
    [12345, { kind: "number" }],
    [null, { kind: "null" }],
  ])("retains only the observable shape of an extension result %j", (returned, shape) => {
    const journal = new ExecutionJournal();
    journal.recordExtensionInvocation(
      "extensions.invoke",
      ["extensions/example", "status", ["PRIVATE ARGUMENT"]],
      returned
    );
    expect(journal.close().entries).toEqual([
      {
        type: "extension.invocation",
        receipt: {
          protocol: "extension-invocation-observation.v1",
          transport: "invoke",
          extensionKey: "extensions/example",
          method: "status",
          result: shape,
        },
      },
    ]);
    const encoded = JSON.stringify(journal.close());
    expect(encoded).not.toContain("PRIVATE");
    expect(encoded).not.toContain("privateKey");
    expect(encoded).not.toContain("12345");
  });

  it("retains the original failed RPC and records neither failed calls nor calls to another receiver", async () => {
    const { instance } = await createTestDO(EvalDO);
    const nativeRpc = wireClientFor(
      (instance as unknown as { rpc: { call: (...args: unknown[]) => Promise<unknown> } })
        .rpc as import("@vibestudio/rpc").RpcClient
    );
    const failure = new Error("original extension failure");
    vi.spyOn(nativeRpc, "call").mockRejectedValueOnce(failure).mockResolvedValueOnce([]);
    const owner = (
      instance as unknown as {
        createExecutionContext: (input: { contextId: string }) => {
          rpc: typeof nativeRpc;
          operationJournal: ExecutionJournal;
        };
      }
    ).createExecutionContext({ contextId: "owner" });
    await expect(
      owner.rpc.call("main", "extensions.invokeProvider", ["gitInterop", "upstreamStatus", []])
    ).rejects.toBe(failure);
    await owner.rpc.call("worker:unrelated", "extensions.invokeProvider", [
      "gitInterop",
      "upstreamStatus",
      [],
    ]);
    expect(owner.operationJournal.close().entries).toEqual([]);
  });

  it("rejects malformed invocation observations and ignores unrelated or closed operations", () => {
    const journal = new ExecutionJournal();
    expect(() => journal.recordExtensionInvocation("extensions.invokeProvider", [], [])).toThrow();
    expect(() =>
      journal.recordExtensionInvocation("extensions.invoke", ["example", "status", []], undefined)
    ).toThrow();
    journal.recordExtensionInvocation("extensions.ready", ["example"], {});
    expect(journal.close().entries).toEqual([]);
    journal.recordExtensionInvocation("extensions.invoke", ["example", "status", []], {});
    expect(journal.close().entries).toEqual([]);
  });

  it("records permission inventory before guest summarization without retaining grant data", async () => {
    const { instance } = await createTestDO(EvalDO);
    const nativeRpc = wireClientFor(
      (
        instance as unknown as {
          rpc: { call: (...args: unknown[]) => Promise<unknown> };
        }
      ).rpc as import("@vibestudio/rpc").RpcClient
    );
    const grant = {
      id: "private-grant",
      kind: "capability",
      callerLabel: "PRIVATE CALLER",
      scopeLabel: "PRIVATE SCOPE",
      why: "PRIVATE PURPOSE",
      approvedBy: "PRIVATE USER",
      duration: "Until revoked",
      revokeEffect: "Stops future access",
    };
    vi.spyOn(nativeRpc, "call").mockResolvedValueOnce([grant]);
    const owner = (
      instance as unknown as {
        createExecutionContext: (input: { contextId: string }) => {
          rpc: typeof nativeRpc;
          operationJournal: ExecutionJournal;
        };
      }
    ).createExecutionContext({ contextId: "owner" });
    const returned = (await owner.rpc.call("main", "permissions.list", [])) as unknown[];
    returned.length = 0;
    const journal = owner.operationJournal.close();
    expect(journal.entries).toEqual([
      {
        type: "permissions.inventory",
        receipt: {
          protocol: "permission-inventory-observation.v1",
          method: "permissions.list",
          total: 1,
          counts: { capability: 1, "credential-use": 0, "browser-site": 0 },
        },
      },
    ]);
    expect(JSON.stringify(journal)).not.toContain("PRIVATE");
    expect(JSON.stringify(journal)).not.toContain("private-grant");
  });

  it("records credential misses without retaining the audience or credential data", () => {
    const journal = new ExecutionJournal();
    journal.recordCredentialResolution(
      "credentials.resolveCredential",
      [{ url: "https://private.example/resource" }],
      null
    );
    expect(journal.close().entries).toEqual([
      {
        type: "credentials.resolution",
        receipt: {
          protocol: "credential-resolution-observation.v1",
          method: "credentials.resolveCredential",
          requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
          found: false,
        },
      },
    ]);
    expect(JSON.stringify(journal.close())).not.toContain("private.example");
    const invalid = new ExecutionJournal();
    expect(() =>
      invalid.recordCredentialResolution("credentials.resolveCredential", [{}], null)
    ).toThrow();
    expect(() =>
      invalid.recordCredentialResolution(
        "credentials.resolveCredential",
        [{ url: "https://private.example" }],
        { secret: "PRIVATE" }
      )
    ).toThrow();
    expect(invalid.close().entries).toEqual([]);
  });

  it("records accepted notification identity and labels before guest mutation and joins explicit dismissal", () => {
    const journal = new ExecutionJournal();
    const input = {
      type: "info",
      title: "PRIVATE TITLE",
      message: "PRIVATE MESSAGE",
      actions: [{ id: "accept", label: "Accept" }],
    };
    journal.recordNotificationLifecycle("notification.show", [input], "host-notification");
    input.actions[0]!.label = "forged";
    journal.recordNotificationLifecycle("notification.dismiss", ["host-notification"], undefined);
    const observed = journal.close();
    expect(observed.entries).toEqual([
      {
        type: "notification.lifecycle",
        receipt: {
          protocol: "notification-lifecycle-observation.v1",
          method: "notification.show",
          notificationId: "host-notification",
          actionLabels: ["Accept"],
        },
      },
      {
        type: "notification.lifecycle",
        receipt: {
          protocol: "notification-lifecycle-observation.v1",
          method: "notification.dismiss",
          notificationId: "host-notification",
        },
      },
    ]);
    expect(JSON.stringify(observed)).not.toContain("PRIVATE");
  });

  it("does not record malformed, failed or closed permission reads as inventory completion", () => {
    const journal = new ExecutionJournal();
    expect(() =>
      journal.recordPermissionInventory("permissions.list", [], [{ id: "invalid" }])
    ).toThrow();
    journal.recordPermissionInventory("permissions.revoke", [], undefined);
    expect(journal.close().entries).toEqual([]);
    journal.recordPermissionInventory("permissions.list", [], []);
    expect(journal.close().entries).toEqual([]);
  });

  it("copies provenance before guest mutation and excludes bundle contents", () => {
    const journal = new ExecutionJournal();
    const measured = profile();
    journal.recordBuildProfile(measured);
    measured.report.stateHash = "forged";
    measured.targets[0]!.buildKey = "forged";
    const result = journal.close();
    expect(result.entries[0]).toMatchObject({
      type: "build.profile",
      receipt: {
        report: { stateHash: "state:exact" },
        targets: [{ buildKey: "build:exact", bundleReport: { initial: { bytes: 42 } } }],
      },
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE BUNDLE CONTENT");
  });

  it("retains native receipts when the caller only returns a summary", async () => {
    const { instance } = await createTestDO(EvalDO);
    const nativeRpc = wireClientFor(
      (instance as unknown as { rpc: { call: (...args: unknown[]) => Promise<unknown> } })
        .rpc as import("@vibestudio/rpc").RpcClient
    );
    vi.spyOn(nativeRpc, "call").mockResolvedValueOnce(profile());
    const owner = (
      instance as unknown as {
        createExecutionContext: (input: { contextId: string }) => {
          rpc: typeof nativeRpc;
          operationJournal: ExecutionJournal;
        };
      }
    ).createExecutionContext({ contextId: "owner" });
    const returned = await owner.rpc.call("main", "build.getPerformanceProfile", [
      "panels/example",
      "ctx:owner",
    ]);
    const summary = { measured: !!returned };
    expect(summary).toEqual({ measured: true });
    expect(owner.operationJournal.close().entries).toHaveLength(1);
  });

  it("records bounded native log facts before guest summarization and mutation", async () => {
    const { instance } = await createTestDO(EvalDO);
    const nativeRpc = wireClientFor(
      (instance as unknown as { rpc: { call: (...args: unknown[]) => Promise<unknown> } })
        .rpc as import("@vibestudio/rpc").RpcClient
    );
    const envelope = {
      serverBootId: "boot-a",
      workspaceId: "workspace-a",
      pid: 1,
      startedAt: 1,
      latestSeq: 10,
      records: [
        {
          seq: 10,
          timestamp: 1,
          level: "warn",
          message: "PRIVATE LOG CONTENT",
          fields: ["PRIVATE FIELDS"],
          pid: 1,
        },
      ],
    };
    vi.spyOn(nativeRpc, "call").mockResolvedValueOnce(envelope);
    const owner = (
      instance as unknown as {
        createExecutionContext: (input: { contextId: string }) => {
          rpc: typeof nativeRpc;
          operationJournal: ExecutionJournal;
        };
      }
    ).createExecutionContext({ contextId: "owner" });
    const returned = (await owner.rpc.call("main", "serverLog.tail", [5])) as typeof envelope;
    returned.records[0]!.level = "error";
    returned.records.length = 0;
    const result = owner.operationJournal.close();
    expect(result.entries).toEqual([
      {
        type: "server-log.observation",
        receipt: {
          protocol: "server-log-observation.v1",
          kind: "records",
          method: "tail",
          limit: 5,
          serverBootId: "boot-a",
          latestSeq: 10,
          firstSeq: 10,
          lastSeq: 10,
          count: 1,
          byLevel: { verbose: 0, info: 0, warn: 1, error: 0 },
          newestLevel: "warn",
        },
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });

  it("preserves empty filtered observations and exact statistics without log payloads", () => {
    const journal = new ExecutionJournal();
    journal.recordServerLogRead("serverLog.query", [{ level: "warn", limit: 100 }], {
      serverBootId: "boot-a",
      workspaceId: "workspace-a",
      pid: 1,
      startedAt: 1,
      latestSeq: 10,
      records: [],
    });
    journal.recordServerLogRead("serverLog.stats", [], {
      bufferSize: 20000,
      totalCaptured: 10,
      oldestSeq: 1,
      latestSeq: 10,
      byLevel: { verbose: 0, info: 9, warn: 1, error: 0 },
      byTag: [{ tag: "PRIVATE TAG", count: 10 }],
    });
    const result = journal.close();
    expect(result.entries[0]).toMatchObject({
      receipt: {
        kind: "records",
        method: "query",
        minimumLevel: "warn",
        limit: 100,
        count: 0,
        newestLevel: null,
        firstSeq: null,
        lastSeq: null,
      },
    });
    expect(result.entries[1]).toMatchObject({
      receipt: { kind: "stats", totalCaptured: 10, latestSeq: 10 },
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    journal.recordServerLogRead("serverLog.tail", [1], "late malformed result");
    expect(result.entries).toHaveLength(2);
  });

  it("joins native blob reads without retaining document or search text", async () => {
    const { instance } = await createTestDO(EvalDO);
    const rpc = wireClientFor(
      (instance as unknown as { rpc: { call: (...args: unknown[]) => Promise<unknown> } })
        .rpc as import("@vibestudio/rpc").RpcClient
    );
    const text = "PRIVATE DOCUMENT\nPRIVATE MARKER\n";
    const digest = sha256HexSyncText(text);
    const matches = [{ lineNumber: 2, line: "PRIVATE MARKER", before: [], after: [] }];
    vi.spyOn(rpc, "call")
      .mockResolvedValueOnce({ digest, size: new TextEncoder().encode(text).length })
      .mockResolvedValueOnce(text)
      .mockResolvedValueOnce("PRIVATE")
      .mockResolvedValueOnce(matches);
    const owner = (
      instance as unknown as {
        createExecutionContext: (input: { contextId: string }) => {
          rpc: typeof rpc;
          operationJournal: ExecutionJournal;
        };
      }
    ).createExecutionContext({ contextId: "owner" });
    await owner.rpc.call("main", "blobstore.putText", [text]);
    await owner.rpc.call("main", "blobstore.getText", [digest]);
    await owner.rpc.call("main", "blobstore.getRange", [digest, 0, 7]);
    await owner.rpc.call("main", "blobstore.grep", [digest, "PRIVATE MARKER"]);
    matches.length = 0;
    const result = owner.operationJournal.close();
    expect(result.entries).toHaveLength(4);
    expect(result.entries[0]).toMatchObject({
      receipt: { digest, contentDigest: digest, lineCount: 3 },
    });
    expect(result.entries[1]).toMatchObject({
      receipt: { digest, contentDigest: digest, size: new TextEncoder().encode(text).length },
    });
    expect(result.entries[2]).toMatchObject({
      receipt: { digest, offset: 0, length: 7, present: true, decodedSize: 7 },
    });
    expect(result.entries[3]).toMatchObject({ receipt: { digest, matchCount: 1, maxMatches: 50 } });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    owner.operationJournal.recordBlobTextOperation("blobstore.getText", [], "late malformed read");
    expect(result.entries).toHaveLength(4);
  });

  it("retains missing blobs and byte coordinates at partial UTF-8 boundaries", () => {
    const journal = new ExecutionJournal();
    const digest = sha256HexSyncText("é\nmarker");
    journal.recordBlobTextOperation("blobstore.getText", [digest], null);
    journal.recordBlobTextOperation("blobstore.getRange", [digest, 1, 1], "�");
    journal.recordBlobTextOperation("blobstore.grep", [digest, "absent", { maxMatches: 5 }], []);
    const result = journal.close();
    expect(result.entries[0]).toMatchObject({ receipt: { contentDigest: null, size: null } });
    expect(result.entries[1]).toMatchObject({ receipt: { offset: 1, length: 1, decodedSize: 3 } });
    expect(result.entries[2]).toMatchObject({ receipt: { matchCount: 0, maxMatches: 5 } });
  });

  it("retains canonical tree identities, listing basis, diff and materialization before guest mutation", async () => {
    const { instance } = await createTestDO(EvalDO);
    const rpc = wireClientFor(
      (instance as unknown as { rpc: { call: (...args: unknown[]) => Promise<unknown> } })
        .rpc as import("@vibestudio/rpc").RpcClient
    );
    const treeHash = `manifest:${"a".repeat(64)}`;
    const stateHash = `state:${"b".repeat(64)}`;
    const second = `state:${"c".repeat(64)}`;
    const page = {
      basis: { ref: stateHash, rootTreeHash: treeHash, prefix: "", order: "tree-preorder-v1" },
      entries: [{ path: "note.txt", kind: "file", contentHash: "d".repeat(64), mode: 33188 }],
      completeness: "complete",
    };
    const diff = {
      added: [],
      removed: [],
      changed: [
        {
          path: "note.txt",
          fromContentHash: "d".repeat(64),
          toContentHash: "e".repeat(64),
          fromMode: 33188,
          toMode: 33188,
        },
      ],
    };
    vi.spyOn(rpc, "call")
      .mockResolvedValueOnce({ treeHash, stateHash })
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce(diff)
      .mockResolvedValueOnce({ written: 1, unchanged: 0 });
    const owner = (
      instance as unknown as {
        createExecutionContext: (input: { contextId: string }) => {
          rpc: typeof rpc;
          operationJournal: ExecutionJournal;
        };
      }
    ).createExecutionContext({ contextId: "owner" });
    await owner.rpc.call("main", "blobstore.putTree", [[], { root: true }]);
    await owner.rpc.call("main", "blobstore.listTree", [stateHash, {}]);
    await owner.rpc.call("main", "blobstore.diffTrees", [stateHash, second]);
    await owner.rpc.call("main", "blobstore.materializeTree", [stateHash, "/scratch"]);
    page.entries.length = 0;
    diff.changed.length = 0;
    const result = owner.operationJournal.close();
    expect(result.entries).toHaveLength(4);
    expect(result.entries[1]).toMatchObject({
      receipt: { ref: stateHash, page: { entries: [{ path: "note.txt" }] } },
    });
    expect(result.entries[2]).toMatchObject({
      receipt: { from: stateHash, to: second, diff: { changed: [{ path: "note.txt" }] } },
    });
    expect(result.entries[3]).toMatchObject({
      receipt: { ref: stateHash, written: 1, unchanged: 0 },
    });
  });

  it("captures webhook identities and counts without retaining secrets or verifier configuration", async () => {
    const { instance } = await createTestDO(EvalDO);
    const rpc = wireClientFor(
      (instance as unknown as { rpc: { call: (...args: unknown[]) => Promise<unknown> } })
        .rpc as import("@vibestudio/rpc").RpcClient
    );
    const subscription = {
      subscriptionId: "subscription-a",
      ownerCallerId: "owner",
      ownerCallerKind: "do",
      target: {
        source: "workers/test",
        className: "TestDO",
        objectKey: "owner",
        method: "onWebhook",
      },
      delivery: { mode: "direct" },
      bodyBudget: { mode: "transport-default" },
      maxBodyBytes: 1000,
      payload: { type: "json" },
      verifier: { type: "hmac-sha256", headerName: "PRIVATE HEADER", hasSecret: true },
      response: { successStatus: 204, malformedPayload: "reject", dispatchError: "retry" },
      publicUrl: "http://localhost/webhook",
      createdAt: 1,
      updatedAt: 1,
    };
    const list = [subscription];
    vi.spyOn(rpc, "call")
      .mockResolvedValueOnce(subscription)
      .mockResolvedValueOnce(list)
      .mockResolvedValueOnce({ subscription, secret: "PRIVATE ROTATED SECRET" })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce([]);
    const owner = (
      instance as unknown as {
        createExecutionContext: (input: { contextId: string }) => {
          rpc: typeof rpc;
          operationJournal: ExecutionJournal;
        };
      }
    ).createExecutionContext({ contextId: "owner" });
    await owner.rpc.call("main", "webhookIngress.createSubscription", [
      {
        target: subscription.target,
        delivery: subscription.delivery,
        payload: subscription.payload,
        response: subscription.response,
        verifier: {
          type: "hmac-sha256",
          headerName: "PRIVATE HEADER",
          secret: "PRIVATE ORIGINAL SECRET",
        },
      },
    ]);
    await owner.rpc.call("main", "webhookIngress.listSubscriptions", []);
    await owner.rpc.call("main", "webhookIngress.rotateSecret", [
      { subscriptionId: "subscription-a" },
    ]);
    await owner.rpc.call("main", "webhookIngress.revokeSubscription", [
      { subscriptionId: "subscription-a" },
    ]);
    await owner.rpc.call("main", "webhookIngress.listSubscriptions", [{ includeRevoked: false }]);
    list.length = 0;
    const result = owner.operationJournal.close();
    expect(result.entries).toHaveLength(5);
    expect(result.entries[1]).toMatchObject({
      receipt: {
        includeRevoked: false,
        subscriptions: [{ subscriptionId: "subscription-a", revoked: false }],
      },
    });
    expect(result.entries[2]).toMatchObject({
      receipt: { subscriptionId: "subscription-a", secretPresent: true },
    });
    expect(result.entries[4]).toMatchObject({ receipt: { subscriptions: [] } });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    owner.operationJournal.recordWebhookOperation(
      "webhookIngress.rotateSecret",
      [],
      "late malformed result"
    );
    expect(result.entries).toHaveLength(5);
  });

  it("records filesystem access from native dispatch without copying file contents", async () => {
    const { instance } = await createTestDO(EvalDO);
    const nativeRpc = wireClientFor(
      (instance as unknown as { rpc: { call: (...args: unknown[]) => Promise<unknown> } })
        .rpc as import("@vibestudio/rpc").RpcClient
    );
    vi.spyOn(nativeRpc, "call").mockResolvedValue("PRIVATE FILE CONTENT");
    const owner = (
      instance as unknown as {
        createExecutionContext: (input: { contextId: string }) => {
          rpc: typeof nativeRpc;
          operationJournal: ExecutionJournal;
        };
      }
    ).createExecutionContext({ contextId: "owner" });
    await owner.rpc.call("main", "fs.readFile", ["skills/system-testing/tests/example.ts", "utf8"]);
    await owner.rpc.call("main", "problemReports.create", [
      { description: "skills/system-testing/tests/example.ts" },
    ]);
    expect(owner.operationJournal.close().entries).toEqual([
      { type: "fs.read", method: "fs.readFile", path: "skills/system-testing/tests/example.ts" },
    ]);
    expect(JSON.stringify(owner.operationJournal.entries)).not.toContain("PRIVATE FILE CONTENT");
  });

  it("seals late completions to their old owner instead of the next execution", () => {
    const oldOwner = new ExecutionJournal();
    const nextOwner = new ExecutionJournal();
    const terminal = oldOwner.close();
    oldOwner.recordBuildProfile(profile());
    expect(terminal.entries).toEqual([]);
    expect(nextOwner.close().entries).toEqual([]);
  });

  it("records effective default bounds and rejects foreign health identity", () => {
    const owner = new ExecutionJournal();
    const identity = { kind: "extension" as const, entityId: "extension:one" };
    const health = {
      entity: {
        identity,
        release: { kind: "extension" as const, releaseId: identity.entityId },
        source: "extensions/one",
        status: "running",
        lastError: null,
        artifact: { effectiveVersion: null, buildKey: null, executionDigest: null },
        facets: { activation: true, release: false, inspector: false },
      },
      state: "healthy",
      summary: "private diagnostic prose",
      logs: [{ identity, timestamp: 1, level: "info", message: "private log prose" }],
      errors: [{ identity, timestamp: 2, level: "error", message: "private failure" }],
      dropped: { entries: 7, errors: 2 },
      capacity: { entries: 100, errors: 50 },
    };
    owner.recordRuntimeHealth("runtime.supervision.health", [identity], health);
    expect(owner.entries[0]).toMatchObject({
      type: "runtime.health",
      receipt: {
        identity,
        logCount: 1,
        errorCount: 1,
        limit: 100,
        errorLimit: 50,
        dropped: { entries: 7, errors: 2 },
        capacity: { entries: 100, errors: 50 },
      },
    });
    owner.recordRuntimeHealth(
      "runtime.supervision.health",
      [identity, { limit: 8, errorLimit: 5 }],
      health
    );
    health.logs.length = 0;
    const wire = { entries: owner.entries };
    expect(wire.entries[1]).toMatchObject({
      type: "runtime.health",
      receipt: { identity, logCount: 1, errorCount: 1, limit: 8, errorLimit: 5 },
    });
    expect(JSON.stringify(wire)).not.toContain("private");
    expect(() =>
      owner.recordRuntimeHealth(
        "runtime.supervision.health",
        [identity, { limit: 8, errorLimit: 5 }],
        {
          ...health,
          errors: [
            {
              identity: { ...identity, entityId: "extension:other" },
              timestamp: 2,
              level: "error",
              message: "foreign",
            },
          ],
        }
      )
    ).toThrow("different supervised entity identity");
  });

  it("records the native supervision roster for direct and aliased list calls", async () => {
    const { instance } = await createTestDO(EvalDO);
    const nativeRpc = wireClientFor(
      (
        instance as unknown as {
          rpc: { call: (...args: unknown[]) => Promise<unknown> };
        }
      ).rpc as import("@vibestudio/rpc").RpcClient
    );
    const entity = {
      identity: { kind: "worker", entityId: "worker:one" },
      release: { kind: "worker", releaseId: "workers/one" },
      source: "workers/one",
      status: "running",
      lastError: null,
      artifact: { effectiveVersion: "ev-one", buildKey: null, executionDigest: null },
      facets: { activation: false, release: false, inspector: false },
    };
    vi.spyOn(nativeRpc, "call").mockResolvedValue([entity]);
    const owner = (
      instance as unknown as {
        createExecutionContext: (input: { contextId: string }) => {
          rpc: typeof nativeRpc;
          operationJournal: ExecutionJournal;
        };
      }
    ).createExecutionContext({ contextId: "owner" });

    await owner.rpc.call("main", "runtime.supervision.list", []);
    const runtime = {
      supervision: {
        list: () => owner.rpc.call("main", "runtime.supervision.list", []),
        describe: (target: unknown) =>
          owner.rpc.call("main", "runtime.supervision.describe", [target]),
      },
    };
    await runtime.supervision.list();
    await runtime.supervision.describe(entity.identity);

    expect(owner.operationJournal.close().entries).toEqual([
      {
        type: "runtime.units",
        receipt: {
          protocol: "runtime-unit-observation.v1",
          method: "runtime.supervision.list",
          entities: [
            {
              identity: entity.identity,
              source: entity.source,
              status: entity.status,
            },
          ],
        },
      },
      {
        type: "runtime.units",
        receipt: {
          protocol: "runtime-unit-observation.v1",
          method: "runtime.supervision.list",
          entities: [
            {
              identity: entity.identity,
              source: entity.source,
              status: entity.status,
            },
          ],
        },
      },
      {
        type: "runtime.units",
        receipt: {
          protocol: "runtime-unit-observation.v1",
          method: "runtime.supervision.describe",
          entities: [
            {
              identity: entity.identity,
              source: entity.source,
              status: entity.status,
            },
          ],
        },
      },
    ]);
  });

  it("validates successful unit results for canonical methods only", () => {
    const owner = new ExecutionJournal();
    expect(() => owner.recordRuntimeUnits("runtime.supervision.list", {})).toThrow();
    expect(() => owner.recordRuntimeUnits("runtime.supervision.describe", {})).toThrow();
    expect(() => owner.recordRuntimeUnits("runtime.supervision.health", {})).not.toThrow();
    expect(owner.entries).toEqual([]);
  });

  it("marks incomplete evidence without exceeding the wire budget", () => {
    const owner = new ExecutionJournal();
    owner.recordBuildProfile(profile());
    owner.append({ type: "large", data: "x".repeat(EVAL_OPERATION_JOURNAL_PREVIEW_CHARS) });
    const terminal = owner.close();
    expect(terminal.truncated).toBe(true);
    expect(terminal.entries).toHaveLength(1);
  });
});

it("gives eval code the same receiver-validated RPC facade as workspace code", async () => {
  const { instance } = await createTestDO(EvalDO);
  const internal = instance as unknown as {
    rpc: import("@vibestudio/rpc").RpcClient;
    createExecutionContext(input: { contextId: string }): unknown;
    createActiveRuntimeRpc(): import("@vibestudio/rpc").RpcClient;
    activeEvalExecution: { run<T>(execution: unknown, operation: () => T): T };
  };
  const wire = vi.spyOn(wireClientFor(internal.rpc), "call").mockResolvedValue(true);
  const execution = internal.createExecutionContext({ contextId: "owner" });
  const publicRpc = internal.createActiveRuntimeRpc();
  await expect(
    internal.activeEvalExecution.run(execution, () =>
      publicRpc.call("main", mainRpcMethods["fs.exists"], ["file.txt"])
    )
  ).resolves.toBe(true);
  expect(wire).toHaveBeenCalled();
  wire.mockClear();
  await expect(
    internal.activeEvalExecution.run(execution, () =>
      // @ts-expect-error Workspace and eval share the same receiver argument contract.
      publicRpc.call("main", mainRpcMethods["fs.exists"], [42])
    )
  ).rejects.toThrow();
  expect(wire).not.toHaveBeenCalled();
  wire.mockResolvedValueOnce("wrong result");
  await expect(
    internal.activeEvalExecution.run(execution, () =>
      publicRpc.call("main", mainRpcMethods["fs.exists"], ["file.txt"])
    )
  ).rejects.toThrow();
});
