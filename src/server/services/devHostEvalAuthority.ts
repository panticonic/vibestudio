import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import type {
  EvalParentApprovalRouteProof,
  EvalParentAuthorityEnvelope,
  EvalStartInput,
} from "@vibestudio/service-schemas/eval";
import type { VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { isCallerKind } from "@vibestudio/shared/principalKinds";
import {
  parseAuthorityDelegations,
  parseAuthorityRequests,
} from "@vibestudio/shared/authorityManifest";
import { evalStartIntentDigest } from "./evalStartIdentity.js";

const ATTESTATION_VERSION = 1;
const DEFAULT_TTL_MS = 60 * 60 * 1_000;
const APPROVAL_ROUTE_TTL_MS = 30_000;

export interface DevEvalGenerationIdentity {
  launchId: string;
  hostBuildId: string;
  childServerId: string;
  processIdentity: string;
  childWorkspaceId: string;
  childContextId: string;
  /** Child-generated X25519 recipient. Its private half never enters the
   * extension/provider process. */
  recipientPublicKey: string;
}

interface DevEvalAuthorityPayload extends DevEvalGenerationIdentity {
  version: typeof ATTESTATION_VERSION;
  parentHostId: string;
  audience: string;
  purpose: "dev-host-eval";
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  startIntentDigest: string;
  sealedInitiator: {
    ephemeralPublicKey: string;
    iv: string;
    ciphertext: string;
    tag: string;
  };
}

type DevEvalAuthorityMetadata = Omit<DevEvalAuthorityPayload, "sealedInitiator">;

interface DevEvalApprovalRoutePayload extends DevEvalGenerationIdentity {
  version: typeof ATTESTATION_VERSION;
  parentHostId: string;
  audience: string;
  purpose: "dev-host-eval-approval-route";
  authorityDigest: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

/** One parent-process key. A parent restart deliberately changes the key, so
 * old child generations cannot accept or resolve new authority attestations. */
export class DevHostEvalAuthorityIssuer {
  readonly parentHostId: string;
  readonly publicKeySpki: string;
  private readonly privateKeyPkcs8: string;

  constructor(parentHostId: string) {
    this.parentHostId = parentHostId;
    const pair = generateKeyPairSync("ed25519");
    this.publicKeySpki = pair.publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64url");
    this.privateKeyPkcs8 = pair.privateKey
      .export({ type: "pkcs8", format: "der" })
      .toString("base64url");
  }

  issue(input: {
    generation: DevEvalGenerationIdentity;
    initiator: VerifiedCaller;
    start: EvalStartInput;
    now?: number;
    ttlMs?: number;
  }): EvalParentAuthorityEnvelope {
    const now = input.now ?? Date.now();
    const metadata = authorityMetadata({
      version: ATTESTATION_VERSION,
      parentHostId: this.parentHostId,
      audience: audienceFor(input.generation),
      purpose: "dev-host-eval",
      ...input.generation,
      issuedAt: now,
      expiresAt: now + (input.ttlMs ?? DEFAULT_TTL_MS),
      nonce: randomUUID(),
      startIntentDigest: evalStartIntentDigest(input.start),
    });
    const ephemeral = generateKeyPairSync("x25519");
    const shared = diffieHellman({
      privateKey: ephemeral.privateKey,
      publicKey: createPublicKey({
        key: Buffer.from(input.generation.recipientPublicKey, "base64url"),
        type: "spki",
        format: "der",
      }),
    });
    const key = sealedInitiatorKey(shared);
    const iv = randomBytes(12);
    const aad = Buffer.from(JSON.stringify(metadata), "utf8");
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(input.initiator), "utf8"),
      cipher.final(),
    ]);
    const payload: DevEvalAuthorityPayload = {
      ...metadata,
      sealedInitiator: {
        ephemeralPublicKey: ephemeral.publicKey
          .export({ type: "spki", format: "der" })
          .toString("base64url"),
        iv: iv.toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url"),
      },
    };
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = sign(
      null,
      Buffer.from(encoded, "utf8"),
      createPrivateKey({
        key: Buffer.from(this.privateKeyPkcs8, "base64url"),
        type: "pkcs8",
        format: "der",
      })
    ).toString("base64url");
    return { payload: encoded, signature };
  }

  issueApprovalRoute(input: {
    generation: DevEvalGenerationIdentity;
    authority: EvalParentAuthorityEnvelope;
    now?: number;
  }): EvalParentApprovalRouteProof {
    const now = input.now ?? Date.now();
    const payload: DevEvalApprovalRoutePayload = {
      version: ATTESTATION_VERSION,
      parentHostId: this.parentHostId,
      audience: audienceFor(input.generation),
      purpose: "dev-host-eval-approval-route",
      authorityDigest: authorityEnvelopeDigest(input.authority),
      ...input.generation,
      issuedAt: now,
      expiresAt: now + APPROVAL_ROUTE_TTL_MS,
      nonce: randomUUID(),
    };
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = sign(
      null,
      Buffer.from(encoded, "utf8"),
      createPrivateKey({
        key: Buffer.from(this.privateKeyPkcs8, "base64url"),
        type: "pkcs8",
        format: "der",
      })
    ).toString("base64url");
    return { payload: encoded, signature };
  }
}

