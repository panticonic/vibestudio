/**
 * Round-robin fair writer with bounded queues (plan §1.3 / §1.4) — the ONE
 * send-side scheduler both pipe ends use, for both channels:
 *
 * - bulk: keys are stream ids; parts are complete mux messages
 *   (`protocol/bulkMux.ts`), so one stream's transfer stalls another by at most
 *   one message (~16–256 KB), never one transfer.
 * - control: keys are session ids; parts are the fragment set of one control
 *   frame (`controlFraming.ts` — fragment sets are keyed by frameId, so
 *   interleaving fragment sets across sessions is already legal on the wire).
 *
 * It replaces the single FIFO write chains (`bulkWriteChain` /
 * `controlWriteChain`): those serialized every stream and session behind one
 * promise chain, unbounded. Here each key gets its own FIFO queue and the pump
 * round-robins ACROSS keys at part granularity.
 *
 * ### Backpressure (both caps, awaited)
 * `enqueue` resolves-to-accept only under a per-key cap (default 2 MiB) and a
 * total cap (default 32 MiB): a full queue makes the producer's `await` pause,
 * which propagates up to its `reader.read()` loop. Waiters are admitted FIFO
 * as bytes drain — strictly FIFO against the *total* cap (a big enqueue is not
 * starved by later small ones), while a waiter blocked only on its own
 * *per-key* cap is skipped so one flooding key never blocks the others. A
 * batch larger than a cap is admitted when its scope is empty (otherwise it
 * could never be accepted at all).
 *
 * ### Failure = settle, never reject
 * Enqueue promises SETTLE (resolve) when the scheduler or key is dropped, or
 * the channel is not open — the transport's pipe-down path is the failure
 * signal, not per-write rejections (writers are deep in stream pumps that must
 * simply stop). On channel-not-open the pump settles ALL queued work and
 * waiters and idles: the transport creates one scheduler per pipe generation
 * and resets/re-creates it on reconnect, so queued bytes never leak across
 * generations; the scheduler keeps accepting enqueues for the next generation.
 *
 * The settled value carries the batch's OUTCOME: `'flushed'` = every part was
 * handed to the channel; `'dropped'` = at least one part never reached the
 * wire (settleAll on pipe-down/close, or dropKey). The distinction lets the
 * transport re-drive never-delivered control frames after a clean reconnect
 * (§3.4 — a partially-sent fragment set counts as dropped too: the peer's
 * defragmenter reset discards it, so nothing was delivered). Failure is still
 * a RESOLUTION, never a rejection.
 */

import type { RtcDataChannelLike } from "./webrtcPeer.js";
import { awaitDrain } from "./channelIo.js";

export const DEFAULT_PER_KEY_CAP_BYTES = 2 * 1024 * 1024;
export const DEFAULT_TOTAL_CAP_BYTES = 32 * 1024 * 1024;

/** How an enqueue settled: `'flushed'` = every part handed to the channel;
 * `'dropped'` = some part never sent (pipe-down settleAll / dropKey / close). */
export type EnqueueOutcome = "flushed" | "dropped";

export interface FrameScheduler {
  /**
   * Enqueue the parts (each part = one channel message, already sized under
   * the negotiated chunk limit) for `key`. Parts of one enqueue keep their
   * relative order and per-key FIFO holds, but the scheduler round-robins
   * ACROSS keys at part granularity. Resolves `'flushed'` once every part has
   * been handed to the channel (after drain), or `'dropped'` once the
   * scheduler/key is dropped with parts unsent (settle, never reject — the
   * transport's pipe-down path is the failure signal).
   */
  enqueue(key: string | number, parts: Uint8Array[]): Promise<EnqueueOutcome>;
  /** Discard everything queued for a key (stream cancelled); settles its
   * enqueue promises, including any still awaiting capacity. */
  dropKey(key: string | number): void;
  /** Bytes accepted but not yet written — total, or for one key
   * (backpressure metering, e.g. the shim's `bufferedAmount` accounting). */
  pendingBytes(key?: string | number): number;
  /** Settle everything and stop the pump permanently. */
  close(): void;
}

type SchedulerKey = string | number;

/** One accepted enqueue: its remaining parts plus its settle callback. */
interface Batch {
  parts: Uint8Array[];
  /** Index of the next part to send. */
  next: number;
  resolve: (outcome: EnqueueOutcome) => void;
}

interface KeyQueue {
  /** FIFO of accepted enqueues for this key. */
  batches: Batch[];
  /** Accepted-but-unsent bytes for this key. */
  bytes: number;
}

/** An enqueue still awaiting capacity (not yet counted in pendingBytes). */
interface Waiter {
  key: SchedulerKey;
  parts: Uint8Array[];
  bytes: number;
  resolve: (outcome: EnqueueOutcome) => void;
}

