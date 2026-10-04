import { describe, expect, it, vi } from "vitest";
import { TaskAuthorityRegistry, taskAuthorityPrincipal } from "./taskAuthorityRegistry.js";
import { createTaskTitleResolver } from "./taskTitleResolver.js";

const binding = {
  workspaceId: "workspace:one",
  contextId: "context:one",
  channelId: "channel:one",
};

describe("createTaskTitleResolver", () => {
  it("reads the durable channel title without a mounted chat panel", async () => {
    const signal = new AbortController().signal;
    const taskAuthorities = new TaskAuthorityRegistry();
    const task = taskAuthorityPrincipal(binding);
    taskAuthorities.bindPrincipal(task, binding);
    const dispatch = vi.fn(async (_ref, _signal: AbortSignal, method: string) =>
      method === "getContextId" ? binding.contextId : { title: "  Trello-style Task Manager  " }
    );

    const resolve = createTaskTitleResolver({
      taskAuthorities,
      getDispatch: () => ({ dispatchHeldWithSignal: dispatch }),
    });

    await expect(resolve(task, signal)).resolves.toBe("Trello-style Task Manager");
    expect(dispatch).toHaveBeenCalledWith(
      {
        source: "workers/pubsub-channel",
        className: "PubSubChannel",
        objectKey: binding.channelId,
      },
      expect.any(AbortSignal),
      "getConfig"
    );
  });

  it("rejects a channel whose durable context does not match the task binding", async () => {
    const signal = new AbortController().signal;
    const taskAuthorities = new TaskAuthorityRegistry();
    const task = taskAuthorityPrincipal(binding);
    taskAuthorities.bindPrincipal(task, binding);
    const resolve = createTaskTitleResolver({
      taskAuthorities,
      getDispatch: () => ({
        dispatchHeldWithSignal: vi.fn(async (_ref, _signal: AbortSignal, method: string) =>
          method === "getContextId" ? "context:other" : { title: "Wrong task" }
        ),
      }),
    });

    await expect(resolve(task, signal)).rejects.toThrow(/does not belong/);
  });
  it("joins both owned title reads before propagating the original failure", async () => {
    const taskAuthorities = new TaskAuthorityRegistry();
    const task = taskAuthorityPrincipal(binding);
    taskAuthorities.bindPrincipal(task, binding);
    const failure = new Error("channel title unavailable");
    let release!: () => void;
    const heldConfig = new Promise<unknown>((resolve) => {
      release = () => resolve({ title: "held" });
    });
    const dispatchHeldWithSignal = vi.fn(async (_ref, _signal, method) => {
      if (method === "getContextId") throw failure;
      return heldConfig;
    });
    const resolve = createTaskTitleResolver({
      taskAuthorities,
      getDispatch: () => ({ dispatchHeldWithSignal }),
    });
    let finished = false;
    const read = resolve(task, new AbortController().signal);
    void read.then(
      () => {
        finished = true;
      },
      () => {
        finished = true;
      }
    );
    await vi.waitFor(() => expect(dispatchHeldWithSignal).toHaveBeenCalledTimes(2));
    expect(finished).toBe(false);
    release();
    await expect(read).rejects.toBe(failure);
  });

  it("passes the owner's cancellation into both dispatches and joins their abort cleanup", async () => {
    const taskAuthorities = new TaskAuthorityRegistry();
    const task = taskAuthorityPrincipal(binding);
    taskAuthorities.bindPrincipal(task, binding);
    const owner = new AbortController();
    const joined: string[] = [];
    const dispatchHeldWithSignal = vi.fn(
      async (_ref, signal: AbortSignal, method: string) =>
        new Promise<unknown>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              joined.push(method);
              reject(signal.reason);
            },
            { once: true }
          );
        })
    );
    const resolve = createTaskTitleResolver({
      taskAuthorities,
      getDispatch: () => ({ dispatchHeldWithSignal }),
    });
    const read = resolve(task, owner.signal);
    await vi.waitFor(() => expect(dispatchHeldWithSignal).toHaveBeenCalledTimes(2));
    const failure = new Error("host stopping");
    owner.abort(failure);
    await expect(read).rejects.toBe(failure);
    expect(joined).toEqual(["getContextId", "getConfig"]);
  });
});
