import type { DORef } from "./doDispatcher.js";

export const DURABLE_WORK_QUEUES = ["channel-delivery", "agent-inbox", "agent-effect"] as const;

export type DurableWorkQueue = (typeof DURABLE_WORK_QUEUES)[number];

export interface DurableWorkRef {
  owner: DORef;
  queue: DurableWorkQueue;
}

export interface WorkClaim<T = unknown> {
  itemId: string;
  generation: number;
  idempotencyKey: string;
  createdAt: number;
  attempt: number;
  payload: T;
}

export type DurableWorkTrigger = "hint" | "recovery" | "continuation";

export interface ClaimRequest {
  workerId: string;
  trigger?: DurableWorkTrigger;
  now: number;
  limit: number;
}

export interface SettleRequest<T = unknown> {
  workerId: string;
  itemId: string;
  generation: number;
  outcome: T;
}

export type ClaimSettlement = "accepted" | "duplicate" | "stale";

export interface DurableWorkReadyHint {
  owner: DORef;
  queues: DurableWorkQueue[];
}

export const DURABLE_WORK_READY_HEADER = "X-Vibestudio-Work-Ready";

export function encodeDurableWorkReady(queues: Iterable<DurableWorkQueue>): string | null {
  const unique = [...new Set(queues)].sort();
  return unique.length === 0 ? null : unique.join(",");
}

export function decodeDurableWorkReady(value: string | null): DurableWorkQueue[] {
  if (!value) return [];
  const allowed = new Set<string>(DURABLE_WORK_QUEUES);
  const queues = value
    .split(",")
    .map((queue) => queue.trim())
    .filter(Boolean);
  if (queues.some((queue) => !allowed.has(queue))) {
    throw new Error(`Invalid durable-work receipt: ${value}`);
  }
  return [...new Set(queues)] as DurableWorkQueue[];
}