export function createFrameScheduler(options: {
  /** Called fresh each pump iteration — the transport swaps channels across
   * reconnects; a null/closed channel settles queued work instead of wedging. */
  getChannel: () => RtcDataChannelLike | null;
  perKeyCapBytes?: number;
  totalCapBytes?: number;
}): FrameScheduler {
  const perKeyCap = options.perKeyCapBytes ?? DEFAULT_PER_KEY_CAP_BYTES;
  const totalCap = options.totalCapBytes ?? DEFAULT_TOTAL_CAP_BYTES;

  const queues = new Map<SchedulerKey, KeyQueue>();
  /** Round-robin rotation ring of keys with queued parts (each key at most once). */
  const ring: SchedulerKey[] = [];
  /** Enqueues awaiting capacity, FIFO. */
  let waiters: Waiter[] = [];
  let totalBytes = 0;
  let closed = false;
  let pumping = false;

  const removeFromRing = (key: SchedulerKey): void => {
    const at = ring.indexOf(key);
    if (at >= 0) ring.splice(at, 1);
  };

  /** Settle every accepted batch and every capacity waiter (channel gone /
   * scheduler closed). Leaves the scheduler empty but usable (unless closed).
   * Everything still queued here — including a batch with SOME parts sent —
   * settles `'dropped'`: an incomplete fragment set is discarded by the peer's
   * defragmenter reset on reconnect, so nothing of it was delivered. */
  const settleAll = (): void => {
    const settledQueues = [...queues.values()];
    const settledWaiters = waiters;
    queues.clear();
    ring.length = 0;
    waiters = [];
    totalBytes = 0;
    for (const q of settledQueues) for (const batch of q.batches) batch.resolve("dropped");
    for (const w of settledWaiters) w.resolve("dropped");
  };

  /** Accept a waiter: move its bytes into the accounted queues + ring. */
  const accept = (w: Waiter): void => {
    let q = queues.get(w.key);
    if (!q) {
      q = { batches: [], bytes: 0 };
      queues.set(w.key, q);
    }
    const hadParts = q.batches.length > 0;
    q.batches.push({ parts: w.parts, next: 0, resolve: w.resolve });
    q.bytes += w.bytes;
    totalBytes += w.bytes;
    if (!hadParts) ring.push(w.key);
    void pump();
  };

  /**
   * Admit capacity waiters FIFO. Strict FIFO against the total cap; a waiter
   * blocked only by its per-key cap is skipped so other keys proceed, but later
   * waiters for that SAME key remain blocked behind it to preserve per-key FIFO.
   */
  const admitWaiters = (): void => {
    const blockedKeys = new Set<SchedulerKey>();
    for (let i = 0; i < waiters.length; ) {
      const w = waiters[i]!;
      if (blockedKeys.has(w.key)) {
        i++;
        continue;
      }
      // Oversized batches are admitted into an empty scope — otherwise they
      // could never be accepted and the producer would wedge forever.
      if (totalBytes > 0 && totalBytes + w.bytes > totalCap) return;
      const keyBytes = queues.get(w.key)?.bytes ?? 0;
      if (keyBytes > 0 && keyBytes + w.bytes > perKeyCap) {
        blockedKeys.add(w.key);
        i++;
        continue;
      }
      waiters.splice(i, 1);
      accept(w);
    }
  };

  /**
   * The single pump loop: one part per iteration, round-robin across keys,
   * drain-aware. Exits when idle (restarted by the next accept) or when the
   * channel is unusable (after settling everything).
   */
  const pump = async (): Promise<void> => {
    if (pumping) return;
    pumping = true;
    try {
      while (!closed) {
        const key = ring.shift();
        if (key === undefined) return; // idle — next accept restarts the pump
        const q = queues.get(key);
        if (!q || q.batches.length === 0) continue; // dropped between turns
        const channel = options.getChannel();
        if (!channel || channel.readyState !== "open") {
          settleAll();
          return;
        }
        await awaitDrain(channel);
        if (closed) return; // close() during the drain already settled everything
        if (channel.readyState !== "open") {
          settleAll();
          return;
        }
        // Re-resolve after the await: dropKey() may have discarded this queue.
        const live = queues.get(key);
        if (!live || live.batches.length === 0) continue;
        const batch = live.batches[0]!;
        const part = batch.parts[batch.next]!;
        try {
          channel.send(part);
        } catch {
          // send() threw = the channel died under us; identical to not-open.
          settleAll();
          return;
        }
        batch.next += 1;
        live.bytes -= part.byteLength;
        totalBytes -= part.byteLength;
        if (batch.next >= batch.parts.length) {
          live.batches.shift();
          batch.resolve("flushed"); // resolves only after the batch's LAST part is sent
        }
        if (live.batches.length > 0) ring.push(key);
        else queues.delete(key);
        admitWaiters(); // bytes drained — capacity may have opened up
      }
    } finally {
      pumping = false;
    }
  };

  return {
    enqueue(key: SchedulerKey, parts: Uint8Array[]): Promise<EnqueueOutcome> {
      // Settled schedulers and empty enqueues settle immediately (never reject):
      // closed = dropped (nothing will ever send); empty = vacuously flushed.
      if (closed) return Promise.resolve("dropped");
      if (parts.length === 0) return Promise.resolve("flushed");
      let bytes = 0;
      for (const part of parts) bytes += part.byteLength;
      return new Promise<EnqueueOutcome>((resolve) => {
        waiters.push({ key, parts, bytes, resolve });
        admitWaiters();
      });
    },

    dropKey(key: SchedulerKey): void {
      const q = queues.get(key);
      if (q) {
        queues.delete(key);
        removeFromRing(key);
        totalBytes -= q.bytes;
        for (const batch of q.batches) batch.resolve("dropped");
      }
      // Also settle enqueues for this key still awaiting capacity — a producer
      // parked on a cancelled stream must not wedge.
      const dropped = waiters.filter((w) => w.key === key);
      if (dropped.length > 0) waiters = waiters.filter((w) => w.key !== key);
      for (const w of dropped) w.resolve("dropped");
      admitWaiters(); // freed capacity may admit other keys' waiters
    },

    pendingBytes(key?: SchedulerKey): number {
      if (key === undefined) return totalBytes;
      return queues.get(key)?.bytes ?? 0;
    },

    close(): void {
      if (closed) return;
      closed = true;
      settleAll();
    },
  };
}
