import { z } from "zod";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import type { ServiceAuthorityPolicy } from "@vibestudio/shared/serviceAuthority";

const nonEmpty = z.string().min(1);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const authority: ServiceAuthorityPolicy = { principals: ["user"] };
const open = { sensitivity: "read" as const };

export const developmentClientExecutorMethods = defineServiceMethods({
  register: {
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
    description:
      "Attest readiness from the newly paired child session; identity and user are derived from the verified caller.",
    args: z.tuple([z.object({ requestId: nonEmpty }).strict()]),
    returns: z.object({ accepted: z.literal(true) }).strict(),
    authority,
    access: open,
  },
  bindIsolatedManager: {
    description:
      "Bind the exact isolated generation's already-paired management device before any client invite is issued.",
    args: z.tuple([z.object({ instanceId: nonEmpty, generationId: nonEmpty }).strict()]),
    returns: z.object({ accepted: z.literal(true) }).strict(),
    authority,
    access: open,
  },
  consumeAttestation: {
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
    description: "Report a bounded launch failure from the exact selected desktop executor.",
    args: z.tuple([z.object({ requestId: nonEmpty, code: nonEmpty, message: nonEmpty }).strict()]),
    returns: z.object({ accepted: z.literal(true) }).strict(),
    authority,
    access: open,
  },
  exited: {
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
