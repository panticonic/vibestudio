/** Canonical protected-ref CAS basis shared by journal and host publication gate. */
import {
  canonicalJson,
  compareUtf16CodeUnits,
  sha256HexSyncText,
} from "@vibestudio/content-addressing";

export function hostRefBasisDigest(
  refs: readonly { repoPath: string; contentRoot: string }[]
): string {
  const ordered = [...refs].sort((left, right) =>
    compareUtf16CodeUnits(left.repoPath, right.repoPath)
  );
  return `protected-ref-basis:${sha256HexSyncText(
    canonicalJson({
      domain: "protected-ref-basis",
      protocol: "vibestudio.vcs.protected-refs.v2",
      payload: ordered,
    })
  )}`;
}