export function verifyDevHostEvalApprovalRoute(input: {
  proof: EvalParentApprovalRouteProof;
  authority: EvalParentAuthorityEnvelope;
  publicKeySpki: string;
  parentHostId: string;
  generation: DevEvalGenerationIdentity;
  now?: number;
}): DevEvalApprovalRoutePayload {
  const signatureValid = verify(
    null,
    Buffer.from(input.proof.payload, "utf8"),
    createPublicKey({
      key: Buffer.from(input.publicKeySpki, "base64url"),
      type: "spki",
      format: "der",
    }),
    Buffer.from(input.proof.signature, "base64url")
  );
  if (!signatureValid) {
    throw authorityError("EVAL_APPROVAL_ROUTE_LOST", "Invalid parent approval-route signature");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(input.proof.payload, "base64url").toString("utf8"));
  } catch {
    throw authorityError("EVAL_APPROVAL_ROUTE_LOST", "Invalid parent approval-route payload");
  }
  const payload = parseApprovalRoutePayload(decoded);
  const now = input.now ?? Date.now();
  if (payload.issuedAt > now || payload.expiresAt <= now) {
    throw authorityError("EVAL_APPROVAL_ROUTE_LOST", "Parent approval route is not live");
  }
  if (
    payload.parentHostId !== input.parentHostId ||
    payload.audience !== audienceFor(input.generation) ||
    payload.launchId !== input.generation.launchId ||
    payload.hostBuildId !== input.generation.hostBuildId ||
    payload.childServerId !== input.generation.childServerId ||
    payload.processIdentity !== input.generation.processIdentity ||
    payload.childWorkspaceId !== input.generation.childWorkspaceId ||
    payload.childContextId !== input.generation.childContextId ||
    payload.recipientPublicKey !== input.generation.recipientPublicKey ||
    payload.authorityDigest !== authorityEnvelopeDigest(input.authority)
  ) {
    throw authorityError(
      "EVAL_APPROVAL_ROUTE_LOST",
      "Parent approval route belongs to another authority or child generation"
    );
  }
  return payload;
}

