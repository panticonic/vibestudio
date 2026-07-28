import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  launchAgentIntoChannel: vi.fn(async () => ({
    handle: { id: "do:conductor", targetId: "do:conductor", contextId: "ctx-collection" },
    subscription: { ok: true, participantId: "do:conductor" },
    contextId: "ctx-collection",
  })),
  ready: vi.fn(async () => undefined),
  send: vi.fn(async () => ({ messageId: "message-1", pubsubId: 1 })),
  close: vi.fn(async () => undefined),
  connectViaRpc: vi.fn(),
}));

vi.mock("@workspace/agentic-core", () => ({
  launchAgentIntoChannel: mocks.launchAgentIntoChannel,
}));

vi.mock("@workspace/pubsub", () => ({
  connectViaRpc: mocks.connectViaRpc,
}));

import {
  buildBrowserImportWindowTitlePrompt,
  buildCollectionAgentSystemPrompt,
  type CollectionOrchestrationRpc,
  createCollectionSession,
  launchCollectionTask,
  promptForCollectionStartupTask,
} from "./index";

describe("collection orchestration", () => {
  it("creates one stable channel and agent identity from a supplied seed", () => {
    expect(createCollectionSession("6d4d8a2f-0000-4000-8000-000000000000")).toEqual({
      channelName: "collection-6d4d8a2f000040008000000000000000",
      agentKey: "conductor-6d4d8a2f000040008000000000000000",
    });
  });

  it("binds the resident agent to a live recursive scope instead of a copied roster", () => {
    const prompt = buildCollectionAgentSystemPrompt({
      rootPanelId: "panel:tree/imported",
      title: "Imported tabs",
    });
    expect(prompt).toContain('panelTree.subtree("panel:tree/imported")');
    expect(prompt).toContain("scope.revision");
    expect(prompt).toContain("movePanel");
    expect(prompt).toContain("about/collection/SKILL.md");
    expect(prompt).not.toContain("Panels in this collection");
  });

  it("keeps the immediate import task metadata-only and limited to window collections", () => {
    const prompt = buildBrowserImportWindowTitlePrompt("Firefox");
    expect(prompt).toContain("Firefox");
    expect(prompt).toContain("window collection");
    expect(prompt).toContain("do not materialize");
    expect(prompt).toContain("Do not rename browser leaves");
    expect(
      promptForCollectionStartupTask({
        kind: "title-browser-import-windows",
        sourceName: "Firefox",
      })
    ).toBe(prompt);
  });

  it("launches the resident conductor and idempotently publishes through a headless participant", async () => {
    mocks.connectViaRpc.mockReturnValue({
      ready: mocks.ready,
      send: mocks.send,
      close: mocks.close,
    });
    const rpc: CollectionOrchestrationRpc = {
      selfId: "@workspace-extensions/browser-data",
      call: async <T>() => undefined as T,
      stream: vi.fn(async () => new Response()),
    };

    await launchCollectionTask(rpc, {
      rootPanelId: "panel:imported",
      rootTitle: "Firefox · Imported Tabs",
      contextId: "ctx-collection",
      session: {
        channelName: "collection-abc",
        agentKey: "conductor-abc",
      },
      task: "Title the imported windows",
      idempotencyKey: "initial-prompt:collection-abc",
    });

    expect(mocks.launchAgentIntoChannel).toHaveBeenCalledWith(
      rpc,
      expect.objectContaining({
        key: "conductor-abc",
        channelId: "collection-abc",
        contextId: "ctx-collection",
        config: expect.objectContaining({
          approvalLevel: 2,
          systemPrompt: expect.stringContaining("panel:imported"),
        }),
      })
    );
    expect(mocks.connectViaRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        rpc,
        channel: "collection-abc",
        contextId: "ctx-collection",
        type: "headless",
        replayMode: "skip",
      })
    );
    expect(mocks.ready).toHaveBeenCalledOnce();
    expect(mocks.send).toHaveBeenCalledWith("Title the imported windows", {
      idempotencyKey: "initial-prompt:collection-abc",
      tier: "secondary",
    });
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
