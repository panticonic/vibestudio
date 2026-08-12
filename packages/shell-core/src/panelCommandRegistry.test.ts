import { describe, expect, it } from "vitest";
import { PanelCommandRegistry } from "./panelCommandRegistry";

function contribution(
  caller: { callerId: string; callerKind: "panel" | "app" | "worker"; callerPanelId?: string },
  commands: unknown
) {
  return { caller, payload: { commands } };
}

describe("PanelCommandRegistry", () => {
  it("keys runtime panels by their durable visible slot", () => {
    const registry = new PanelCommandRegistry();
    expect(
      registry.accept(
        contribution(
          {
            callerId: "panel:nav-runtime",
            callerKind: "panel",
            callerPanelId: "panel:tree/chat",
          },
          [{ id: "new", label: "New conversation", section: "Chat" }]
        )
      )
    ).toBe(true);
    expect(registry.get("panel:tree/chat")).toEqual([
      { id: "new", label: "New conversation", section: "Chat" },
    ]);
  });

  it("orders the focused panel first and clears empty contributions", () => {
    const registry = new PanelCommandRegistry();
    registry.accept(
      contribution({ callerId: "panel:a", callerKind: "panel" }, [{ id: "a", label: "A" }])
    );
    registry.accept(
      contribution({ callerId: "panel:b", callerKind: "panel" }, [{ id: "b", label: "B" }])
    );

    expect(registry.list("panel:b").map(({ panelId }) => panelId)).toEqual(["panel:b", "panel:a"]);
    registry.accept(contribution({ callerId: "panel:b", callerKind: "panel" }, []));
    expect(registry.get("panel:b")).toEqual([]);
    registry.clear("panel:a");
    expect(registry.list()).toEqual([]);
  });

  it("rejects unattributed or malformed contributions", () => {
    const registry = new PanelCommandRegistry();
    expect(
      registry.accept(
        contribution({ callerId: "worker:untrusted", callerKind: "worker" }, [
          { id: "bad", label: "Bad" },
        ])
      )
    ).toBe(false);
    expect(
      registry.accept(
        contribution({ callerId: "panel:bad", callerKind: "panel" }, [{ id: "missing-label" }])
      )
    ).toBe(false);
    expect(registry.list()).toEqual([]);
  });
});
