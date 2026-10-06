import { randomUUID } from "node:crypto";
import type { ProcessAdapter } from "./index.js";

const MAX_PENDING = 128;
const MAX_BYTES = 32 * 1024 * 1024;
type Pending = { resolve(value: unknown): void; reject(error: Error): void; dispose(): void };

/** An owner calls an installed worker. Incoming frames can only settle an
 * outstanding operation; they never dispatch a method in the owner. */
export class NativeOperationPort {
  private readonly pending = new Map<string, Pending>();
  private retirementError: Error | null = null;
  private readonly ended = (): void => this.retire();
  constructor(private readonly process: ProcessAdapter) {
    process.on("message", this.receive);
    process.on("exit", this.ended);
    process.on("disconnect", this.ended);
    process.on("error", this.retire);
  }

  call(method: string, args: unknown[], signal?: AbortSignal): Promise<unknown> {
    if (this.retirementError) return Promise.reject(this.retirementError);
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.pending.size >= MAX_PENDING)
      return Promise.reject(new Error("Native operation limit reached"));
    const id = randomUUID();
    const frame = { type: "operation", id, method, args };
    if (
      Buffer.byteLength(JSON.stringify(frame)) > MAX_BYTES ||
      (this.process.bufferedAmount ?? 0) > MAX_BYTES
    )
      return Promise.reject(new Error("Native operation byte limit exceeded"));
    return new Promise((resolve, reject) => {
      const abort = () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.dispose();
        reject(signal?.reason ?? new Error("Native operation cancelled"));
        try {
          this.process.postMessage({ type: "cancel-operation", id });
        } catch (error) {
          this.retire(error instanceof Error ? error : new Error(String(error)));
        }
      };
      this.pending.set(id, {
        resolve,
        reject,
        dispose: () => signal?.removeEventListener("abort", abort),
      });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        this.process.postMessage(frame);
      } catch (error) {
        this.pending.delete(id);
        signal?.removeEventListener("abort", abort);
        reject(error);
        this.retire(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private receive = (frame: unknown): void => {
    if (this.retirementError) return;
    if (!frame || typeof frame !== "object") {
      this.retire();
      return;
    }
    const response = frame as Record<string, unknown>;
    if (response["type"] !== "operation-result" || typeof response["id"] !== "string") {
      this.retire();
      return;
    }
    if (Buffer.byteLength(JSON.stringify(frame)) > MAX_BYTES) {
      this.retire();
      return;
    }
    const pending = this.pending.get(response["id"]);
    // Replies to locally cancelled operations have no authority or effect.
    if (!pending) return;
    this.pending.delete(response["id"]);
    pending.dispose();
    if (response["error"] !== undefined) {
      const error = response["error"] as { message?: unknown; code?: unknown } | null;
      pending.reject(
        Object.assign(
          new Error(typeof error?.message === "string" ? error.message : "Native operation failed"),
          typeof error?.code === "string" ? { code: error.code } : {}
        )
      );
    } else pending.resolve(response["value"]);
  };

  readonly retire = (error = new Error("Native operation port retired")): void => {
    if (this.retirementError) return;
    this.retirementError = error;
    this.process.off("message", this.receive);
    this.process.off("exit", this.ended);
    this.process.off("disconnect", this.ended);
    // Keep the idempotent error consumer until the adapter itself is collected;
    // asynchronous send errors can arrive after logical retirement.
    for (const pending of this.pending.values()) {
      pending.dispose();
      pending.reject(error);
    }
    this.pending.clear();
  };
}
