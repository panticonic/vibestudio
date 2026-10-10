import { canonicalJson } from "@vibestudio/shared/canonicalJson";
import type { DORef, HeldDoDispatcher } from "@vibestudio/shared/doDispatcher";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import { durableWorkOwnerMethods } from "@vibestudio/service-schemas/durableWorkOwner";
import type { DurableWorkReadyHint, DurableWorkReleaseStage } from "@vibestudio/shared/durableWork";

/** Capture first, schedule the exact queues, then join the captured owner frontier. */
export async function prepareDurableWorkOwnerRelease(
  owner: DORef,
  dispatch: HeldDoDispatcher,
  notify: (hint: DurableWorkReadyHint) => void,
  stage: DurableWorkReleaseStage,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted();
  const client = createTypedServiceClient(
    "durable-work-owner",
    durableWorkOwnerMethods,
    (_service, method, args) =>
      signal
        ? dispatch.dispatchHeldWithSignal(owner, signal, method, ...args)
        : dispatch.dispatch(owner, method, ...args)
  );
  const receipt = await client.prepareDurableWorkRelease(stage);
  signal?.throwIfAborted();
  notify({ owner, queues: receipt.queues });
  const wait = createTypedServiceClient(
    "durable-work-owner",
    durableWorkOwnerMethods,
    (_service, method, args) =>
      signal
        ? dispatch.dispatchHeldWithSignal(owner, signal, method, ...args)
        : dispatch.dispatchHeld(owner, method, ...args)
  );
  await wait.waitDurableWorkRelease(stage, receipt.barrier);
}

/** Close the admitted causal delivery graph while every receiver still accepts
 * its descendants. A new round is required only by a changed owner frontier. */
export async function drainDurableWorkDeliveryClosure(
  owners: readonly DORef[],
  dispatch: HeldDoDispatcher,
  notify: (hint: DurableWorkReadyHint) => void,
  signal?: AbortSignal
): Promise<void> {
  const scope = new AbortController();
  const cancelFromCaller = () => scope.abort(signal!.reason);
  if (signal?.aborted) cancelFromCaller();
  else signal?.addEventListener("abort", cancelFromCaller, { once: true });
  const siblingCancellation = new Error("Delivery closure cancelled after its original failure");
  let originalFailure: unknown;
  let failed = false;
  try {
    const capture = async () => {
      signal?.throwIfAborted();
      const results = await Promise.allSettled(
        owners.map(async (owner) => {
          try {
            scope.signal.throwIfAborted();
            return await createTypedServiceClient(
              "durable-work-owner",
              durableWorkOwnerMethods,
              (_service, method, args) =>
                dispatch.dispatchHeldWithSignal(owner, scope.signal, method, ...args)
            ).prepareDurableWorkRelease("delivery");
          } catch (error) {
            if (!scope.signal.aborted) {
              originalFailure = error;
              failed = true;
              scope.abort(siblingCancellation);
            }
            throw error;
          }
        })
      );
      const failures = results.flatMap((result) =>
        result.status === "rejected" && result.reason !== siblingCancellation ? [result.reason] : []
      );
      if (failed) {
        const index = failures.indexOf(originalFailure);
        if (index >= 0) failures.splice(index, 1);
        failures.unshift(originalFailure);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length)
        throw new AggregateError(failures, "Delivery frontier capture failed", {
          cause: failures[0],
        });
      return results.map((result) => {
        if (result.status !== "fulfilled") throw new Error("Missing captured delivery receipt");
        return result.value;
      });
    };
    let receipts = await capture();
    for (;;) {
      signal?.throwIfAborted();
      const waits = await Promise.allSettled(
        receipts.map(async (receipt, index) => {
          try {
            scope.signal.throwIfAborted();
            const owner = owners[index]!;
            notify({ owner, queues: receipt.queues });
            await createTypedServiceClient(
              "durable-work-owner",
              durableWorkOwnerMethods,
              (_service, method, args) =>
                dispatch.dispatchHeldWithSignal(owner, scope.signal, method, ...args)
            ).waitDurableWorkRelease("delivery", receipt.barrier);
          } catch (error) {
            if (!scope.signal.aborted) {
              originalFailure = error;
              failed = true;
              scope.abort(siblingCancellation);
            }
            throw error;
          }
        })
      );
      const failures = waits.flatMap((result) =>
        result.status === "rejected" && result.reason !== siblingCancellation ? [result.reason] : []
      );
      if (failed) {
        const originalIndex = failures.indexOf(originalFailure);
        if (originalIndex >= 0) failures.splice(originalIndex, 1);
        failures.unshift(originalFailure);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length)
        throw new AggregateError(failures, "Delivery closure failed", { cause: failures[0] });
      const next = await capture();
      if (
        receipts.every(
          (receipt, index) => canonicalJson(receipt.barrier) === canonicalJson(next[index]!.barrier)
        )
      )
        return;
      receipts = next;
    }
  } finally {
    signal?.removeEventListener("abort", cancelFromCaller);
  }
}
