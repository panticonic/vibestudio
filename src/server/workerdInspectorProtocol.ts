import { isDeepStrictEqual } from "node:util";

// workerd/io/worker.c++ handles these commands itself and returns the decoded
// command, without a result member, after the operation actually completes.
// Keep this dialect at the workerd boundary; ordinary CDP remains strict.
const EMPTY_ACK_METHODS = new Set([
  "Profiler.enable", "Profiler.start", "Profiler.setSamplingInterval",
  "HeapProfiler.takeHeapSnapshot",
]);
const MAX_PENDING = 256;
const MAX_BYTES = 1024 * 1024;
type Pending = { method: string; params: unknown; bytes: number };
export class WorkerdInspectorProtocol {
  private readonly pending = new Map<number, Pending>();
  private bytes = 0;
  observeCommand(text: string): boolean {
    let value;
    try { value = JSON.parse(text); } catch { return true; }
    if (!value || !Number.isSafeInteger(value.id) || !EMPTY_ACK_METHODS.has(value.method)) return true;
    const bytes = Buffer.byteLength(text, "utf8");
    if (this.pending.has(value.id) || this.pending.size >= MAX_PENDING || this.bytes + bytes > MAX_BYTES) return false;
    this.pending.set(value.id, { method: value.method, params: value.params ?? {}, bytes });
    this.bytes += bytes;
    return true;
  }
  receive(text: string): string {
    let value;
    try { value = JSON.parse(text); } catch { return text; }
    if (!value || !Number.isSafeInteger(value.id)) return text;
    const expected = this.pending.get(value.id);
    if (!expected) return text;
    if ("result" in value || "error" in value) {
      this.remove(value.id, expected);
      return text;
    }
    if (value.method !== expected.method || !isDeepStrictEqual(value.params ?? {}, expected.params) ||
        Object.keys(value).some(key => key !== "id" && key !== "method" && key !== "params")) return text;
    this.remove(value.id, expected);
    return JSON.stringify({ id: value.id, result: {} });
  }
  private remove(id: number, value: Pending) {
    this.pending.delete(id);
    this.bytes -= value.bytes;
  }
  clear() { this.pending.clear(); this.bytes = 0; }
}
