import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AttachedHostChallengeRecord,
  AttachedHostSessionRecord,
} from "./attachedHostProtocol.js";
import { AttachedHostSessionStore } from "./attachedHostSessionStore.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function record(): AttachedHostSessionRecord {
  return {
    transcript: {
      protocolVersion: 1,
      sessionId: "session",
      parentHostId: "parent",
      childHostId: "child",
      childGenerationId: "0123456789abcdef0123456789abcdef",
      developmentRunId: "run",
      initiatingRuntimeId: "agent:one",
      initiatingRuntimeKind: "agent",
      initiatingUserId: "usr_one",
      authorityCeiling: [],
      authorityCeilingDigest: "0".repeat(64),
      issuedAt: 1,
      expiresAt: 100_000,
      parentRoutePublicKey: "public-parent",
      childRoutePublicKey: "public-child",
    },
    parentSignature: "parent-signature",
    childSignature: "child-signature",
    parentKeyFingerprint: "1".repeat(64),
    childKeyFingerprint: "2".repeat(64),
    state: "active",
    closedReason: null,
    closedAt: null,
  };
}

function challengeRecord(): AttachedHostChallengeRecord {
  return {
    challenge: {
      protocolVersion: 1,
      sessionId: "session",
      childGenerationId: "0123456789abcdef0123456789abcdef",
      nonce: "approval-one",
      requestId: "request-one",
      invocationSnapshot: {
        v: 2,
        service: "files",
        method: "write",
        capability: "workspace.file.write",
        capabilityDefinitionDigest: "-",
        resourceType: "filesystem",
        provider: "-",
        providerExecutionDigest: "-",
        resourceKey: "context:one/a.txt",
        argsDigest: "a".repeat(64),
        preparedStateDigest: "b".repeat(64),
        callerPrincipal: "session:one",
        sessionId: "authority-session",
        reviewedClosureSubject: "-",
        snippetDigest: "c".repeat(64),
        codeLineage: { class: "internal", chain: [] },
        contextLineage: null,
        initiatorChain: ["agent:one"],
        at: 1,
      },
      invocationSnapshotDigest: "d".repeat(64),
      capability: "workspace.file.write",
      resourceKey: "context:one/a.txt",
      tier: "gated",
      preparedOperationDigest: "b".repeat(64),
      expiresAt: 100_000,
      signature: "s".repeat(86),
    },
    shownPresentationDigest: "e".repeat(64),
    state: "pending",
    decision: null,
    challengedAt: 10,
    decidedAt: null,
  };
}

describe("AttachedHostSessionStore", () => {
  it("rejects challenge state from another system epoch", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "attached-host-store-"));
    roots.push(root);
    const file = path.join(root, "sessions.db");
    const database = new DatabaseSync(file);
    database.exec(`
      CREATE TABLE attached_host_challenges (
        session_id TEXT NOT NULL,
        nonce TEXT NOT NULL,
        challenge_json TEXT NOT NULL,
        shown_presentation_digest TEXT,
        state TEXT NOT NULL,
        decision TEXT,
        PRIMARY KEY (session_id, nonce)
      );
    `);
    database.close();

    expect(() => new AttachedHostSessionStore(file)).toThrow(/not from the current system epoch/);
  });

  it("durably rejects duplicates while preserving out-of-order concurrent delivery", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "attached-host-store-"));
    roots.push(root);
    const file = path.join(root, "sessions.db");
    const first = new AttachedHostSessionStore(file);
    first.putSession(record());
    expect(first.consumeMessage("session", "2", 10_000, 100)).toBe(true);
    expect(first.consumeMessage("session", "1", 10_000, 101)).toBe(true);
    expect(first.consumeMessage("session", "2", 10_000, 102)).toBe(false);
    first.close();

    const reopened = new AttachedHostSessionStore(file);
    expect(reopened.consumeMessage("session", "1", 10_000, 103)).toBe(false);
    expect(reopened.consumeMessage("session", "3", 10_000, 104)).toBe(true);
    reopened.close();
  });

  it("expires old replay rows without making a live duplicate reusable", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "attached-host-store-"));
    roots.push(root);
    const store = new AttachedHostSessionStore(path.join(root, "sessions.db"));
    store.putSession(record());
    expect(store.consumeMessage("session", "1", 200, 100)).toBe(true);
    expect(store.consumeMessage("session", "2", 10_000, 201)).toBe(true);
    // Message 1 is outside its signed validity window; pruning it does not
    // matter because the protocol refuses its expired envelope before replay.
    expect(store.consumeMessage("session", "2", 10_000, 202)).toBe(false);
    store.close();
  });

  it("refuses credential or private-key material in durable session records", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "attached-host-store-"));
    roots.push(root);
    const store = new AttachedHostSessionStore(path.join(root, "sessions.db"));
    expect(() =>
      store.putSession({
        ...record(),
        refreshToken: "must-never-persist",
      } as AttachedHostSessionRecord)
    ).toThrow(expect.objectContaining({ code: "EATTACHED_SECRET" }));
    expect(() =>
      store.putSession({
        ...record(),
        privateKey: "must-never-persist",
      } as AttachedHostSessionRecord)
    ).toThrow(expect.objectContaining({ code: "EATTACHED_SECRET" }));
    store.close();
  });

  it("pages only durable terminal decision receipts with canonical digests", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "attached-host-store-"));
    roots.push(root);
    const file = path.join(root, "sessions.db");
    const first = new AttachedHostSessionStore(file);
    first.putSession(record());
    const challenge = challengeRecord();
    first.putChallenge(challenge);
    expect(first.listApprovalAudit({ sessionId: "session", after: null, limit: 1 })).toEqual([]);
    expect(
      first.recordChallengeDecision(
        "session",
        "approval-one",
        challenge.challenge.invocationSnapshotDigest,
        "once",
        20
      )
    ).toBe(true);
    expect(
      first.recordChallengeDecision(
        "session",
        "approval-one",
        challenge.challenge.invocationSnapshotDigest,
        "deny",
        21
      )
    ).toBe(false);
    first.close();

    const reopened = new AttachedHostSessionStore(file);
    expect(reopened.listApprovalAudit({ sessionId: "session", after: null, limit: 1 })).toEqual([
      expect.objectContaining({
        cursor: "1",
        challenge: expect.objectContaining({
          requestId: "request-one",
          invocationSnapshotDigest: "d".repeat(64),
          preparedOperationDigest: "b".repeat(64),
        }),
        shownPresentationDigest: "e".repeat(64),
        decision: "once",
        challengedAt: 10,
        decidedAt: 20,
      }),
    ]);
    reopened.close();
  });
});
