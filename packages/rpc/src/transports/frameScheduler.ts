/**
 * Association-aware writer for every data channel on one WebRTC peer.
 *
 * Separate SCTP streams prevent head-of-line blocking between traffic classes,
 * but they still share one congestion-controlled association. Giving each
 * channel an independent pump lets all of them fill that association at once.
 * This scheduler is the one admission and arbitration point for the association:
 * control (8 shares) > interactive streams (4) > bulk artifacts (1).
 */
import type { RtcDataChannelLike } from "./webrtcPeer.js";

export const DEFAULT_PER_KEY_CAP_BYTES = 2 * 1024 * 1024;
export const DEFAULT_TOTAL_CAP_BYTES = 32 * 1024 * 1024;
export type FrameTrafficClass = "control" | "interactive" | "bulk";
export type EnqueueOutcome = "flushed" | "dropped";

export interface FrameLaneConfig {
  getChannel: () => RtcDataChannelLike | null;
  weight: number;
  beforeSend?: (part: Uint8Array) => void;
  /** Optional AIMD send window, capped by the peer's advertised safe receive window. */
  window?: {
    minBytes: number;
    initialBytes: number;
    maxBytes: () => number;
  };
}
export interface FrameScheduler {
  enqueue(
    trafficClass: FrameTrafficClass,
    key: string | number,
    parts: Uint8Array[]
  ): Promise<EnqueueOutcome>;
  dropKey(trafficClass: FrameTrafficClass, key: string | number): void;
  pendingBytes(trafficClass?: FrameTrafficClass, key?: string | number): number;
  close(): void;
}

type SchedulerKey = string | number;
interface Batch {
  parts: Uint8Array[];
  next: number;
  resolve: (outcome: EnqueueOutcome) => void;
}
interface KeyQueue {
  batches: Batch[];
  bytes: number;
}
interface LaneState {
  config: FrameLaneConfig;
  queues: Map<SchedulerKey, KeyQueue>;
  ring: Array<SchedulerKey | undefined>;
  ringHead: number;
  blockedChannel: RtcDataChannelLike | null;
  offLow: (() => void) | null;
  configuredChannel: RtcDataChannelLike | null;
  windowBytes: number;
  blockedAt: number;
}
interface Waiter {
  trafficClass: FrameTrafficClass;
  key: SchedulerKey;
  parts: Uint8Array[];
  bytes: number;
  resolve: (outcome: EnqueueOutcome) => void;
}

const TRAFFIC_CLASSES: readonly FrameTrafficClass[] = ["control", "interactive", "bulk"];
const MAX_SENDS_PER_TURN = 128;

