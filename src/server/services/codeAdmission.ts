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
