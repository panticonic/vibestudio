import { asPanelEntityId, asPanelSlotId } from "@vibestudio/shared/panel/ids";
import { describe, expect, it, vi } from "vitest";
import { PanelInitClient } from "./panelInitClient.js";

function clientWithPanelManager(currentEntityId: string | null) {
  const client = new PanelInitClient(
    { call: vi.fn() },
    "http://127.0.0.1:3030",
    "Headless Test",
    "headless-test"
  );
  const panelManager = {
    refreshSlotEntity: vi.fn(async () =>
      currentEntityId ? asPanelEntityId(currentEntityId) : null
    ),
    getPanelInit: vi.fn(async () => ({
      entityId: currentEntityId,
      sourceRepo: "panels/todo",
      contextId: "context-1",
      buildKey: "a".repeat(64),
      gatewayConfig: { serverUrl: "http://127.0.0.1:3030", token: "grant-1" },
    })),
  };
  Object.assign(client as unknown as Record<string, unknown>, { panelManager });
  return { client, panelManager };
}

describe("PanelInitClient", () => {
  it("refreshes the slot cursor and mints init for the leased runtime incarnation", async () => {
    const slotId = asPanelSlotId("panel:tree/todo");
    const runtimeEntityId = asPanelEntityId("panel:nav-current");
    const { client, panelManager } = clientWithPanelManager(runtimeEntityId);

    const result = await client.getPanelLoadInfo(slotId, runtimeEntityId, "connection-2");

    expect(panelManager.refreshSlotEntity).toHaveBeenCalledWith(slotId);
    expect(panelManager.getPanelInit).toHaveBeenCalledWith(slotId);
    expect(result.panelInit).toMatchObject({
      entityId: runtimeEntityId,
      connectionId: "connection-2",
      clientLabel: "Headless Test",
      gatewayConfig: { token: "grant-1" },
    });
  });

  it("refuses to mint a credential when the lease and durable slot cursor disagree", async () => {
    const slotId = asPanelSlotId("panel:tree/todo");
    const { client, panelManager } = clientWithPanelManager("panel:nav-stale");

    await expect(
      client.getPanelLoadInfo(slotId, asPanelEntityId("panel:nav-leased"), "connection-2")
    ).rejects.toThrow(
      "panel panel:tree/todo lease targets panel:nav-leased, but the current runtime is panel:nav-stale"
    );
    expect(panelManager.getPanelInit).not.toHaveBeenCalled();
  });

  it("refuses a bootstrap assembled for a different runtime incarnation", async () => {
    const slotId = asPanelSlotId("panel:tree/todo");
    const runtimeEntityId = asPanelEntityId("panel:nav-current");
    const { client, panelManager } = clientWithPanelManager(runtimeEntityId);
    panelManager.getPanelInit.mockResolvedValueOnce({
      entityId: "panel:nav-previous",
      sourceRepo: "panels/todo",
      contextId: "context-1",
      buildKey: "a".repeat(64),
      gatewayConfig: { token: "grant-1" },
    });

    await expect(
      client.getPanelLoadInfo(slotId, runtimeEntityId, "connection-2")
    ).rejects.toThrow(
      "panel panel:tree/todo bootstrap targets panel:nav-previous, but the lease targets panel:nav-current"
    );
  });
});
