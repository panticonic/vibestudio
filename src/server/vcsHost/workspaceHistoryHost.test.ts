import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256HexSyncText } from "@vibestudio/content-addressing";
import type { VcsEditInput } from "@vibestudio/service-schemas/vcs";
import type { VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { expect, it, vi } from "vitest";
import type { WorkspaceSourceProviderRef } from "../workspaceSourceProvider.js";
import { getBytes, putBytes } from "../services/blobstoreService.js";
import {
  editWorkspaceParticipant,
  openWorkspaceParticipantContext,
  readWorkspaceParticipantStatus,
} from "./workspaceHistoryHost.js";

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

it("reads status only from the verified participant and context", async () => {
  const caller = native(1, "status-call");
  const participantId = JSON.stringify(["task", {
    authoritySessionId: "sealed",
    runtimeId: "agent",
  }, { conversationId: 3, taskId: 1 }]);
  const owner = { ...canonical, objectKey: `work-${sha256HexSyncText(participantId)}` };
  const event = { kind: "event", eventId: "saved" };
  const status = {
    contextId: "context",
    committed: event,
    workingHead: event,
    clean: true,
    mainEventId: "main",
    mainRelation: "behind",
    workingCounts: { applications: 0, workUnits: 0, changes: 0 },
    integrating: [],
  };
  const dispatch = vi.fn().mockResolvedValue(status);
  const request = { dispatch: { dispatch }, canonical, owner, caller, contextId: "context" };
  await expect(readWorkspaceParticipantStatus(request)).resolves.toEqual(status);
  expect(dispatch).toHaveBeenLastCalledWith(owner, "readHistoryStatus", { contextId: "context" });
  await expect(
    readWorkspaceParticipantStatus({ ...request, caller: native(2, "other-task") })
  ).rejects.toThrow("history belongs to a different participant");
  expect(dispatch).toHaveBeenCalledTimes(1);
  await expect(
    readWorkspaceParticipantStatus({ ...request, contextId: "other-context" })
  ).rejects.toThrow("different context");
});

it("stores prepared participant content before applying the edit and returns a committed retry", async () => {
  const blobsDir = await mkdtemp(join(tmpdir(), "workspace-history-content-"));
  try {
    const owner = { ...canonical, objectKey: "work-alice" };
    const before = Buffer.from("original");
    const after = Buffer.from("edited");
    const { digest: originalHash } = await putBytes(blobsDir, before);
    const contentHash = sha256HexSyncText(after.toString("utf8"));
    const cause = { parent: null };
    const edit: VcsEditInput = {
      commandId: "edit-command",
      contextId: "edit-context",
      expectedWorkingHead: { kind: "event", eventId: "initial-event" },
      changes: [
        {
          kind: "text-edit",
          repositoryId: "repo",
          fileId: "file",
          edits: [{ start: 0, end: before.length, text: after.toString("utf8") }],
        },
      ],
    };
    const workingHead = { kind: "application" as const, applicationId: "application" };
    const result = {
      commandId: edit.commandId,
      contextId: edit.contextId,
      applicationId: workingHead.applicationId,
      workUnitId: "work-unit",
      changeCount: 1,
      changeIds: ["change"],
      incorporatedChangeCount: 0,
      incorporatedChangeIds: [],
      decisionIds: [],
    };
    const command = { commandId: edit.commandId, method: "edit", requestDigest: "digest", cause };
    const application = { contextId: edit.contextId };
    let committed = false;
    const dispatch = vi.fn(
      async (ref: WorkspaceSourceProviderRef, method: string, input: unknown) => {
        expect(ref).toEqual(owner);
        if (method === "planHistoryEdit") {
          if (committed)
            return { kind: "committed", head: "applied", result: { ...result, workingHead } };
          const request = input as { receipt: unknown };
          if (request.receipt === null)
            return { kind: "read-content", contentHashes: [originalHash] };
          expect(request.receipt).toEqual({
            files: [{ contentHash: originalHash, base64: before.toString("base64") }],
          });
          return {
            kind: "planned",
            command,
            application,
            result,
            blobs: [{ contentHash, base64: after.toString("base64") }],
          };
        }
        expect(method).toBe("applyHistoryApplication");
        expect(input).toEqual({ head: "working", command, plan: application });
        expect(await getBytes(blobsDir, contentHash)).toEqual(after);
        committed = true;
        return { head: "applied", value: workingHead };
      }
    );
    const execute = () =>
      editWorkspaceParticipant({
        dispatch: { dispatch },
        owner,
        head: "working",
        edit,
        cause,
        blobsDir,
      });
    const output = { head: "applied", result: { ...result, workingHead } };
    await expect(execute()).resolves.toEqual(output);
    await expect(execute()).resolves.toEqual(output);
    expect(dispatch.mock.calls.map(([, method]) => method)).toEqual([
      "planHistoryEdit",
      "planHistoryEdit",
      "applyHistoryApplication",
      "planHistoryEdit",
    ]);
  } finally {
    await rm(blobsDir, { recursive: true, force: true });
  }
});
