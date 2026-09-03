import type { TaskGrantPrincipal } from "@vibestudio/rpc";
import type { DORef } from "@vibestudio/shared/doDispatcher";
import type { TaskAuthorityRegistry } from "./taskAuthorityRegistry.js";

export interface TaskTitleDispatch {
  dispatch(ref: DORef, method: string, ...args: unknown[]): Promise<unknown>;
}

/** Resolve a task's durable channel title from its authenticated binding. */
export function createTaskTitleResolver(deps: {
  taskAuthorities: TaskAuthorityRegistry;
  getDispatch: () => TaskTitleDispatch | null;
}): (taskSubject: string) => Promise<string | null> {
  return async (taskSubject) => {
    if (!taskSubject.startsWith("task:")) return null;
    const binding = deps.taskAuthorities.bindingFor(taskSubject as TaskGrantPrincipal);
    const dispatch = deps.getDispatch();
    if (!binding || !dispatch) return null;
    const channel: DORef = {
      source: "workers/pubsub-channel",
      className: "PubSubChannel",
      objectKey: binding.channelId,
    };
    const [contextId, config] = await Promise.all([
      dispatch.dispatch(channel, "getContextId"),
      dispatch.dispatch(channel, "getConfig"),
    ]);
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
