import { z } from "zod";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import type { ServiceAuthorityPolicy } from "@vibestudio/shared/serviceAuthority";

const nonEmpty = z.string().min(1);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const authority: ServiceAuthorityPolicy = { principals: ["user"] };
const open = { sensitivity: "read" as const };

export const developmentClientExecutorMethods = defineServiceMethods({
  register: {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "developmentClientExecutor.create",
      rationale:
        "Authenticated desktop refreshes an in-memory reviewed-executor lease bound to its verified runtime and user",
    },
    description:
      "Register or refresh this authenticated desktop as a reviewed Electron development executor.",
    args: z.tuple([
      z
        .object({
          providerId: nonEmpty,
          platform: nonEmpty,
          arch: nonEmpty,
          executorDigest: sha256,
        })
        .strict(),
    ]),
    returns: z.object({ leaseExpiresAt: z.number().int().nonnegative() }).strict(),
    authority,
    access: open,
  },
  claim: {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "developmentClientExecutor.control",
      rationale:
        "Exact selected desktop reads only its addressed bounded launch manifest and opaque pairing invite",
    },
    description: "Claim an exact pending development-client launch addressed to this desktop.",
    args: z.tuple([z.object({ requestId: nonEmpty }).strict()]),
    returns: z
      .object({
        requestId: nonEmpty,
        runId: nonEmpty,
        mainEntryBuildId: sha256,
        executionDigest: sha256,
        recipeId: nonEmpty,
        artifacts: z.array(
          z
            .object({
              path: nonEmpty,
              integrity: z.string().regex(/^sha256-[a-f0-9]{64}$/u),
              byteLength: z.number().int().nonnegative(),
            })
            .strict()
        ),
        pairingDeepLink: nonEmpty,
        expiresAt: z.number().int().nonnegative(),
      })
      .strict(),
    authority,
    access: open,
  },
  readArtifact: {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "developmentClientExecutor.read",
      rationale:
        "Exact selected desktop reads one integrity-bound artifact chunk from its addressed pending launch",
    },
    description:
      "Read one bounded chunk of an exact pending artifact into the selected executor's owned root.",
    args: z.tuple([
      z
        .object({
          requestId: nonEmpty,
          path: nonEmpty,
          offset: z.number().int().nonnegative(),
          length: z
            .number()
            .int()
            .positive()
            .max(1024 * 1024),
        })
        .strict(),
    ]),
    returns: z
      .object({
        base64: z.string(),
        nextOffset: z.number().int().nonnegative(),
        eof: z.boolean(),
      })
      .strict(),
    authority,
    access: open,
  },
  launched: {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "developmentClientExecutor.create",
      rationale:
        "Selected desktop reports an exact owned-process receipt; readiness still requires independent paired-child attestation",
    },
    description: "Record the selected trusted executor's owned-process launch receipt.",
    args: z.tuple([
      z
        .object({
          requestId: nonEmpty,
          childPid: z.number().int().positive(),
          ownershipDigest: sha256,
        })
        .strict(),
    ]),
    returns: z.object({ accepted: z.literal(true) }).strict(),
    authority,
    access: open,
  },
  attest: {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "developmentClientExecutor.control",
      rationale:
        "Opaque nonce acknowledgement by an ordinarily paired child; caller identity and execution facts are host-derived",
    },
    description:
      "Attest readiness from the newly paired child session; identity and user are derived from the verified caller.",
    args: z.tuple([z.object({ requestId: nonEmpty }).strict()]),
    returns: z.object({ accepted: z.literal(true) }).strict(),
    authority,
    access: open,
  },
  bindIsolatedManager: {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "developmentClientExecutor.control",
      rationale:
        "Exact-generation binding of the already paired isolated management device before any client invite exists",
    },
    description:
      "Bind the exact isolated generation's already-paired management device before any client invite is issued.",
    args: z.tuple([z.object({ instanceId: nonEmpty, generationId: nonEmpty }).strict()]),
    returns: z.object({ accepted: z.literal(true) }).strict(),
    authority,
    access: open,
  },
  consumeAttestation: {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "developmentClientExecutor.control",
      rationale:
        "Bound isolated management device consumes one opaque nonce receipt without credential or artifact disclosure",
    },
    description:
      "Consume one nonce-bound paired-child attestation through the exact isolated management device.",
    args: z.tuple([z.object({ requestId: nonEmpty }).strict()]),
    returns: z
      .object({
        requestId: nonEmpty,
        childRuntimeId: nonEmpty,
        attestedAt: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
    authority,
    access: open,
  },
  fail: {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "developmentClientExecutor.control",
      rationale:
        "Selected desktop terminates one pending launch with a bounded diagnostic and no widened authority",
    },
    description: "Report a bounded launch failure from the exact selected desktop executor.",
    args: z.tuple([z.object({ requestId: nonEmpty, code: nonEmpty, message: nonEmpty }).strict()]),
    returns: z.object({ accepted: z.literal(true) }).strict(),
    authority,
    access: open,
  },
  exited: {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "developmentClientExecutor.control",
      rationale:
        "Selected desktop reduces effects by reporting exact owned-process exit and private-root cleanup",
    },
    description:
      "Report exact owned-process exit and cleanup; the host derives whether it was an intentional stop.",
    args: z.tuple([
      z
        .object({
          requestId: nonEmpty,
          childPid: z.number().int().positive(),
          exitCode: z.number().int().nullable(),
          signal: nonEmpty.nullable(),
          cleanupError: z.string().min(1).max(2_000).optional(),
        })
        .strict(),
    ]),
    returns: z.object({ accepted: z.literal(true) }).strict(),
    authority,
    access: open,
  },
});
