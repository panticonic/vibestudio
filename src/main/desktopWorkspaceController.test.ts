import { afterEach, expect, it, vi } from "vitest";
import { EventService } from "@vibestudio/shared/eventsService";
import { createDesktopWorkspaceController } from "./desktopWorkspaceController.js";

vi.mock("./panelOrchestrator.js", () => ({ PanelOrchestrator: class {} }));
vi.mock("./shellCore/createElectronShellCore.js", () => ({
  createElectronShellCore: () => ({ panelManager: {} }),
}));

afterEach(() => vi.useRealTimers());

it("delivers late icon decoration through each workspace's existing presentation watch", async () => {
  vi.useFakeTimers();
  const create = (workspaceId: string) => {
    const eventService = new EventService();
    const controller = createDesktopWorkspaceController({
      connection: {
        workspaceId,
        connectionMode: "local",
        gatewayConfig: { serverUrl: "http://localhost/" },
      } as Parameters<typeof createDesktopWorkspaceController>[0]["connection"],
      eventService,
      presentation: {} as Parameters<typeof createDesktopWorkspaceController>[0]["presentation"],
    });
    controller.registry.addPanel(
      {
        id: "panel:tree/about~new/initial",
        title: "New Panel",
        children: [],
        snapshot: { source: "about/new", contextId: "main", options: {} },
        artifacts: {},
      },
      null,
      { addAsRoot: true }
    );
    return controller;
  };
  const system = create("system");
  const personal = create("personal");
  await vi.runOnlyPendingTimersAsync();
  const watch = (owner: typeof system) =>
    owner.eventService
      .openWatch({
        callerId: "shell",
        callerKind: "shell",
        connectionId: owner.workspaceId,
        watchId: "presentation",
        events: ["panel-presentation-changed"],
      })
      .body!.getReader();
  const systemReader = watch(system);
  const personalReader = watch(personal);
  try {
    await systemReader.read(); // Watch ready records precede event delivery.
    await personalReader.read();
    let personalNotified = false;
    const personalUpdate = personalReader.read().then((result) => {
      personalNotified = true;
      return result;
    });
    system.registry.updateIconDecoration("panel:tree/about~new/initial", {
      icon: "./assets/icon.svg",
      iconState: "a".repeat(64),
    });
    await vi.runOnlyPendingTimersAsync();
    const update = await systemReader.read();
    expect(JSON.parse(new TextDecoder().decode(update.value))).toMatchObject({
      kind: "event",
      event: "panel-presentation-changed",
      payload: { panelIds: ["panel:tree/about~new/initial"] },
    });
    expect(personalNotified).toBe(false);
    personal.registry.updateIconDecoration("panel:tree/about~new/initial", {
      icon: "./assets/icon.svg",
      iconState: "b".repeat(64),
    });
    await vi.runOnlyPendingTimersAsync();
    expect((await personalUpdate).done).toBe(false);
    expect(system.registry.getPanel("panel:tree/about~new/initial")?.iconState).toBe(
      "a".repeat(64)
    );
    expect(personal.registry.getPanel("panel:tree/about~new/initial")?.iconState).toBe(
      "b".repeat(64)
    );
  } finally {
    await systemReader.cancel();
    await personalReader.cancel();
  }
});
