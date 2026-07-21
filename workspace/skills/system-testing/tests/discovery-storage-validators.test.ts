import { describe, expect, it } from "vitest";

import type { TestExecutionResult } from "../types.js";
import { blobstoreTests } from "./blobstore.js";
import { docsDiscoveryTests } from "./docs-discovery.js";
import { docsProbeTests } from "./docs-probes.js";
import { serverLogTests } from "./server-logs.js";
import { webhookTests } from "./webhooks.js";

function invocation(
  name: string,
  arguments_: Record<string, unknown>,
  result: unknown,
  options: { error?: boolean } = {}
) {
  return {
    kind: "message" as const,
    senderId: "agent",
    complete: true,
    contentType: "invocation" as const,
    invocation: {
      id: `${name}:call`,
      name,
      arguments: arguments_,
      execution: {
        status: options.error ? "error" : "complete",
        isError: options.error === true,
        result,
      },
    },
  };
}

function execution(
  final: string,
  calls: ReturnType<typeof invocation>[] = []
): TestExecutionResult {
  return {
    duration: 0,
    messages: [
      { kind: "message", senderId: "user", complete: true, content: "prompt" },
      ...calls,
      { kind: "message", senderId: "agent", complete: true, content: final },
    ],
  } as TestExecutionResult;
}

describe("storage and discovery semantic validators", () => {
  it("joins a natural blobstore report to the completed text/range/search round trip", () => {
    const test = blobstoreTests.find((candidate) => candidate.name === "blob-text-roundtrip-grep")!;
    const digest = "a".repeat(64);
    const call = invocation(
      "eval",
      {
        code: "const stored = await services.blobstore.putText(text); const full = await services.blobstore.getText(stored.digest); const range = await services.blobstore.getRange(stored.digest, 0, 8); const matches = await services.blobstore.grep(stored.digest, 'marker', { maxMatches: 3 }); return { digest: stored.digest, full, range, matches };",
      },
      {
        details: {
          success: true,
          returnValue: {
            digest,
            fullMatches: true,
            rangeMatches: true,
            markerMatches: true,
          },
        },
      }
    );
    const final =
      "The document text round-tripped successfully; the byte range matched, and the stored marker search returned the expected match.";
    expect(test.validate(execution(final, [call]))).toEqual({ passed: true });
    expect(test.validate(execution(final))).toMatchObject({ passed: false });
  });

  it("requires a live bounded docs hit before accepting a capability citation", () => {
    const test = docsDiscoveryTests.find(
      (candidate) => candidate.name === "docs-search-capability"
    )!;
    const hit = {
      id: "service:blobstore.putText",
      surface: "service",
      qualifiedName: "blobstore.putText",
      title: "Store text",
      description: "Store content-addressable blob text",
    };
    const call = invocation(
      "docs_search",
      { query: "content-addressable blobs", limit: 10 },
      { details: [hit] }
    );
    const final =
      "Yes. The live catalog documents blobstore.putText for storing content-addressable blob text.";
    expect(test.validate(execution(final, [call]))).toEqual({ passed: true });
    expect(test.validate(execution(final))).toMatchObject({ passed: false });
  });

  it("identity-joins a searched service entry to the opened method catalog", () => {
    const test = docsDiscoveryTests.find(
      (candidate) => candidate.name === "docs-describe-service"
    )!;
    const entry = {
      id: "service:blobstore",
      surface: "service",
      qualifiedName: "blobstore",
      title: "Blob storage",
      members: ["putText", "getText"],
    };
    const search = invocation(
      "docs_search",
      { query: "blob storage", limit: 10 },
      { details: [entry] }
    );
    const open = invocation("docs_open", { id: entry.id }, { details: entry });
    const final =
      "The blobstore service stores content-addressed data and exposes putText and getText.";
    expect(test.validate(execution(final, [search, open]))).toEqual({ passed: true });
    expect(test.validate(execution(final, [open]))).toMatchObject({ passed: false });
  });

  it("requires documentation evidence for a natural docs-probe decision", () => {
    const test = docsProbeTests.find(
      (candidate) => candidate.name === "docs-sandbox-vcs-decision"
    )!;
    const read = invocation(
      "read",
      { path: "workspace/skills/sandbox/RUNTIME_API.md" },
      { text: "Browser panels use the semantic workspace VCS runtime surface for source changes." }
    );
    const final =
      "I would avoid committing through browser filesystem tricks and instead use the workspace semantic VCS surface from the panel runtime.";
    expect(test.validate(execution(final, [read]))).toEqual({ passed: true });
    expect(test.validate(execution(final))).toMatchObject({ passed: false });
    expect(
      test.validate(
        execution(final, [
          invocation(
            "docs_search",
            { query: "sandbox runtime VCS version control" },
            { details: [] }
          ),
        ])
      )
    ).toMatchObject({ passed: false });
  });

  it("requires bounded canonical host-log query and statistics evidence", () => {
    const test = serverLogTests.find((candidate) => candidate.name === "server-log-query-stats")!;
    const call = invocation(
      "eval",
      {
        code: "const entries = await services.serverLog.query({ level: 'warn', limit: 20 }); const stats = await services.serverLog.stats(); return { entries, stats };",
      },
      {
        details: {
          success: true,
          returnValue: {
            entries: {
              records: [{ level: "warn" }],
              latestSeq: 4,
              serverBootId: "boot:test",
            },
            stats: { totalCaptured: 4, bufferSize: 4, byLevel: { warn: 1 } },
          },
        },
      }
    );
    const final =
      "The bounded host-log sample contained 1 warning entry; overall server log statistics report 4 entries.";
    expect(test.validate(execution(final, [call]))).toEqual({ passed: true });
    expect(test.validate(execution(final))).toMatchObject({ passed: false });
  });

  it("requires an identity-joined webhook lifecycle and final cleanup", () => {
    const test = webhookTests.find(
      (candidate) => candidate.name === "webhook-subscription-lifecycle"
    )!;
    const call = invocation(
      "eval",
      {
        code: "const created = await webhooks.createSubscription(request); const before = await webhooks.listSubscriptions(); const rotated = await webhooks.rotateSecret(created.subscriptionId); await webhooks.revokeSubscription(created.subscriptionId); const after = await webhooks.listSubscriptions(); return { created: true, listed: before.some(x => x.subscriptionId === created.subscriptionId), rotated: Boolean(rotated), removed: !after.some(x => x.subscriptionId === created.subscriptionId) };",
      },
      {
        details: {
          success: true,
          returnValue: { created: true, listed: true, rotated: true, removed: true },
        },
      }
    );
    const final =
      "The temporary webhook subscription was created and listed, its secret was rotated, and it was revoked and removed during cleanup.";
    expect(test.validate(execution(final, [call]))).toEqual({ passed: true });
    expect(test.validate(execution(final))).toMatchObject({ passed: false });
  });
});
