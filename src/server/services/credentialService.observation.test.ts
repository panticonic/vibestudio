import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { describe, expect, it } from "vitest";
import { createCredentialService } from "./credentialService.js";

const caller = createVerifiedCaller("worker:setup", "worker");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function serviceWithObservers(
  credentialObserve: (options: {
    afterVersion?: string;
    signal?: AbortSignal;
  }) => Promise<{ version: string }>,
  configObserve: (options: {
    afterVersion?: string;
    signal?: AbortSignal;
  }) => Promise<{ version: string }>
) {
  return createCredentialService({
    credentialStore: { observeChanges: credentialObserve } as never,
    clientConfigStore: { observeChanges: configObserve } as never,
  });
}

describe("credentialService setup observation", () => {
  it("joins both owner observations and preserves a peer cleanup failure", async () => {
    const config = deferred<{ version: string }>();
    let configSignal: AbortSignal | undefined;
    const service = serviceWithObservers(
      async () => ({ version: "credential-2" }),
      ({ signal }) => {
        configSignal = signal;
        return config.promise;
      }
    );

    const result = service.handler({ caller }, "observeChanges", [
      { afterVersion: JSON.stringify(["credential-1", "config-1"]) },
    ]);
    const cleanupFailure = new Error("config observer failed while closing");
    configSignal?.addEventListener("abort", () => config.reject(cleanupFailure), { once: true });

    await expect(result).rejects.toBe(cleanupFailure);
    expect(configSignal?.aborted).toBe(true);
  });

  it("does not treat an independently cancelled owner as aggregate cleanup", async () => {
    const independent = Object.assign(new Error("credential owner disconnected"), {
      code: "RPC_ABORTED",
    });
    const config = deferred<{ version: string }>();
    const service = serviceWithObservers(
      async () => {
        throw independent;
      },
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        })
    );

    await expect(
      service.handler({ caller }, "observeChanges", [
        { afterVersion: JSON.stringify(["credential-1", "config-1"]) },
      ])
    ).rejects.toBe(independent);
    config.resolve({ version: "unused" });
  });
});

it("preserves an owner rejection whose original reason is undefined", async () => {
  const service = serviceWithObservers(
    async () => {
      throw undefined;
    },
    ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      })
  );
  await expect(service.handler({ caller }, "observeChanges", [{}])).rejects.toBeUndefined();
});

it("preserves an undefined peer failure after another owner changes", async () => {
  const service = serviceWithObservers(
    async () => ({ version: "credential-2" }),
    ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(undefined), { once: true });
      })
  );
  await expect(
    service.handler({ caller }, "observeChanges", [
      { afterVersion: JSON.stringify(["credential-1", "config-1"]) },
    ])
  ).rejects.toBeUndefined();
});
