import { describe, expect, it, vi } from "vitest";
import type { RpcClient } from "@vibestudio/rpc";
import { encodeEventWatchRecord } from "@vibestudio/shared/events";
import type { PendingApproval } from "@vibestudio/shared/approvals";
import { createApprovalsClient } from "./approvalsClient.js";

function startupUnitApproval(): PendingApproval {
  return {
    kind: "unit-batch",
    approvalId: "startup-units",
    callerId: "system",
    callerKind: "system",
    repoPath: "meta",
    effectiveVersion: "ev-startup",
    requestedAt: 1,
    trigger: "startup",
    title: "Approve workspace units",
    description: "Approve privileged units before launch.",
    units: [
      {
        unitKind: "app",
        unitName: "@workspace-apps/remote-cli",
        displayName: "Remote CLI",
        target: "terminal",
        source: { kind: "workspace-repo", repo: "meta", ref: "main" },
        capabilities: [],
      },
      {
        unitKind: "extension",
        unitName: "@workspace-extensions/native",
        displayName: "Native Extension",
        target: null,
        source: { kind: "workspace-repo", repo: "meta", ref: "main" },
        capabilities: ["native-code"],
      },
    ],
  };
}

function runtimeApproval(): PendingApproval {
  return {
    kind: "capability",
    approvalId: "runtime-capability",
    callerId: "panel:chat",
    callerKind: "panel",
    repoPath: "panels/chat",
    effectiveVersion: "ev-runtime",
    requestedAt: 2,
    capability: "externalOpen",
    title: "Open external URL",
  };
}

function metaChangeAppApproval(): PendingApproval {
  return {
    kind: "unit-batch",
    approvalId: "meta-change-apps",
    callerId: "system",
    callerKind: "system",
    repoPath: "meta",
    effectiveVersion: "ev-meta-change",
    requestedAt: 3,
    trigger: "meta-change",
    title: "Approve workspace app change",
    description: "Approve app target added by a live meta change.",
    units: [
      {
        unitKind: "app",
        unitName: "@workspace-apps/shell",
        displayName: "Shell",
        target: "electron",
        source: { kind: "workspace-repo", repo: "meta", ref: "main" },
        capabilities: [],
      },
    ],
  };
}

function fakeRpc(pending: PendingApproval[]) {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const rpc = {
    call: vi.fn(async (_target: string, method: string, _args: unknown[]) => {
      if (method === "shellApproval.listPending") return pending;
      return undefined;
    }),
    stream: vi.fn(
      async (_target: string, _method: string, args: unknown[]) =>
        new Response(
          new ReadableStream({
            start(next) {
              controller = next;
              next.enqueue(
                encodeEventWatchRecord({
                  kind: "watching",
                  events: args[0] as never,
                  epoch: "test-epoch",
                })
              );
            },
          })
        )
    ),
  } as unknown as RpcClient;
  return {
    rpc,
    emit(payload: unknown) {
      controller?.enqueue(
        encodeEventWatchRecord({
          kind: "event",
          event: "shell-approval:pending-changed",
          payload,
          sequence: 1,
        })
      );
    },
  };
}

describe("createApprovalsClient", () => {
  it("does not expose startup privileged-unit approvals in the terminal runtime queue", async () => {
    const { rpc } = fakeRpc([startupUnitApproval(), runtimeApproval()]);
    const client = createApprovalsClient(rpc);

    await expect(client.list()).resolves.toEqual([runtimeApproval()]);
  });

  it("keeps live app approval prompts that happen after startup", async () => {
    const { rpc } = fakeRpc([metaChangeAppApproval(), runtimeApproval()]);
    const client = createApprovalsClient(rpc);

    await expect(client.list()).resolves.toEqual([metaChangeAppApproval(), runtimeApproval()]);
  });

  it("watches the shared shell approval queue", async () => {
    const { rpc, emit } = fakeRpc([]);
    const client = createApprovalsClient(rpc);
    const listener = vi.fn();

    const unsubscribe = client.onChange(listener);
    await vi.waitFor(() => expect(rpc.stream).toHaveBeenCalledTimes(1));
    emit([]);
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    unsubscribe();
    expect(rpc.stream).toHaveBeenCalledWith(
      "main",
      "events.watch",
      [["shell-approval:pending-changed"], expect.any(String)],
      expect.objectContaining({ bodyIdleTimeoutMs: null })
    );
  });
});
