import { Worker } from "node:worker_threads";
import path from "node:path";
import { getPhysicalPathForAsarPath } from "@vibestudio/shared/runtimePaths";

/** One build owns one worker, which is retired on success and every failure. */
export async function buildFilterEngine(lists: readonly string[]): Promise<Uint8Array> {
  const worker = new Worker(
    getPhysicalPathForAsarPath(path.join(__dirname, "adblock-engine-worker.cjs")),
    {
      workerData: [...lists],
    }
  );
  try {
    return await new Promise<Uint8Array>((resolve, reject) => {
      worker.once("message", (bytes: Uint8Array) => resolve(bytes));
      worker.once("error", reject);
      worker.once("exit", (code) =>
        reject(new Error(`Filter engine worker exited before delivery (${code})`))
      );
    });
  } finally {
    await worker.terminate();
  }
}
