import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebsiteDocuments } from "./websiteDocuments.js";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";
import type { ApprovalQueue } from "./approvalQueue.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function fixture(decision: "session" | "always" | "deny" = "session") {
  const dir = mkdtempSync(join(tmpdir(), "website-documents-"));
  const grants = new CapabilityGrantStore({ statePath: dir });
  const request = vi.fn<ApprovalQueue["request"]>().mockResolvedValue(decision);
  const retireRuntime = vi.fn(async (_id: string) => {});
  const changed = vi.fn();
  const isHostForRuntime = vi.fn((host: string) => host === "native-host");
  const documents = new WebsiteDocuments({
    workspaceId: "ws-1",
    grants,
    approvals: { request },
    retireRuntime,
    changed,
    isHostForRuntime,
  });
  cleanups.push(async () => {
    await documents.close();
    grants.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const input = {
    runtimeId: "panel:browser",
    documentId: "document-1",
    hostId: "native-host",
    user: { userId: "usr_alice", handle: "alice" },
    origin: "https://example.com",
  };
  return { documents, grants, request, retireRuntime, changed, isHostForRuntime, input };
}

describe("website document admission", () => {
  it("starts disconnected and retires a captured fact on replacement", async () => {
    const f = fixture();
    await f.documents.begin(f.input);
    expect(f.documents.fact(f.input.runtimeId)?.connected).toBe(false);
    expect(f.request).not.toHaveBeenCalled();
    await expect(
      f.documents.connect(f.input.runtimeId, f.input.documentId, f.input.hostId)
    ).resolves.toBe(true);
    const fact = f.documents.fact(f.input.runtimeId)!;
    expect(f.grants.isSubjectExecutionCurrent(fact.binding)).toBe(true);
    await f.documents.begin({ ...f.input, documentId: "document-2" });
    expect(f.documents.isLive(f.input.runtimeId, fact)).toBe(false);
    expect(f.grants.isSubjectExecutionCurrent(fact.binding)).toBe(false);
    await f.documents.connect(f.input.runtimeId, "document-2", f.input.hostId);
    expect(f.request).toHaveBeenCalledTimes(2);
  });

  it("remembers consent across fresh documents but never other origins or users", async () => {
    const f = fixture("always");
    await f.documents.begin(f.input);
    await f.documents.connect(f.input.runtimeId, f.input.documentId, f.input.hostId);
    const first = f.documents.fact(f.input.runtimeId)!;
    await f.documents.begin({ ...f.input, documentId: "document-2" });
    expect(f.documents.fact(f.input.runtimeId)?.connected).toBe(false);
    await f.documents.connect(f.input.runtimeId, "document-2", f.input.hostId);
    expect(f.documents.fact(f.input.runtimeId)?.subject).toBe(first.subject);
    expect(f.request).toHaveBeenCalledTimes(1);
    await f.documents.begin({
      ...f.input,
      documentId: "document-3",
      origin: "https://other.example",
    });
    await f.documents.connect(f.input.runtimeId, "document-3", f.input.hostId);
    expect(f.documents.fact(f.input.runtimeId)?.subject).not.toBe(first.subject);
    await f.documents.begin({
      ...f.input,
      documentId: "document-4",
      user: { userId: "usr_bob", handle: "bob" },
    });
    await f.documents.connect(f.input.runtimeId, "document-4", f.input.hostId);
    expect(f.documents.fact(f.input.runtimeId)?.subject).not.toBe(first.subject);
    expect(f.request).toHaveBeenCalledTimes(3);
  });

  it("does not deliver late approval or save it for a replacement page", async () => {
    const f = fixture();
    let approve!: (decision: "always") => void;
    f.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          approve = resolve;
        })
    );
    await f.documents.begin(f.input);
    const pending = f.documents.connect(f.input.runtimeId, f.input.documentId, f.input.hostId);
    expect(f.documents.connect(f.input.runtimeId, f.input.documentId, f.input.hostId)).toBe(
      pending
    );
    const prompt = f.request.mock.calls[0]![0];
    await f.documents.begin({ ...f.input, documentId: "document-2" });
    expect(prompt.signal?.aborted).toBe(true);
    approve("always");
    await expect(pending).resolves.toBe(false);
    expect(f.documents.fact(f.input.runtimeId)?.connected).toBe(false);
    await f.documents.connect(f.input.runtimeId, "document-2", f.input.hostId);
    expect(f.request).toHaveBeenCalledTimes(2);
  });

  it("requires current host ownership and rejects document identity rebinding", async () => {
    const f = fixture();
    await expect(f.documents.begin({ ...f.input, hostId: "foreign" })).rejects.toThrow(/owned/);
    await f.documents.begin(f.input);
    await expect(
      f.documents.begin({ ...f.input, origin: "https://other.example" })
    ).rejects.toThrow(/rebound/);
    f.isHostForRuntime.mockReturnValue(false);
    expect(f.documents.fact(f.input.runtimeId)).toBe(null);
    await expect(
      f.documents.connect(f.input.runtimeId, f.input.documentId, f.input.hostId)
    ).rejects.toThrow(/current/);
    expect(f.request).not.toHaveBeenCalled();
  });

  it("revocation withdraws live executions and remembered grants", async () => {
    const f = fixture("always");
    await f.documents.begin(f.input);
    await f.documents.connect(f.input.runtimeId, f.input.documentId, f.input.hostId);
    const fact = f.documents.fact(f.input.runtimeId)!;
    await f.documents.revoke(fact.subject);
    expect(f.documents.fact(f.input.runtimeId)).toBe(null);
    expect(f.grants.isSubjectExecutionCurrent(fact.binding)).toBe(false);
    await f.documents.begin({ ...f.input, documentId: "document-2" });
    await f.documents.connect(f.input.runtimeId, "document-2", f.input.hostId);
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.documents.fact(f.input.runtimeId)?.binding.generation).toBe(
      fact.binding.generation + 1
    );
  });

  it("ordinary grant withdrawal immediately invalidates the live execution", async () => {
    const f = fixture("always");
    await f.documents.begin(f.input);
    await f.documents.connect(f.input.runtimeId, f.input.documentId, f.input.hostId);
    const fact = f.documents.fact(f.input.runtimeId)!;
    const grant = f.grants.grantsForSubjects([fact.subject], "workspace.connect")[0]!;
    f.grants.revoke(grant.id!);
    expect(f.grants.isSubjectExecutionCurrent(fact.binding)).toBe(false);
    expect(f.documents.fact(f.input.runtimeId)).toBe(null);
    await vi.waitFor(() => expect(f.retireRuntime).toHaveBeenCalledWith(f.input.runtimeId));
  });

  it("a captured execution loses authority when presentation ownership changes", async () => {
    const f = fixture();
    await f.documents.begin(f.input);
    await f.documents.connect(f.input.runtimeId, f.input.documentId, f.input.hostId);
    const fact = f.documents.fact(f.input.runtimeId)!;
    f.isHostForRuntime.mockReturnValue(false);
    expect(f.grants.isSubjectExecutionCurrent(fact.binding)).toBe(false);
  });

  it("shutdown fences document admission queued behind transport retirement", async () => {
    const f = fixture();
    await f.documents.begin(f.input);
    let retired!: () => void;
    f.retireRuntime.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          retired = resolve;
        })
    );
    const replacement = f.documents.begin({ ...f.input, documentId: "document-2" });
    const rejected = expect(replacement).rejects.toThrow(/ownership changed/);
    await vi.waitFor(() => expect(f.retireRuntime).toHaveBeenCalled());
    const closed = f.documents.close();
    retired();
    await rejected;
    await closed;
    expect(f.documents.fact(f.input.runtimeId)).toBe(null);
    await expect(f.documents.begin(f.input)).rejects.toThrow(/closed/);
  });
});
