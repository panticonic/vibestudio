import type {
  AuthorityAnalysisEpoch,
  AuthorityDependencyIndex,
} from "./authorityDependencyIndex.js";

/**
 * Owns the analysis pointer separately from the package graph. The manager is
 * deliberately in-memory: after a restart there is no trusted completeness
 * marker, so callers rebuild the exact current-epoch baseline before using
 * incremental selection.
 */
export class AuthorityIndexManager {
  private readonly published = new Map<string, AuthorityDependencyIndex>();
  private readonly pending = new Map<string, AuthorityDependencyIndex>();
  private readonly flights = new Map<string, Promise<AuthorityDependencyIndex>>();
  private readonly analyzed = new Map<string, AuthorityDependencyIndex>();
  private readonly maxEntries: number;

  constructor(maxEntries = 8) {
    this.maxEntries = Math.max(1, maxEntries);
  }

  private epochKey(epoch: AuthorityAnalysisEpoch): string {
    return `${epoch.analyzerVersion}\0${epoch.rpcSchemaVersion}`;
  }

  private touch<T>(map: Map<string, T>, key: string, value: T): void {
    map.delete(key);
    map.set(key, value);
    while (map.size > this.maxEntries) {
      const oldest = map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  /**
   * Coalesce every analysis request for one immutable state and analysis epoch.
   * Successful results remain available as a small LRU; failures are removed
   * immediately so an opportunistic prewarm can never poison later protected
   * publication validation.
   */
  indexAt(
    stateHash: string,
    epoch: AuthorityAnalysisEpoch,
    create: () => Promise<AuthorityDependencyIndex>,
    exactInputDigest?: string
  ): Promise<AuthorityDependencyIndex> {
    const key = exactInputDigest ?? `${stateHash}\0${this.epochKey(epoch)}`;
    const analyzed = this.analyzed.get(key);
    if (analyzed) {
      this.touch(this.analyzed, key, analyzed);
      return Promise.resolve(analyzed);
    }
    const existing = this.flights.get(key);
    if (existing) return existing;

    const flight = create().then(
      (index) => {
        this.flights.delete(key);
        if (index.complete && index.blockingConsumers.size === 0) {
          this.touch(this.analyzed, key, index);
        }
        return index;
      },
      (error: unknown) => {
        this.flights.delete(key);
        throw error;
      }
    );
    this.flights.set(key, flight);
    return flight;
  }

  publishedBaseline(epoch: AuthorityAnalysisEpoch): AuthorityDependencyIndex | null {
    const key = this.epochKey(epoch);
    const index = this.published.get(key);
    if (!index) return null;
    this.touch(this.published, key, index);
    return index;
  }

  establishPublished(index: AuthorityDependencyIndex): void {
    if (!index.complete || index.blockingConsumers.size > 0)
      throw new Error("Cannot establish an incomplete authority baseline");
    this.touch(this.published, this.epochKey(index.epoch), index);
  }

  stageCandidate(index: AuthorityDependencyIndex): void {
    if (!index.complete || index.blockingConsumers.size > 0)
      throw new Error("Cannot stage an incomplete authority index");
    this.touch(this.pending, `${index.stateHash}\0${this.epochKey(index.epoch)}`, index);
  }

  discardCandidate(stateHash: string, epoch: AuthorityAnalysisEpoch): void {
    this.pending.delete(`${stateHash}\0${this.epochKey(epoch)}`);
  }

  promotePublished(stateHash: string, epoch: AuthorityAnalysisEpoch): boolean {
    const pendingKey = `${stateHash}\0${this.epochKey(epoch)}`;
    const index = this.pending.get(pendingKey);
    if (
      !index ||
      !index.complete ||
      index.blockingConsumers.size > 0 ||
      index.stateHash !== stateHash
    )
      return false;
    this.touch(this.published, this.epochKey(epoch), index);
    this.pending.delete(pendingKey);
    return true;
  }
}
