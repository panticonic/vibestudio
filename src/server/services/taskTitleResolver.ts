import type { TaskGrantPrincipal } from "@vibestudio/rpc";
import type { DORef } from "@vibestudio/shared/doDispatcher";
import type { TaskAuthorityRegistry } from "./taskAuthorityRegistry.js";

export interface TaskTitleDispatch {
  dispatchHeldWithSignal(
    ref: DORef,
    signal: AbortSignal,
    method: string,
    ...args: unknown[]
  ): Promise<unknown>;
}

/** Resolve a task's durable channel title from its authenticated binding. */
export function createTaskTitleResolver(deps: {
  taskAuthorities: TaskAuthorityRegistry;
  getDispatch: () => TaskTitleDispatch | null;
}): (taskSubject: string, signal: AbortSignal) => Promise<string | null> {
  return async (taskSubject, signal) => {
    signal.throwIfAborted();
    if (!taskSubject.startsWith("task:")) return null;
    const binding = deps.taskAuthorities.bindingFor(taskSubject as TaskGrantPrincipal);
    const dispatch = deps.getDispatch();
    if (!binding || !dispatch) return null;
    const channel: DORef = {
      source: "workers/pubsub-channel",
      className: "PubSubChannel",
      objectKey: binding.channelId,
    };
    const reads = new AbortController();
    const readSignal = AbortSignal.any([signal, reads.signal]);
    let failed = false;
    let originalFailure: unknown;
    const read = (method: string) =>
      Promise.resolve()
        .then(() => dispatch.dispatchHeldWithSignal(channel, readSignal, method))
        .catch((error: unknown) => {
          if (!failed) {
            failed = true;
            originalFailure = error;
            reads.abort(error);
          }
          throw error;
        });
    const results = await Promise.allSettled([read("getContextId"), read("getConfig")]);
    signal.throwIfAborted();
    if (failed) throw originalFailure;
    const values = results.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    const [contextId, config] = values;
    if (contextId !== binding.contextId) {
      throw new Error(`Channel ${binding.channelId} does not belong to the bound task context`);
    }
    const title =
      config &&
      typeof config === "object" &&
      typeof (config as { title?: unknown }).title === "string"
        ? (config as { title: string }).title.trim()
        : "";
    return title || null;
  };
}
