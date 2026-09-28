import { parentPort, workerData } from "node:worker_threads";
import { FiltersEngine } from "@ghostery/adblocker";
import fetch from "cross-fetch";

// Fetch, parse, compress and serialize away from Electron's input/render thread.
// Matching stays synchronous in the native request callback using the resulting engine.
void FiltersEngine.fromLists(fetch, workerData as string[], { enableCompression: true }).then(
  (engine) => {
    const bytes = new Uint8Array(engine.serialize());
    parentPort!.postMessage(bytes, [bytes.buffer]);
  }
);