export function createFrameScheduler(options: {
  lanes: Record<FrameTrafficClass, FrameLaneConfig>;
  perKeyCapBytes?: number;
  totalCapBytes?: number;
}): FrameScheduler {
  const perKeyCap = options.perKeyCapBytes ?? DEFAULT_PER_KEY_CAP_BYTES;
  const totalCap = options.totalCapBytes ?? DEFAULT_TOTAL_CAP_BYTES;
  const lanes = new Map<FrameTrafficClass, LaneState>();
  const weightedOrder: FrameTrafficClass[] = [];
  for (const trafficClass of TRAFFIC_CLASSES) {
    const config = options.lanes[trafficClass];
    if (!Number.isInteger(config.weight) || config.weight <= 0) {
      throw new Error(`Frame scheduler lane ${trafficClass} requires a positive integer weight`);
    }
    lanes.set(trafficClass, {
      config,
      queues: new Map(),
      ring: [],
      ringHead: 0,
      blockedChannel: null,
      offLow: null,
      configuredChannel: null,
      windowBytes: 0,
      blockedAt: 0,
    });
    for (let i = 0; i < config.weight; i++) weightedOrder.push(trafficClass);
  }

  let scheduleCursor = 0;
  let waiters: Waiter[] = [];
  let totalBytes = 0;
  let closed = false;
  let pumpScheduled = false;
  let pumping = false;

  const keyBytes = (trafficClass: FrameTrafficClass, key: SchedulerKey): number =>
    lanes.get(trafficClass)?.queues.get(key)?.bytes ?? 0;
  const schedulePump = (): void => {
    if (closed || pumpScheduled || pumping) return;
    pumpScheduled = true;
    queueMicrotask(pump);
  };
  const compactRing = (lane: LaneState): void => {
    if (lane.ringHead >= 1_024 && lane.ringHead * 2 >= lane.ring.length) {
      lane.ring = lane.ring.slice(lane.ringHead);
      lane.ringHead = 0;
    }
  };
  const takeKey = (lane: LaneState): SchedulerKey | undefined => {
    for (;;) {
      if (lane.ringHead >= lane.ring.length) {
        lane.ring = [];
        lane.ringHead = 0;
        return undefined;
      }
      const key = lane.ring[lane.ringHead];
      lane.ring[lane.ringHead] = undefined;
      lane.ringHead += 1;
      compactRing(lane);
      if (key !== undefined) return key;
    }
  };
  const removeKeyFromRing = (lane: LaneState, key: SchedulerKey): void => {
    const at = lane.ring.indexOf(key, lane.ringHead);
    if (at >= 0) lane.ring[at] = undefined;
  };
  const hasQueuedWork = (lane: LaneState): boolean => lane.queues.size > 0;
  const clearLowWait = (lane: LaneState): void => {
    lane.offLow?.();
    lane.offLow = null;
    lane.blockedChannel = null;
  };
  const configureWindow = (lane: LaneState, channel: RtcDataChannelLike): void => {
    if (lane.configuredChannel === channel) return;
    lane.configuredChannel = channel;
    const policy = lane.config.window;
    if (!policy) return;
    const maximum = Math.max(0, policy.maxBytes());
    lane.windowBytes = Math.min(maximum, Math.max(policy.minBytes, policy.initialBytes));
    channel.bufferedAmountLowThreshold = lane.windowBytes;
  };
  const waitForLow = (lane: LaneState, channel: RtcDataChannelLike): void => {
    if (lane.blockedChannel === channel && lane.offLow) return;
    clearLowWait(lane);
    lane.blockedChannel = channel;
    lane.blockedAt = Date.now();
    lane.offLow = channel.onBufferedAmountLow(() => {
      const blockedFor = Date.now() - lane.blockedAt;
      const policy = lane.config.window;
      if (policy) {
        const maximum = Math.max(0, policy.maxBytes());
        if (blockedFor < 250) {
          lane.windowBytes = Math.min(maximum, lane.windowBytes + 16 * 1024);
        } else if (blockedFor > 1_000) {
          lane.windowBytes = Math.max(
            Math.min(policy.minBytes, maximum),
            Math.floor(lane.windowBytes / 2)
          );
        }
        channel.bufferedAmountLowThreshold = lane.windowBytes;
      }
      clearLowWait(lane);
      schedulePump();
    });
    // bufferedamountlow is an edge; close the subscribe/sample race.
    if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) {
      clearLowWait(lane);
      schedulePump();
    }
  };
  const settleLane = (lane: LaneState): void => {
    clearLowWait(lane);
    const queues = [...lane.queues.values()];
    lane.queues.clear();
    lane.ring = [];
    lane.ringHead = 0;
    for (const queue of queues) {
      totalBytes -= queue.bytes;
      for (const batch of queue.batches) batch.resolve("dropped");
    }
  };
  const settleAll = (): void => {
    for (const lane of lanes.values()) settleLane(lane);
    const pending = waiters;
    waiters = [];
    for (const waiter of pending) waiter.resolve("dropped");
    totalBytes = 0;
  };
  const accept = (waiter: Waiter): void => {
    const lane = lanes.get(waiter.trafficClass)!;
    let queue = lane.queues.get(waiter.key);
    if (!queue) {
      queue = { batches: [], bytes: 0 };
      lane.queues.set(waiter.key, queue);
    }
    const wasEmpty = queue.batches.length === 0;
    queue.batches.push({ parts: waiter.parts, next: 0, resolve: waiter.resolve });
    queue.bytes += waiter.bytes;
    totalBytes += waiter.bytes;
    if (wasEmpty) lane.ring.push(waiter.key);
    schedulePump();
  };
  const admitWaiters = (): void => {
    const blockedKeys = new Set<string>();
    for (let i = 0; i < waiters.length; ) {
      const waiter = waiters[i]!;
      const identity = `${waiter.trafficClass}:${String(waiter.key)}`;
      if (blockedKeys.has(identity)) {
        i += 1;
        continue;
      }
      if (totalBytes > 0 && totalBytes + waiter.bytes > totalCap) return;
      const pendingForKey = keyBytes(waiter.trafficClass, waiter.key);
      if (pendingForKey > 0 && pendingForKey + waiter.bytes > perKeyCap) {
        blockedKeys.add(identity);
        i += 1;
        continue;
      }
      waiters.splice(i, 1);
      accept(waiter);
    }
  };
  const dropKey = (trafficClass: FrameTrafficClass, key: SchedulerKey): void => {
    const lane = lanes.get(trafficClass)!;
    const queue = lane.queues.get(key);
    if (queue) {
      lane.queues.delete(key);
      removeKeyFromRing(lane, key);
      totalBytes -= queue.bytes;
      for (const batch of queue.batches) batch.resolve("dropped");
    }
    const dropped = waiters.filter(
      (waiter) => waiter.trafficClass === trafficClass && waiter.key === key
    );
    if (dropped.length > 0) {
      waiters = waiters.filter(
        (waiter) => waiter.trafficClass !== trafficClass || waiter.key !== key
      );
      for (const waiter of dropped) waiter.resolve("dropped");
    }
    admitWaiters();
  };
  const nextSendable = ():
    | { trafficClass: FrameTrafficClass; lane: LaneState; channel: RtcDataChannelLike }
    | undefined => {
    for (let scanned = 0; scanned < weightedOrder.length; scanned++) {
      const trafficClass = weightedOrder[scheduleCursor]!;
      scheduleCursor = (scheduleCursor + 1) % weightedOrder.length;
      const lane = lanes.get(trafficClass)!;
      if (!hasQueuedWork(lane)) continue;
      const channel = lane.config.getChannel();
      if (!channel || channel.readyState !== "open") {
        // One dead channel condemns the association generation.
        settleAll();
        return undefined;
      }
      configureWindow(lane, channel);
      if (channel.bufferedAmount > channel.bufferedAmountLowThreshold) {
        waitForLow(lane, channel);
        continue;
      }
      clearLowWait(lane);
      return { trafficClass, lane, channel };
    }
    return undefined;
  };
  const pump = (): void => {
    pumpScheduled = false;
    if (closed || pumping) return;
    pumping = true;
    let sent = 0;
    try {
      while (!closed && sent < MAX_SENDS_PER_TURN) {
        const selected = nextSendable();
        if (!selected) return;
        const key = takeKey(selected.lane);
        if (key === undefined) continue;
        const queue = selected.lane.queues.get(key);
        if (!queue || queue.batches.length === 0) continue;
        const batch = queue.batches[0]!;
        const part = batch.parts[batch.next]!;
        try {
          selected.lane.config.beforeSend?.(part);
          selected.channel.send(part);
        } catch {
          if (selected.channel.readyState !== "open") {
            settleAll();
            return;
          }
          dropKey(selected.trafficClass, key);
          continue;
        }
        sent += 1;
        batch.next += 1;
        queue.bytes -= part.byteLength;
        totalBytes -= part.byteLength;
        if (batch.next >= batch.parts.length) {
          queue.batches.shift();
          batch.resolve("flushed");
        }
        if (queue.batches.length > 0) selected.lane.ring.push(key);
        else selected.lane.queues.delete(key);
        admitWaiters();
      }
    } finally {
      pumping = false;
      // A blocked lane is resumed only by its bufferedamountlow edge. Blindly
      // rescheduling while work remains would spin an endless microtask loop
      // and starve the very native event/timer that can drain it.
      if (!closed && sent >= MAX_SENDS_PER_TURN) schedulePump();
    }
  };

  return {
    enqueue(trafficClass, key, parts) {
      if (closed) return Promise.resolve("dropped");
      if (parts.length === 0) return Promise.resolve("flushed");
      const bytes = parts.reduce((sum, part) => sum + part.byteLength, 0);
      return new Promise<EnqueueOutcome>((resolve) => {
        waiters.push({ trafficClass, key, parts, bytes, resolve });
        admitWaiters();
      });
    },
    dropKey,
    pendingBytes(trafficClass, key) {
      if (trafficClass === undefined) return totalBytes;
      const lane = lanes.get(trafficClass)!;
      if (key === undefined) {
        let bytes = 0;
        for (const queue of lane.queues.values()) bytes += queue.bytes;
        return bytes;
      }
      return lane.queues.get(key)?.bytes ?? 0;
    },
    close() {
      if (closed) return;
      closed = true;
      settleAll();
    },
  };
}
