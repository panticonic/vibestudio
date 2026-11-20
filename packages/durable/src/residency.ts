/**
 * celld residency holds (`docs/services/residency.md` of the fork): an object
 * whose in-memory state cannot be rebuilt from storage (a live JavaScript
 * heap) keeps itself resident until its owner ends the hold. celld never ends
 * a hold by a timer or to make room; it ends them on a drain, a generation
 * swap or an operator revocation, and tells the object first (`onrevoked`).
 *
 * Present on `ctx.residency` of a class the deployment declares
 * (`celld.durable_objects.<Class>.residency`) and of a loaded worker whose
 * loader granted `celld: { residency: true }`.
 */
export type ResidencyRevocationReason = "drain" | "swap" | "operator" | (string & {});

export interface ResidencyHandle {
  /** Ends this hold. Idempotent. */
  release(): void;
  /** Resolves when the hold ends: `"released"`, the node's reason, or `"stopped"`. */
  readonly released: Promise<{ reason: string }>;
  readonly isReleased: boolean;
  readonly revokedReason: string | null;
  /** Called by the node before it takes the object away; persist what must survive. */
  onrevoked: ((event: { reason: ResidencyRevocationReason }) => void | Promise<void>) | null;
}

export interface ResidencyContext {
  readonly enabled: boolean;
  /**
   * Rejects with a `ResidencyError` carrying a stable `code`
   * (`ERR_RESIDENCY_BUDGET`, `ERR_RESIDENCY_LEAVING`, `ERR_RESIDENCY_NOT_DECLARED`, ...).
   */
  hold(): Promise<ResidencyHandle>;
}
