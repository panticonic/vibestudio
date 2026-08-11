import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { productAuthorityGrants } from "./productAuthorityGrants.js";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";

const GAD_CAPABILITY = "workspace-service:gad.workspace";

const originalAppRoot = process.env["VIBESTUDIO_APP_ROOT"];
const appRoot = mkdtempSync(join(tmpdir(), "vibestudio-product-authority-"));

beforeAll(() => {
  mkdirSync(join(appRoot, "dist"));
  writeFileSync(
    join(appRoot, "dist", "host-build-fingerprint.json"),
    JSON.stringify({ fingerprint: "a".repeat(64) })
  );
  process.env["VIBESTUDIO_APP_ROOT"] = appRoot;
});

afterAll(() => {
  if (originalAppRoot === undefined) delete process.env["VIBESTUDIO_APP_ROOT"];
  else process.env["VIBESTUDIO_APP_ROOT"] = originalAppRoot;
  rmSync(appRoot, { recursive: true, force: true });
});

describe("product bootstrap authority", () => {
  it("admits an authenticated trusted user at gated—but never critical—tiers", () => {
    const caller = createVerifiedCaller("shell:device", "shell");
    const base = {
      caller,
      principals: { user: "user:alice" as const },
      capability: "service:runtime.supervision.activate",
      resourceKey: "service:runtime.supervision.activate",
      sessionId: "shell:device",
      now: 1,
    };

    expect(productAuthorityGrants({ ...base, tier: "gated" })).toEqual([
      expect.objectContaining({ subject: "user:alice", effect: "allow" }),
    ]);
    expect(productAuthorityGrants({ ...base, tier: "critical" })).toEqual([]);
  });

  it("does not turn a reviewed catalog row into standing gated or critical consent", () => {
    const capability = "service:credentials.resolveCredential";
    const digest = "a".repeat(64);
    const caller = createVerifiedCaller("do:workers/agent-worker:AiChatWorker:test", "do", {
      callerId: "do:workers/agent-worker:AiChatWorker:test",
      callerKind: "do",
      repoPath: "workers/agent-worker",
      effectiveVersion: "ev-test",
      executionDigest: digest,
      requested: [{ capability, resource: { kind: "exact", key: capability } }],
    });
    const base = {
      caller,
      principals: { code: `code:workers/agent-worker@${digest}` as const },
      capability,
      resourceKey: capability,
      sessionId: "session-test",
      now: 1,
    };

    expect(productAuthorityGrants({ ...base, tier: "gated" })).toEqual([]);
    expect(productAuthorityGrants({ ...base, tier: "critical" })).toEqual([]);
  });

  it("never turns a declared request into authority, however exactly it was sealed", () => {
    const capability = "rpc:callMethod";
    const digest = "a".repeat(64);
    const caller = {
      ...createVerifiedCaller("do:workers/agent-worker:AiChatWorker:test", "do", {
        callerId: "do:workers/agent-worker:AiChatWorker:test",
        callerKind: "do",
        repoPath: "workers/agent-worker",
        effectiveVersion: "ev-test",
        executionDigest: digest,
        requested: [{ capability, resource: { kind: "prefix", prefix: "" } }],
      }),
      // Admitted: this exact version was reviewed and accepted. Admission is
      // not authority — what the unit may do comes from a stored grant.
      codeApproved: true as const,
    };

    expect(
      productAuthorityGrants({
        caller,
        principals: { code: "code:workers/agent-worker@ev-test" },
        capability,
        resourceKey: "do:workers/pubsub-channel:PubSubChannel:test",
        sessionId: "session-test",
        now: 1,
      })
    ).toEqual([]);
  });

  it("does not admit a direct capability absent from the exact sealed manifest", () => {
    const digest = "b".repeat(64);
    const caller = createVerifiedCaller("do:workers/example:Example:test", "do", {
      callerId: "do:workers/example:Example:test",
      callerKind: "do",
      repoPath: "workers/example",
      effectiveVersion: "ev-test",
      executionDigest: digest,
      requested: [],
    });
    expect(
      productAuthorityGrants({
        caller,
        principals: { code: `code:workers/example@${digest}` },
        capability: GAD_CAPABILITY,
        resourceKey: "do:workers/workspace-source:GadWorkspaceDO:workspace",
        sessionId: "session-test",
        now: 1,
      })
    ).toEqual([]);
  });
});
