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
    const taskAuthorities = new TaskAuthorityRegistry();
    const task = taskAuthorityPrincipal(binding);
    taskAuthorities.bindPrincipal(task, binding);
    const dispatch = vi.fn(async (_ref, method: string) =>
      method === "getContextId" ? binding.contextId : { title: "  Trello-style Task Manager  " }
    );

    const resolve = createTaskTitleResolver({
      taskAuthorities,
      getDispatch: () => ({ dispatch }),
    });

    await expect(resolve(task)).resolves.toBe("Trello-style Task Manager");
    expect(dispatch).toHaveBeenCalledWith(
      {
        source: "workers/pubsub-channel",
        className: "PubSubChannel",
        objectKey: binding.channelId,
      },
      "getConfig"
    );
  });

  it("rejects a channel whose durable context does not match the task binding", async () => {
    const taskAuthorities = new TaskAuthorityRegistry();
    const task = taskAuthorityPrincipal(binding);
    taskAuthorities.bindPrincipal(task, binding);
    const resolve = createTaskTitleResolver({
      taskAuthorities,
      getDispatch: () => ({
        dispatch: vi.fn(async (_ref, method: string) =>
          method === "getContextId" ? "context:other" : { title: "Wrong task" }
        ),
      }),
    });

    await expect(resolve(task)).rejects.toThrow(/does not belong/);
  });
});
