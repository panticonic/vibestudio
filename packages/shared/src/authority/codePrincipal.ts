/**
 * The authority subject for installed code.
 *
 * Installed code's grant subject is `code:<repoPath>@<effectiveVersion>`. The
 * effective version is a content hash over the unit's whole source closure —
 * its own sources, its dependency EVs, and its external lock — so it is exact
 * source identity, and it is the identity the reviewed execution closure
 * already keys its harness on.
 *
 * That split matters twice:
 *
 *   authorization asks "is this the reviewed unit?" — answered by the effective
 *     version, which is known at review time, before anything is built;
 *   activation asks "is this the artifact the recipe produces?" — answered by
 *     the execution digest, and already enforced separately by the live
 *     registry, the declared-service identity checks, and workerd's
 *     persisted-image comparison.
 *
 * Binding the subject to the execution digest would conflate them: a clearance
 * grant could not be minted at admission (the digest exists only once the
 * artifact is built, after review), and every rebuild would silently retire the
 * grants a user had already given, because the digest also commits the emitted
 * artifact and the workspace id. A toolchain bump would make an installed part
 * start asking for permissions it already had, for no reason a person could
 * see. The execution digest is therefore carried as its own authenticated field
 * rather than smuggled inside the principal string.
 */

export type CodePrincipal = `code:${string}`;

export interface CodeIdentity {
  repoPath: string;
  effectiveVersion: string;
}

/**
 * `@` separates the two halves and a repository path may not contain one, so
 * the split is unambiguous from the left; parsing still splits from the right
 * to stay total against any path that ever could.
 */
export function codePrincipal(identity: CodeIdentity): CodePrincipal {
  if (!identity.repoPath || !identity.effectiveVersion) {
    throw new Error("A code principal needs both a repository path and an effective version");
  }
  if (identity.repoPath.includes("@")) {
    throw new Error(`Repository path may not contain '@': ${identity.repoPath}`);
  }
  return `code:${identity.repoPath}@${identity.effectiveVersion}`;
}

export function parseCodePrincipal(principal: string): CodeIdentity | null {
  if (!principal.startsWith("code:")) return null;
  const body = principal.slice("code:".length);
  const separator = body.lastIndexOf("@");
  if (separator <= 0 || separator === body.length - 1) return null;
  return {
    repoPath: body.slice(0, separator),
    effectiveVersion: body.slice(separator + 1),
  };
}

export function isCodePrincipal(principal: string): principal is CodePrincipal {
  return parseCodePrincipal(principal) !== null;
}

/** True when a principal names this exact unit version. */
export function codePrincipalMatches(principal: string, identity: CodeIdentity): boolean {
  const parsed = parseCodePrincipal(principal);
  return (
    parsed !== null &&
    parsed.repoPath === identity.repoPath &&
    parsed.effectiveVersion === identity.effectiveVersion
  );
}
