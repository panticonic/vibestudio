import { describe, expect, it, vi } from "vitest";
import { BrowserImportAdmissions } from "./importAdmissions.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("BrowserImportAdmissions", () => {
  it("owns preparation before its first await and shares identical admissions", async () => {
    const admissions = new BrowserImportAdmissions();
    const setup = deferred<string>();
    const prepare = vi.fn(() => setup.promise);
    const starting = admissions.run("user:operation", "inputs", prepare);
    const same = admissions.run("user:operation", "inputs", prepare);
    const waiting = admissions.wait("user:operation");
    let observed = false;
    void waiting.then(() => {
      observed = true;
    });
    await Promise.resolve();
    expect(prepare).toHaveBeenCalledOnce();
    expect(same).toBe(starting);
    expect(observed).toBe(false);
    await expect(admissions.run("user:operation", "different", prepare)).rejects.toThrow(
      "different inputs"
    );
    setup.resolve("accepted");
    await expect(starting).resolves.toBe("accepted");
    await waiting;
    // A finished admission owns no further waits.
    await admissions.wait("user:operation");
  });

  it("propagates the original admission failure to both callers and observers", async () => {
    const admissions = new BrowserImportAdmissions();
    const setup = deferred<void>();
    const error = new Error("Host discovery failed");
    const starting = admissions.run("operation", "inputs", () => setup.promise);
    const waiting = admissions.wait("operation");
    setup.reject(error);
    await expect(starting).rejects.toBe(error);
    await expect(waiting).rejects.toBe(error);
  });

  it("releases an observer on abort without cancelling the initiating operation", async () => {
    const admissions = new BrowserImportAdmissions();
    const setup = deferred<void>();
    const starting = admissions.run("operation", "inputs", () => setup.promise);
    const observation = new AbortController();
    const error = new Error("Panel closed");
    const waiting = admissions.wait("operation", observation.signal);
    observation.abort(error);
    await expect(waiting).rejects.toBe(error);
    setup.resolve();
    await starting;
  });

  it("never invents ownership for unknown IDs or another environment", async () => {
    const admissions = new BrowserImportAdmissions();
    const setup = deferred<void>();
    const starting = admissions.run("user-a:operation", "inputs", () => setup.promise);
    await admissions.wait("unknown");
    await admissions.wait("user-b:operation");
    const observation = new AbortController();
    observation.abort(new Error("Already closed"));
    await expect(admissions.wait("unknown", observation.signal)).rejects.toThrow("Already closed");
    setup.resolve();
    await starting;
  });
});
