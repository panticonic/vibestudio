import { describe, expect, it, vi } from "vitest";
import type { RpcClient } from "@vibestudio/rpc";
import { encodeEventWatchRecord } from "@vibestudio/shared/events";
import type { PendingApproval } from "@vibestudio/shared/approvals";
import type { InstallReviewResolution } from "@vibestudio/service-schemas/shellApproval";
import { createApprovalsClient } from "./approvalsClient.js";

function startupUnitApproval(): PendingApproval {
  return {
    kind: "unit-install-review",
    approvalId: "startup-units",
    callerId: "system",
    callerKind: "system",
    repoPath: "meta",
    effectiveVersion: "",
    requestedAt: 1,
    mode: "adopt-root",
    title: "Start this workspace?",
    description: "Vibestudio needs to run 1 program on this computer.",
    parts: [
      {
        identityKey: "apps/shell@ev-shell",
        kind: "app",
        label: "Client App",
        surfaces: [],
        name: "@workspace-apps/shell",
        title: "Shell",
        purpose: "The desktop app itself.",
        repoPath: "apps/shell",
        effectiveVersion: "ev-shell",
        version: null,
        requiredUnitKeys: [],
        runsInBackground: false,
        target: "electron",
        origin: {
          url: null,
          originKey: "vibestudio",
          registrableDomain: null,
          version: "1.4.0",
          isHostBuild: true,
          firstEncounter: false,
        },
        notableRows: [],
        everydayRows: [],
        change: "added",
        section: "template",
      },
    ],
    summary: { panels: 0, agents: 0, services: 0, clientApps: 1, extensions: 0 },
    unchangedPartCount: 0,
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
    kind: "unit-install-review",
    approvalId: "meta-change-apps",
    callerId: "system",
    callerKind: "system",
    repoPath: "meta",
    effectiveVersion: "",
    requestedAt: 1,
    mode: "install",
    title: "Start this workspace?",
    description: "Vibestudio needs to run 1 program on this computer.",
    parts: [
      {
        identityKey: "apps/shell@ev-shell",
        kind: "app",
        label: "Client App",
        surfaces: [],
        name: "@workspace-apps/shell",
        title: "Shell",
        purpose: "The desktop app itself.",
        repoPath: "apps/shell",
        effectiveVersion: "ev-shell",
        version: null,
        requiredUnitKeys: [],
        runsInBackground: false,
        target: "electron",
        origin: {
          url: null,
          originKey: "vibestudio",
          registrableDomain: null,
          version: "1.4.0",
          isHostBuild: true,
          firstEncounter: false,
        },
        notableRows: [],
        everydayRows: [],
        change: "added",
        section: "template",
      },
    ],
    summary: { panels: 0, agents: 0, services: 0, clientApps: 1, extensions: 0 },
    unchangedPartCount: 0,
  };
}

function installReviewResolution(): InstallReviewResolution {
  return {
    approvalId: "install-1",
    mode: "install",
    decision: "accepted",
    heading: "News added",
    parts: [],
  };
}

function fakeRpc(pending: PendingApproval[]) {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const rpc = {
    call: vi.fn(async (_target: string, method: string, _args: unknown[]) => {
      if (method === "shellApproval.listPending") return pending;
      // Resolving a review answers with what actually happened; the typed client
      // parses that answer, so a mock that returns nothing fails the contract
      // rather than the call under test.
      if (method === "shellApproval.resolveInstallReview") return installReviewResolution();
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
  it("does not ask the running app whether the running app may run", async () => {
    const { rpc } = fakeRpc([startupUnitApproval(), runtimeApproval()]);
    const client = createApprovalsClient(rpc);

    await expect(client.list()).resolves.toEqual([runtimeApproval()]);
  });

  it("shows a later extension review in the running queue, because the app can host it", async () => {
    const extensionReview = metaChangeAppApproval() as Extract<
      PendingApproval,
      { kind: "unit-install-review" }
    >;
    const [part] = extensionReview.parts;
    Object.assign(part!, {
      kind: "extension",
      label: "Extension",
      target: null,
      title: "Feed Reader",
      repoPath: "extensions/feed-reader",
    });
    const { rpc } = fakeRpc([extensionReview, runtimeApproval()]);
    const client = createApprovalsClient(rpc);

    await expect(client.list()).resolves.toEqual([extensionReview, runtimeApproval()]);
  });

  it("resolves an install review through resolveInstallReview, never the decision-id path", async () => {
    const { rpc } = fakeRpc([]);
    const client = createApprovalsClient(rpc);
    const resolution = {
      decision: "install" as const,
      allowNow: [{ identityKey: "news-agent", permissions: ["clearable-row"] }],
    };

    await client.resolveInstallReview("install-1", resolution);

    expect(rpc.call).toHaveBeenCalledWith("main", "shellApproval.resolveInstallReview", [
      "install-1",
      resolution,
    ]);
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
