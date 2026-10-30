import type { UnitAuthorityManifest } from "@vibestudio/shared/authorityManifest";
import type { VerifiedCodeIdentity } from "@vibestudio/shared/serviceDispatcher";
import type { UnitAdmissionStore } from "./unitAdmissionStore.js";

/** Request-time admission consumes the host-sealed image, never guest services.
 * Resolving source here would recursively require admission for the source RPC.
 * Service facts are materialized and sealed with the executable before launch. */
export function isSealedCodeAdmitted(input: {
  code: Pick<VerifiedCodeIdentity, "repoPath" | "effectiveVersion" | "executionDigest">;
  image: {
    sourcePath: string | null;
    ev: string;
    execution?: { executionDigest: string };
    authority?: UnitAuthorityManifest;
    serviceAuthorityDigest?: string;
  } | null;
  admissionStore: Pick<UnitAdmissionStore, "has">;
}): boolean {
  const { image, code } = input;
  if (
    !image?.authority ||
    image.sourcePath !== code.repoPath ||
    image.ev !== code.effectiveVersion ||
    !code.executionDigest ||
    image.execution?.executionDigest !== code.executionDigest ||
    !image.serviceAuthorityDigest ||
    !/^[0-9a-f]{64}$/u.test(image.serviceAuthorityDigest)
  )
    return false;
  return input.admissionStore.has({
    repoPath: code.repoPath,
    effectiveVersion: code.effectiveVersion,
    authority: image.authority,
    serviceAuthorityDigest: image.serviceAuthorityDigest,
  });
}

/**
 * Admission of a plain Durable Object's raw-egress identity (`do-code:…`). It names
 * one sealed executable unit rather than an entity, so the image is resolved from
 * the unit the host registered it for and must match the identity exactly before
 * the same sealed-image admission applies.
 */
export async function isDoCodeAdmitted(input: {
  code: Pick<VerifiedCodeIdentity, "repoPath" | "effectiveVersion" | "executionDigest">;
  executable: {
    source: string;
    effectiveVersion: string;
    buildKey: string;
    executionDigest: string;
  } | null;
  getBuild(
    buildKey: string,
    executionDigest: string
  ): Promise<{ metadata: Parameters<typeof isSealedCodeAdmitted>[0]["image"] } | null | undefined>;
  admissionStore: Pick<UnitAdmissionStore, "has">;
}): Promise<boolean> {
  const { code, executable } = input;
  if (
    !executable ||
    !code.executionDigest ||
    executable.source !== code.repoPath ||
    executable.effectiveVersion !== code.effectiveVersion ||
    executable.executionDigest !== code.executionDigest
  )
    return false;
  const build = await input.getBuild(executable.buildKey, executable.executionDigest);
  return isSealedCodeAdmitted({
    code,
    image: build?.metadata ?? null,
    admissionStore: input.admissionStore,
  });
}