export function verifyDevHostEvalAuthority(input: {
  envelope: EvalParentAuthorityEnvelope;
  publicKeySpki: string;
  parentHostId: string;
  generation: DevEvalGenerationIdentity;
  recipientPrivateKey: string;
  start: EvalStartInput;
  now?: number;
}): { initiator: VerifiedCaller; payload: DevEvalAuthorityPayload } {
  const signatureValid = verify(
    null,
    Buffer.from(input.envelope.payload, "utf8"),
    createPublicKey({
      key: Buffer.from(input.publicKeySpki, "base64url"),
      type: "spki",
      format: "der",
    }),
    Buffer.from(input.envelope.signature, "base64url")
  );
  if (!signatureValid)
    throw authorityError("EVAL_INVOCATION_INVALID", "Invalid parent authority signature");

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(input.envelope.payload, "base64url").toString("utf8"));
  } catch {
    throw authorityError("EVAL_INVOCATION_INVALID", "Invalid parent authority payload");
  }
  const payload = parsePayload(decoded);
  const now = input.now ?? Date.now();
  if (payload.issuedAt > now || payload.expiresAt <= now) {
    throw authorityError("EVAL_INVOCATION_EXPIRED", "Parent authority attestation expired");
  }
  if (
    payload.parentHostId !== input.parentHostId ||
    payload.audience !== audienceFor(input.generation) ||
    payload.purpose !== "dev-host-eval" ||
    payload.launchId !== input.generation.launchId ||
    payload.hostBuildId !== input.generation.hostBuildId ||
    payload.childServerId !== input.generation.childServerId ||
    payload.processIdentity !== input.generation.processIdentity ||
    payload.childWorkspaceId !== input.generation.childWorkspaceId ||
    payload.childContextId !== input.generation.childContextId ||
    payload.recipientPublicKey !== input.generation.recipientPublicKey
  ) {
    throw authorityError(
      "EVAL_INVOCATION_INVALID",
      "Parent authority attestation is bound to another child generation"
    );
  }
  if (payload.startIntentDigest !== evalStartIntentDigest(input.start)) {
    throw authorityError(
      "EVAL_IDEMPOTENCY_CONFLICT",
      "Parent authority attestation is bound to different eval input"
    );
  }
  let initiatorValue: unknown;
  try {
    const shared = diffieHellman({
      privateKey: createPrivateKey({
        key: Buffer.from(input.recipientPrivateKey, "base64url"),
        type: "pkcs8",
        format: "der",
      }),
      publicKey: createPublicKey({
        key: Buffer.from(payload.sealedInitiator.ephemeralPublicKey, "base64url"),
        type: "spki",
        format: "der",
      }),
    });
    const decipher = createDecipheriv(
      "aes-256-gcm",
      sealedInitiatorKey(shared),
      Buffer.from(payload.sealedInitiator.iv, "base64url")
    );
    decipher.setAAD(Buffer.from(JSON.stringify(authorityMetadata(payload)), "utf8"));
    decipher.setAuthTag(Buffer.from(payload.sealedInitiator.tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(payload.sealedInitiator.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    initiatorValue = JSON.parse(plaintext);
  } catch {
    throw authorityError(
      "EVAL_INVOCATION_INVALID",
      "Parent authority initiator is not sealed for this child generation"
    );
  }
  return { initiator: parseInitiator(initiatorValue), payload };
}

export function decodeDevHostEvalAuthority(
  envelope: EvalParentAuthorityEnvelope
): DevEvalAuthorityPayload {
  return parsePayload(JSON.parse(Buffer.from(envelope.payload, "base64url").toString("utf8")));
}

function audienceFor(generation: DevEvalGenerationIdentity): string {
  return `dev-host-eval:${generation.launchId}:${generation.hostBuildId}:${generation.processIdentity}`;
}

function authorityEnvelopeDigest(authority: EvalParentAuthorityEnvelope): string {
  return createHash("sha256")
    .update(authority.payload)
    .update("\0")
    .update(authority.signature)
    .digest("hex");
}

function parseApprovalRoutePayload(value: unknown): DevEvalApprovalRoutePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw authorityError(
      "EVAL_APPROVAL_ROUTE_LOST",
      "Parent approval-route payload is not an object"
    );
  }
  const record = value as Record<string, unknown>;
  const expected = [
    "audience",
    "authorityDigest",
    "childContextId",
    "childServerId",
    "childWorkspaceId",
    "expiresAt",
    "hostBuildId",
    "issuedAt",
    "launchId",
    "nonce",
    "parentHostId",
    "processIdentity",
    "purpose",
    "recipientPublicKey",
    "version",
  ];
  if (Object.keys(record).sort().join("\0") !== expected.sort().join("\0")) {
    throw authorityError("EVAL_APPROVAL_ROUTE_LOST", "Parent approval-route payload shape changed");
  }
  for (const field of expected) {
    if (field === "version" || field === "issuedAt" || field === "expiresAt") continue;
    if (typeof record[field] !== "string" || record[field] === "") {
      throw authorityError("EVAL_APPROVAL_ROUTE_LOST", `Invalid approval-route field ${field}`);
    }
  }
  if (
    record["version"] !== ATTESTATION_VERSION ||
    record["purpose"] !== "dev-host-eval-approval-route" ||
    typeof record["issuedAt"] !== "number" ||
    typeof record["expiresAt"] !== "number"
  ) {
    throw authorityError("EVAL_APPROVAL_ROUTE_LOST", "Invalid parent approval-route metadata");
  }
  return record as unknown as DevEvalApprovalRoutePayload;
}

