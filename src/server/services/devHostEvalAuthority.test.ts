import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import {
  DevHostEvalAuthorityIssuer,
  verifyDevHostEvalApprovalRoute,
  verifyDevHostEvalAuthority,
  type DevEvalGenerationIdentity,
} from "./devHostEvalAuthority.js";

const recipient = generateKeyPairSync("x25519");
const recipientPublicKey = recipient.publicKey
  .export({ type: "spki", format: "der" })
  .toString("base64url");
const recipientPrivateKey = recipient.privateKey
  .export({ type: "pkcs8", format: "der" })
  .toString("base64url");
const generation: DevEvalGenerationIdentity = {
  launchId: "launch-1",
  hostBuildId: "build-1",
  childServerId: "child-1",
  processIdentity: "123:boot-1",
  childWorkspaceId: "workspace-1",
  childContextId: "unbound",
  recipientPublicKey,
};

const initiator = createVerifiedCaller("worker:agent", "worker", {
  callerId: "worker:agent",
  callerKind: "worker",
  repoPath: "workers/agent",
  executionDigest: "a".repeat(64),
  requested: [],
  delegations: [
    {
      audience: "eval",
      purpose: "agentic-code-execution",
      capabilities: [
        { capability: "service:fs.readFile", resource: { kind: "prefix", prefix: "" } },
      ],
    },
  ],
});

describe("development-host eval authority attestation", () => {
  it("preserves the exact initiator and binds every generation and start-intent fact", () => {
    const issuer = new DevHostEvalAuthorityIssuer("parent:boot-1");
    const start = { source: { kind: "inline" as const, code: "return 42" } };
    const envelope = issuer.issue({ generation, initiator, start, now: 100, ttlMs: 1_000 });
    const visibleEnvelope = Buffer.from(envelope.payload, "base64url").toString("utf8");
    expect(visibleEnvelope).not.toContain("workers/agent");
    expect(visibleEnvelope).not.toContain("service:fs.readFile");
    expect(visibleEnvelope).not.toContain("delegations");
    const verified = verifyDevHostEvalAuthority({
      envelope,
      publicKeySpki: issuer.publicKeySpki,
      parentHostId: issuer.parentHostId,
      generation,
      recipientPrivateKey,
      start,
      now: 200,
    });
    expect(verified.initiator).toEqual(initiator);
    expect(verified.payload).toMatchObject({
      launchId: generation.launchId,
      hostBuildId: generation.hostBuildId,
      processIdentity: generation.processIdentity,
      startIntentDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
  });

  it("rejects tampering, cross-generation replay, changed input, and expiry", () => {
    const issuer = new DevHostEvalAuthorityIssuer("parent:boot-1");
    const start = { source: { kind: "inline" as const, code: "return 42" } };
    const envelope = issuer.issue({ generation, initiator, start, now: 100, ttlMs: 100 });
    const verify = (overrides: Partial<Parameters<typeof verifyDevHostEvalAuthority>[0]> = {}) =>
      verifyDevHostEvalAuthority({
        envelope,
        publicKeySpki: issuer.publicKeySpki,
        parentHostId: issuer.parentHostId,
        generation,
        recipientPrivateKey,
        start,
        now: 150,
        ...overrides,
      });

    expect(() =>
      verify({
        envelope: {
          ...envelope,
          signature: `${envelope.signature[0] === "A" ? "B" : "A"}${envelope.signature.slice(1)}`,
        },
      })
    ).toThrow(/signature/u);
    expect(() => verify({ generation: { ...generation, processIdentity: "999:other" } })).toThrow(
      /another child generation/u
    );
    expect(() => verify({ start: { source: { kind: "inline", code: "return 43" } } })).toThrow(
      /different eval input/u
    );
    expect(() => verify({ now: 200 })).toThrow(/expired/u);
    const wrongRecipient = generateKeyPairSync("x25519");
    expect(() =>
      verify({
        recipientPrivateKey: wrongRecipient.privateKey
          .export({ type: "pkcs8", format: "der" })
          .toString("base64url"),
      })
    ).toThrow(/not sealed for this child generation/u);
  });

  it("binds a short-lived approval-route proof to the exact authority and generation", () => {
    const issuer = new DevHostEvalAuthorityIssuer("parent:boot-1");
    const start = { source: { kind: "inline" as const, code: "return 42" } };
    const authority = issuer.issue({ generation, initiator, start, now: 100 });
    const proof = issuer.issueApprovalRoute({ generation, authority, now: 110 });
    const verify = (
      overrides: Partial<Parameters<typeof verifyDevHostEvalApprovalRoute>[0]> = {}
    ) =>
      verifyDevHostEvalApprovalRoute({
        proof,
        authority,
        publicKeySpki: issuer.publicKeySpki,
        parentHostId: issuer.parentHostId,
        generation,
        now: 120,
        ...overrides,
      });

    expect(verify()).toMatchObject({
      purpose: "dev-host-eval-approval-route",
      launchId: generation.launchId,
      processIdentity: generation.processIdentity,
    });
    const otherAuthority = issuer.issue({
      generation,
      initiator,
      start: { source: { kind: "inline", code: "return 43" } },
      now: 100,
    });
    expect(() => verify({ authority: otherAuthority })).toThrow(/another authority/u);
    expect(() => verify({ generation: { ...generation, processIdentity: "replaced" } })).toThrow(
      /child generation/u
    );
    expect(() => verify({ now: 30_111 })).toThrow(/not live/u);
  });
});
