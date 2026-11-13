import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createPanelPresentation } from "./panelPresentation.js";
import { PanelRuntimeStore } from "./panelRuntimeStore.js";
import { deviceIdOfHostPrincipal } from "./callerDeviceFacts.js";
import type { PanelRuntimeLeaseChangedEvent } from "@vibestudio/shared/panel/panelLease";

describe("panel presentation", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function setup(opts: { pushDelivers?: boolean } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "panel-presentation-"));
    dirs.push(dir);
    const store = new PanelRuntimeStore({ databasePath: path.join(dir, "db") });
    const clients = [
      {
        clientSessionId: "cs-laptop",
        ownerCallerId: "shell:laptop",
        label: "Laptop",
        platform: "desktop" as const,
      },
      {
        clientSessionId: "cs-local",
        ownerCallerId: "electron-main",
        label: "This Mac",
        platform: "desktop" as const,
      },
      {
        clientSessionId: "cs-other",
        ownerCallerId: "shell:someone-else",
        label: "Not mine",
        platform: "desktop" as const,
      },
    ];
    const leaseListeners: Array<(e: PanelRuntimeLeaseChangedEvent) => void> = [];
    const emitted: unknown[] = [];
    const pushes: unknown[] = [];
    const presentation = createPanelPresentation({
      store,
      coordinator: {
        listClientSessions: () => clients,
        onLeaseChanged: (l) => {
          leaseListeners.push(l);
          return () => {};
        },
      },
      deviceOfPrincipal: (id) => deviceIdOfHostPrincipal(id, { clientPrincipalDevice: () => null }),
      pairedDevices: (userId) =>
        userId === "user:me"
          ? [
              { deviceId: "laptop", label: "Laptop", platform: "linux" },
              { deviceId: "phone", label: "Phone", platform: "android" },
            ]
          : [],
      slotExists: async (slotId) => slotId !== "closed",
      emit: (e) => emitted.push(e),
      push: async (p) => {
        pushes.push(p);
        return opts.pushDelivers ?? true;
      },
    });
    const lease = (slotId: string, clientSessionId: string) =>
      leaseListeners.forEach((l) =>
        l({ next: { clientSessionId }, slotId } as unknown as PanelRuntimeLeaseChangedEvent)
      );
    return { presentation, store, emitted, pushes, lease };
  }

  it("lists the caller's online and away devices plus this machine, not other users' devices", () => {
    const { presentation } = setup();
    expect(presentation.listTargets("user:me")).toEqual([
      {
        deviceId: "laptop",
        label: "Laptop",
        platform: "desktop",
        online: true,
        clientSessionId: "cs-laptop",
      },
      {
        deviceId: "local:electron-main",
        label: "This Mac",
        platform: "desktop",
        online: true,
        clientSessionId: "cs-local",
      },
      {
        deviceId: "phone",
        label: "Phone",
        platform: "mobile",
        online: false,
        clientSessionId: null,
      },
    ]);
  });

  it("asks an online device now, and pushes only when an alert is wanted", async () => {
    const { presentation, emitted, pushes } = setup();
    expect(
      await presentation.request("user:me", {
        slotId: "s",
        deviceId: "laptop",
        focus: true,
        alert: "none",
      })
    ).toEqual({ state: "presented" });
    expect(emitted).toHaveLength(1);
    expect(pushes).toHaveLength(0);
    await presentation.request("user:me", {
      slotId: "s",
      deviceId: "laptop",
      focus: true,
      alert: "inbox",
    });
    expect(pushes).toHaveLength(1);
  });

  it("keeps a request for an away device and notifies it", async () => {
    const { presentation, emitted, store } = setup();
    expect(
      await presentation.request("user:me", {
        slotId: "s",
        deviceId: "phone",
        focus: true,
        alert: "none",
      })
    ).toEqual({ state: "pushed" });
    expect(emitted).toHaveLength(0);
    expect(store.pending("phone")).toHaveLength(1);
    expect(await presentation.pendingFor("shell:phone")).toEqual([
      expect.objectContaining({ slotId: "s", deviceId: "phone", focus: true }),
    ]);
  });

  it("reports pending-device when no push reached the away device", async () => {
    const { presentation } = setup({ pushDelivers: false });
    expect(
      await presentation.request("user:me", {
        slotId: "s",
        deviceId: "phone",
        focus: false,
        alert: "none",
      })
    ).toEqual({ state: "pending-device" });
  });

  it("refuses unknown slots and devices that are not the caller's", async () => {
    const { presentation } = setup();
    await expect(
      presentation.request("user:me", {
        slotId: "closed",
        deviceId: "phone",
        focus: true,
        alert: "none",
      })
    ).rejects.toThrow(/Unknown or closed/);
    await expect(
      presentation.request("user:me", {
        slotId: "s",
        deviceId: "someone-else",
        focus: true,
        alert: "none",
      })
    ).rejects.toThrow(/not one of your devices/);
  });

  it("clears the request when the device takes the slot, and drops closed slots", async () => {
    const { presentation, store, lease } = setup();
    await presentation.request("user:me", {
      slotId: "s",
      deviceId: "laptop",
      focus: true,
      alert: "none",
    });
    lease("s", "cs-other");
    expect(store.pending("laptop")).toHaveLength(1);
    lease("s", "cs-laptop");
    expect(store.pending("laptop")).toEqual([]);
    store.request({ slotId: "closed", deviceId: "phone", focus: true, alert: "none" });
    expect(await presentation.pendingFor("shell:phone")).toEqual([]);
    expect(store.pending("phone")).toEqual([]);
  });
});
