/**
 * serverLog service — read-only inspection + live streaming of the server
 * host's own log stream (see serverLogStore.ts for capture semantics).
 *
 * Streaming: appended records are batched (~100 ms) and emitted as the
 * `server-log:append` event, so any events-capable caller (panel, worker,
 * DO, shell) can live-tail with `events.subscribe("server-log:append")`.
 */

import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { serverLogMethods } from "@vibestudio/service-schemas/serverLog";
import type { EventService } from "@vibestudio/shared/eventsService";
import type { ServerLogRecord, ServerLogStore } from "./serverLogStore.js";

const STREAM_BATCH_MS = 100;
const STREAM_BATCH_MAX = 200;

export function createServerLogService(deps: {
  store: ServerLogStore;
  eventService: EventService;
  workspaceId: string;
  serverBootId: string;
  startedAt: number;
}): ServiceDefinition & { stop: () => void } {
  // Batch appended records so a chatty burst becomes one event frame.
  let pending: ServerLogRecord[] = [];
  let flushTimer: NodeJS.Timeout | null = null;
  const flush = () => {
    flushTimer = null;
    if (pending.length === 0) return;
    const records = pending;
    pending = [];
    deps.eventService.emit("server-log:append", { records });
  };
  const offAppend = deps.store.onAppend((record) => {
    pending.push(record);
    if (pending.length >= STREAM_BATCH_MAX) {
      if (flushTimer) clearTimeout(flushTimer);
      flush();
      return;
    }
    if (!flushTimer) {
      flushTimer = setTimeout(flush, STREAM_BATCH_MS);
      flushTimer.unref?.();
    }
  });

  const envelope = (result: { records: ServerLogRecord[]; latestSeq: number }) => ({
    ...result,
    workspaceId: deps.workspaceId,
    serverBootId: deps.serverBootId,
    pid: process.pid,
    startedAt: deps.startedAt,
  });

  const definition: ServiceDefinition = {
    name: "serverLog",
    description: "Server host log inspection and live tailing",
    // serverLog exposes only read methods (query/tail/stats), so the service-level
    // `agent` grant is read-only in practice.
    policy: { allowed: ["shell", "app", "panel", "server", "worker", "do", "extension", "agent"] },
    methods: serverLogMethods,
    handler: defineServiceHandler("serverLog", serverLogMethods, {
      query: (_ctx, [query]) => envelope(deps.store.query(query ?? {})),
      tail: (_ctx, [limit]) => envelope(deps.store.tail(limit)),
      stats: () => deps.store.stats(),
    }),
  };
  return Object.assign(definition, {
    stop: () => {
      offAppend();
      if (flushTimer) clearTimeout(flushTimer);
    },
  });
}
