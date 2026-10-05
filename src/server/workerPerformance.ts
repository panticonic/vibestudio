import { Worker, type WorkerOptions } from "node:worker_threads";
import type { HostWorkerPerformanceSample } from "@vibestudio/service-schemas/hostPerformance";

const workers = new Map<Worker, string>();

/** Register only the exact thread lifetime; exited workers retain no diagnostics state. */
export function createMeasuredWorker(
  label: string,
  entry: string | URL,
  options?: WorkerOptions
): Worker {
  const worker = new Worker(entry, options);
  workers.set(worker, label);
  worker.once("exit", () => workers.delete(worker));
  return worker;
}

export async function workerPerformanceSnapshot(): Promise<HostWorkerPerformanceSample[]> {
  const samples = await Promise.all(
    [...workers].map(async ([worker, label]) => {
      try {
        const heap = await worker.getHeapStatistics();
        return {
          label,
          threadId: worker.threadId,
          heapUsedBytes: heap.used_heap_size,
          heapTotalBytes: heap.total_heap_size,
          externalBytes: heap.external_memory,
        };
      } catch (error) {
        // Exit is authoritative; an inspector failure on a live worker must propagate.
        if (
          !workers.has(worker) ||
          worker.threadId === -1 ||
          (error as NodeJS.ErrnoException).code === "ERR_WORKER_NOT_RUNNING"
        )
          return null;
        throw error;
      }
    })
  );
  return samples.filter(
    (sample): sample is HostWorkerPerformanceSample => sample !== null && sample.threadId >= 0
  );
}
