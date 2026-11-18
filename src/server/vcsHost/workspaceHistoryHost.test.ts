import { sha256HexSyncText } from "@vibestudio/content-addressing";
import type { VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { expect, it, vi } from "vitest";
import type { WorkspaceSourceProviderRef } from "../workspaceSourceProvider.js";
import { openWorkspaceParticipantContext } from "./workspaceHistoryHost.js";

const canonical = {
  source: "workers/workspace-source",
  className: "GadHistoryDO",
  objectKey: "canonical",
};
const native = (taskId: number, callId: string): VerifiedCaller => ({
  runtime: { kind: "do", id: "do:workers/agent:AgentDO:agent" },
  nativeInvocation: {
    owner: { runtimeId: "agent", authoritySessionId: "sealed" },
    task: { conversationId: 3, taskId },
    operation: { kind: "tool", assistantEntryId: 0, callId },
  },
});

it("uses the verified task to choose a copy and preserves the migrated context head", async () => {
  const dispatch = vi.fn(
    async (_ref: WorkspaceSourceProviderRef, method: string, input: unknown) => {
      if (method === "reserveHistoryParticipant") {
        const { participantId } = input as { participantId: string };
        return {
          targetId: `do:${canonical.source}:${canonical.className}:work-${sha256HexSyncText(participantId)}`,
          head: "fork",
          origin: { ref: "History:canonical", token: "grant" },
        };
      }
      if (method === "connectHistoryParticipant") return "latest-main";
      if (method === "openHistoryContext") return (input as { head: string }).head;
      throw new Error(`Unexpected history call ${method}`);
    }
  );
  const launch = (caller: VerifiedCaller, replayedWorkingHead?: string) =>
    openWorkspaceParticipantContext({
      dispatch: { dispatch },
      canonical,
      caller,
      ownerContextId: "owner",
      contextId: "context",
      replayedWorkingHead,
    });
  const first = await launch(native(1, "call-1"), "replayed-working");
  const second = await launch(native(1, "call-2"));
  const third = await launch(native(2, "call-3"));
  expect(first.owner).toEqual(second.owner);
  expect(first.owner).not.toEqual(third.owner);
  expect(first.workingHead).toBe("replayed-working");
  expect(second.workingHead).toBe("latest-main");
  expect(dispatch.mock.calls[1]?.[0]).toEqual(first.owner);
});

it("withholds a grant when replay reports a different allocation", async () => {
  const dispatch = vi.fn(async () => ({
    targetId: "do:another:History:work",
    head: "head",
    origin: { ref: "History:canonical", token: "grant" },
  }));
  await expect(
    openWorkspaceParticipantContext({
      dispatch: { dispatch },
      canonical,
      caller: native(1, "call"),
      ownerContextId: "owner",
      contextId: "file-context",
    })
  ).rejects.toThrow("different participant owner");
  expect(dispatch).toHaveBeenCalledTimes(1);
});