/** Cryptographic AAD must never depend on object construction or parse order. */
function authorityMetadata(input: DevEvalAuthorityMetadata): DevEvalAuthorityMetadata {
  return {
    version: input.version,
    parentHostId: input.parentHostId,
    audience: input.audience,
    purpose: input.purpose,
    launchId: input.launchId,
    hostBuildId: input.hostBuildId,
    childServerId: input.childServerId,
    processIdentity: input.processIdentity,
    childWorkspaceId: input.childWorkspaceId,
    childContextId: input.childContextId,
    recipientPublicKey: input.recipientPublicKey,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    nonce: input.nonce,
    startIntentDigest: input.startIntentDigest,
  };
}

function parsePayload(value: unknown): DevEvalAuthorityPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw authorityError("EVAL_INVOCATION_INVALID", "Parent authority payload is not an object");
  }
  const record = value as Record<string, unknown>;
  const expected = [
    "audience",
    "childContextId",
    "childServerId",
    "childWorkspaceId",
    "expiresAt",
    "hostBuildId",
    "issuedAt",
    "launchId",
    "nonce",
    "parentHostId",
    "processIdentity",
    "purpose",
    "recipientPublicKey",
    "sealedInitiator",
    "startIntentDigest",
    "version",
  ];
  if (Object.keys(record).sort().join("\0") !== expected.sort().join("\0")) {
    throw authorityError("EVAL_INVOCATION_INVALID", "Parent authority payload shape changed");
  }
  for (const key of [
    "audience",
    "childContextId",
    "childServerId",
    "childWorkspaceId",
    "hostBuildId",
    "launchId",
    "nonce",
    "parentHostId",
    "processIdentity",
    "recipientPublicKey",
    "startIntentDigest",
  ]) {
    if (typeof record[key] !== "string" || record[key] === "") {
      throw authorityError("EVAL_INVOCATION_INVALID", `Invalid parent authority ${key}`);
    }
  }
  if (
    record["version"] !== ATTESTATION_VERSION ||
    record["purpose"] !== "dev-host-eval" ||
    typeof record["issuedAt"] !== "number" ||
    typeof record["expiresAt"] !== "number"
  ) {
    throw authorityError("EVAL_INVOCATION_INVALID", "Invalid parent authority metadata");
  }
  return {
    version: ATTESTATION_VERSION,
    parentHostId: record["parentHostId"] as string,
    audience: record["audience"] as string,
    purpose: "dev-host-eval",
    launchId: record["launchId"] as string,
    hostBuildId: record["hostBuildId"] as string,
    childServerId: record["childServerId"] as string,
    processIdentity: record["processIdentity"] as string,
    childWorkspaceId: record["childWorkspaceId"] as string,
    childContextId: record["childContextId"] as string,
    issuedAt: record["issuedAt"] as number,
    expiresAt: record["expiresAt"] as number,
    nonce: record["nonce"] as string,
    startIntentDigest: record["startIntentDigest"] as string,
    recipientPublicKey: record["recipientPublicKey"] as string,
    sealedInitiator: parseSealedInitiator(record["sealedInitiator"]),
  };
}

