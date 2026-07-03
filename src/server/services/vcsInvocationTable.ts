/**
 * Host-side VCS invocation-token table (narrow-host-vcs §4).
 *
 * When the host dispatches a userland `vcs.*` call to the gad-store DO it mints
 * a fresh, opaque correlation nonce and records the ORIGINATING verified caller
 * against it. The DO threads that nonce back into its resulting
 * `refs.updateMains` (and may include it in `build.validate` for attribution);
 * the host resolves the nonce against THIS table to recover the originating
 * principal for the approval gate's on-behalf-of attribution.
 *
 * The token is NOT a credential. It is a handle to a host-side record; the DO
 * cannot use it to authenticate as anyone, and it resolves an identity only by
 * lookup here — the DO influences whether a token is presented, never what it
 * maps to. A token is valid only while its originating dispatch is in flight
 * (including a deferred/held completion); once the dispatch resolves the entry
 * is cleared, so post-completion replay resolves to nothing and fails closed.
 */

import { randomUUID } from "node:crypto";
import type { VerifiedCaller } from "@vibez1/shared/serviceDispatcher";

export interface VcsInvocationRecord {
  token: string;
  /** The originating principal the approval gate attributes to (may itself
   *  carry an upstream chain caller). Resolved by the host, never asserted. */
  caller: VerifiedCaller;
  /** DO identity the dispatch was routed through (for "via" prompt copy). */
  via: string;
  method: string;
  requestId?: string;
  createdAt: number;
}

export class VcsInvocationTable {
  private active = new Map<string, VcsInvocationRecord>();

  /**
   * Mint a fresh nonce for ONE host→vcs-DO dispatch, recording the originating
   * caller. Returns the token to thread to the DO and a `release` to clear the
   * record when the dispatch (including deferred completion) finishes. The
   * token may be presented on multiple `updateMains` attempts within the
   * window (CAS-retry); every attempt independently passes the full gate, so
   * multi-presentation adds no authority.
   */
  mint(input: { caller: VerifiedCaller; via: string; method: string; requestId?: string }): {
    token: string;
    release: () => void;
  } {
    const token = randomUUID();
    this.active.set(token, {
      token,
      caller: input.caller,
      via: input.via,
      method: input.method,
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      createdAt: Date.now(),
    });
    return { token, release: () => this.active.delete(token) };
  }

  /** Resolve a presented token to its record, or null (invalid/expired/foreign
   *  → the caller fails closed). */
  resolve(token: string): VcsInvocationRecord | null {
    return this.active.get(token) ?? null;
  }

  /** Test/introspection: number of in-flight records. */
  size(): number {
    return this.active.size;
  }
}
