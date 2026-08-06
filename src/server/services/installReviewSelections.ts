/**
 * What the user checked, from the review that accepted it to the admission that
 * mints it (docs/template-install-unit-approval-ux-plan.md §7.2, §8).
 *
 * A review is resolved on one surface and applied on another: the approval queue
 * settles the decision, then whichever provider owns the units records their
 * admission. The selection has to survive that hand-off without either side
 * having to know about the other, and it has to be keyed by something exact.
 *
 * Identity keys are exactly that: one key per unit per exact version and
 * manifest, minted by the provider that offered the review. So a selection can
 * only ever be applied to the units it was actually made about — a stale key
 * matches nothing rather than something adjacent.
 *
 * Read once and consumed: an acceptance is a single decision, not a standing
 * preference. Nothing recorded for a unit does NOT mean "allow everything" — it
 * means "this decision was not asked about that unit", and acceptance resolves
 * it from the unit's own history: a first arrival gets everything its manifest
 * makes clearable ("one click adds the complete slate"), while a unit that has a
 * previously admitted version carries that version's clearance forward, so an
 * EV-only update cannot silently undo a permission the user declined (§7.3).
 */
export class InstallReviewSelectionStore {
  private readonly selections = new Map<string, readonly string[]>();
  private readonly revisions = new Map<string, number>();
  private revision = 0;

  /** Record what an accepted review allowed now, per unit identity key. */
  record(entries: Iterable<readonly [string, readonly string[]]>): void {
    for (const [identityKey, rowKeys] of entries) {
      this.selections.set(identityKey, rowKeys);
      this.revisions.set(identityKey, ++this.revision);
    }
  }

  /**
   * Lease selections to one admission transaction. They disappear from the
   * available set immediately, return on failure, and are discarded only when
   * the caller commits. A newer decision always wins over an older lease's
   * rollback.
   */
  leaseMany(identityKeys: Iterable<string>): InstallReviewSelectionLease {
    const leased = new Map<string, readonly string[]>();
    const leaseRevisions = new Map<string, number>();
    for (const key of new Set(identityKeys)) {
      const selection = this.selections.get(key);
      // No available selection means either no review answered this key or a
      // different transaction already holds it. Observing that absence must
      // not supersede the holder: otherwise a second lease could prevent the
      // first transaction from restoring its selection after failure.
      if (selection === undefined) continue;
      leased.set(key, selection);
      this.selections.delete(key);
      const revision = ++this.revision;
      this.revisions.set(key, revision);
      leaseRevisions.set(key, revision);
    }
    let settled = false;
    return {
      selections: leased,
      committed: () => {
        settled = true;
      },
      failed: () => {
        if (settled) return;
        for (const [key, selection] of leased) {
          if (this.revisions.get(key) !== leaseRevisions.get(key)) continue;
          this.selections.set(key, selection);
          this.revisions.set(key, ++this.revision);
        }
        settled = true;
      },
    };
  }

  /** Drop a cancelled review's selection so it can never apply later. */
  discard(identityKeys: Iterable<string>): void {
    for (const key of identityKeys) {
      this.selections.delete(key);
      this.revisions.set(key, ++this.revision);
    }
  }
}

export interface InstallReviewSelectionLease {
  readonly selections: ReadonlyMap<string, readonly string[]>;
  committed(): void;
  failed(): void;
}