function parseSealedInitiator(value: unknown): DevEvalAuthorityPayload["sealedInitiator"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw authorityError("EVAL_INVOCATION_INVALID", "Sealed initiator is invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join("\0") !==
      ["ciphertext", "ephemeralPublicKey", "iv", "tag"].sort().join("\0") ||
    typeof record["ciphertext"] !== "string" ||
    typeof record["ephemeralPublicKey"] !== "string" ||
    typeof record["iv"] !== "string" ||
    typeof record["tag"] !== "string"
  ) {
    throw authorityError("EVAL_INVOCATION_INVALID", "Sealed initiator shape is invalid");
  }
  return record as unknown as DevEvalAuthorityPayload["sealedInitiator"];
}

function sealedInitiatorKey(shared: Buffer): Buffer {
  return createHash("sha256")
    .update("vibestudio/dev-host-eval-sealed-initiator/v1\0")
    .update(shared)
    .digest();
}

function parseInitiator(value: unknown): VerifiedCaller {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw authorityError("EVAL_INVOCATION_INVALID", "Attested initiator is invalid");
  }
  const input = value as Record<string, unknown>;
  const runtime = input["runtime"] as Record<string, unknown> | undefined;
  if (
    !runtime ||
    typeof runtime["id"] !== "string" ||
    typeof runtime["kind"] !== "string" ||
    !isCallerKind(runtime["kind"])
  ) {
    throw authorityError("EVAL_INVOCATION_INVALID", "Attested initiator runtime is invalid");
  }
  const caller: VerifiedCaller = {
    runtime: { id: runtime["id"], kind: runtime["kind"] },
  };
  if (input["hostOriginated"] === true) caller.hostOriginated = true;
  if (input["subject"] !== undefined) {
    const subject = input["subject"] as Record<string, unknown>;
    if (typeof subject?.["userId"] !== "string" || typeof subject["handle"] !== "string") {
      throw authorityError("EVAL_INVOCATION_INVALID", "Attested user subject is invalid");
    }
    caller.subject = { userId: subject["userId"], handle: subject["handle"] };
  }
  if (input["agentBinding"] !== undefined) {
    const binding = input["agentBinding"] as Record<string, unknown>;
    for (const key of ["entityId", "contextId", "channelId", "agentId", "userId"]) {
      if (typeof binding?.[key] !== "string") {
        throw authorityError("EVAL_INVOCATION_INVALID", "Attested agent binding is invalid");
      }
    }
    caller.agentBinding = binding as unknown as NonNullable<VerifiedCaller["agentBinding"]>;
  }
  if (input["code"] !== undefined) {
    const code = input["code"] as Record<string, unknown>;
    if (
      typeof code?.["callerId"] !== "string" ||
      typeof code["callerKind"] !== "string" ||
      !["panel", "app", "worker", "do", "extension"].includes(code["callerKind"]) ||
      typeof code["repoPath"] !== "string" ||
      typeof code["executionDigest"] !== "string"
    ) {
      throw authorityError("EVAL_INVOCATION_INVALID", "Attested code identity is invalid");
    }
    caller.code = {
      callerId: code["callerId"],
      callerKind: code["callerKind"] as NonNullable<VerifiedCaller["code"]>["callerKind"],
      repoPath: code["repoPath"],
      executionDigest: code["executionDigest"],
      requested: parseAuthorityRequests({ requests: code["requested"] }, "attested requests"),
      delegations: parseAuthorityDelegations(
        { delegations: code["delegations"] },
        "attested delegations"
      ),
    };
  }
  return caller;
}

function authorityError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
