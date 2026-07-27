function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  const canonical: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    if (record[key] !== undefined) {
      canonical[key] = canonicalize(record[key]);
    }
  }
  return canonical;
}

/**
 * Declaration reconciliation is driven by declaration changes. Source and
 * dependency changes have their own build-system event path and must not be
 * inferred from unrelated workspace-config publications.
 */
export function workspaceUnitDeclarationFingerprint(declarations: readonly unknown[]): string {
  return JSON.stringify(canonicalize(declarations));
}

/**
 * Tracks the declaration set successfully applied to a host. Failed attempts do
 * not advance the fingerprint, so a later publication of the same declarations
 * remains eligible for reconciliation.
 */
export class AppliedWorkspaceUnitDeclarations {
  private fingerprint: string | null = null;
  private latestAttempt = 0;

  matches(fingerprint: string): boolean {
    return this.fingerprint === fingerprint;
  }

  async apply<T>(fingerprint: string, operation: () => T | Promise<T>): Promise<T> {
    const attempt = ++this.latestAttempt;
    const result = await operation();
    if (attempt === this.latestAttempt) {
      this.fingerprint = fingerprint;
    }
    return result;
  }
}
