/**
 * serverLog service — read-only inspection + live streaming of the server
 * host's own log stream (see serverLogStore.ts for capture semantics).
 *
 * Streaming: appended records are batched (~100 ms) and emitted as the
 * `server-log:append` event, so any events-capable caller (panel, worker,
 * DO, shell) can live-tail with `events.watch(["server-log:append"])`.
 */

import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { serverLogMethods } from "@vibestudio/service-schemas/serverLog";
import type { EventService } from "@vibestudio/shared/eventsService";
import type { ContextIngestionRecorder } from "./contextIntegrityStore.js";
import type { ServerLogRecord, ServerLogStore } from "./serverLogStore.js";

const STREAM_BATCH_MS = 100;
const STREAM_BATCH_MAX = 200;

export function createServerLogService(deps: {
  store: ServerLogStore;
  eventService: EventService;
  workspaceId: string;
  serverBootId: string;
  startedAt: number;
  recordContextIngestion?: ContextIngestionRecorder;
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
    authority: { principals: ["user", "code", "host"] },
    methods: serverLogMethods,
    handler: defineServiceHandler("serverLog", serverLogMethods, {
      query: async (ctx, [query]) => {
        const result = envelope(deps.store.query(query ?? {}));
        if (result.records.length > 0) {
          await deps.recordContextIngestion?.(ctx, {
            key: "log:server",
            via: "server-log:query",
            classification: "external",
          });
        }
        return result;
      },
      tail: async (ctx, [limit]) => {
        const result = envelope(deps.store.tail(limit));
        if (result.records.length > 0) {
          await deps.recordContextIngestion?.(ctx, {
            key: "log:server",
            via: "server-log:tail",
            classification: "external",
          });
        }
        return result;
      },
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
