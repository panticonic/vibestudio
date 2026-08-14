import { describe, expect, it } from "vitest";
import { HostCommandRegistry } from "./panelCommandRegistry";

function contribution(
  caller: { callerId: string; callerKind: "panel" | "app" | "worker"; callerPanelId?: string },
  commands: unknown
) {
  return { caller, payload: { commands } };
}

describe("HostCommandRegistry", () => {
  it("keys runtime panels by their durable visible slot", () => {
    const registry = new HostCommandRegistry();
    expect(
      registry.accept(
        contribution(
          {
            callerId: "panel:nav-runtime",
            callerKind: "panel",
            callerPanelId: "panel:tree/chat",
          },
          [{ id: "new", label: "New conversation", group: "Chat" }]
        )
      )
    ).toBe(true);
    expect(registry.get("panel:tree/chat")).toEqual([
      { id: "new", label: "New conversation", group: "Chat" },
    ]);
  });

  it("orders the focused panel first and clears empty contributions", () => {
    const registry = new HostCommandRegistry();
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

  it("round-trips the declarative argument schema", () => {
    const registry = new HostCommandRegistry();
    const command = {
      id: "rename",
      label: "Rename conversation",
      group: "Chat",
      requiresFocus: true,
      danger: false,
      args: [
        { name: "title", label: "title", type: "string", required: true, pattern: "^.{1,64}$" },
        {
          name: "model",
          label: "model",
          type: "enum",
          required: false,
          options: [
            { value: "fast", label: "Fast" },
            { value: "deep", label: "Deep" },
          ],
        },
      ],
    };
    expect(
      registry.accept(contribution({ callerId: "panel:chat", callerKind: "panel" }, [command]))
    ).toBe(true);
    expect(registry.get("panel:chat")).toEqual([command]);
  });

  it("keeps legacy arg-less contributions valid", () => {
    const registry = new HostCommandRegistry();
    expect(
      registry.accept(
        contribution({ callerId: "panel:legacy", callerKind: "panel" }, [
          { id: "a", label: "A" },
          { id: "b", label: "B", description: "Second", group: "Legacy" },
        ])
      )
    ).toBe(true);
    expect(registry.get("panel:legacy")).toHaveLength(2);
  });

  it("rejects malformed arguments rather than half-accepting a command", () => {
    const registry = new HostCommandRegistry();
    const reject = (args: unknown) =>
      registry.accept(
        contribution({ callerId: "panel:chat", callerKind: "panel" }, [
          { id: "x", label: "X", args },
        ])
      );
    expect(reject("not-an-array")).toBe(false);
    expect(reject([{ name: "a", label: "A", type: "widget", required: true }])).toBe(false);
    expect(reject([{ name: "a", label: "A", type: "string" }])).toBe(false);
    expect(reject([{ name: "", label: "A", type: "string", required: true }])).toBe(false);
    expect(reject([{ name: "a", label: "A", type: "enum", required: true, options: [{ value: 1 }] }])).toBe(
      false
    );
    // A pattern that cannot compile would reject every value the user types.
    expect(reject([{ name: "a", label: "A", type: "string", required: true, pattern: "([" }])).toBe(
      false
    );
    // Duplicate names would make the collected argument record lossy.
    expect(
      reject([
        { name: "a", label: "A", type: "string", required: true },
        { name: "a", label: "B", type: "string", required: false },
      ])
    ).toBe(false);
    expect(registry.list()).toEqual([]);
  });

  it("rejects non-boolean metadata flags", () => {
    const registry = new HostCommandRegistry();
    expect(
      registry.accept(
        contribution({ callerId: "panel:chat", callerKind: "panel" }, [
          { id: "x", label: "X", requiresFocus: "yes" },
        ])
      )
    ).toBe(false);
    expect(
      registry.accept(
        contribution({ callerId: "panel:chat", callerKind: "panel" }, [
          { id: "x", label: "X", danger: 1 },
        ])
      )
    ).toBe(false);
  });

  it("rejects unattributed or malformed contributions", () => {
    const registry = new HostCommandRegistry();
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
