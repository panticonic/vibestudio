import { describe, expect, it, vi } from "vitest";
import {
  createHostCommandRegistry,
  HOST_COMMAND_CONTRIBUTION_EVENT,
} from "./hostCommands.js";

const registryForTest = () => createHostCommandRegistry({ dispatchRun: () => {}, warn: () => {} });

function contribution(
  caller: { callerId: string; callerKind: "panel" | "app" | "worker"; callerPanelId?: string },
  commands: unknown
) {
  return { caller, payload: { commands } };
}

describe("createHostCommandRegistry", () => {
  it("keys runtime panels by their durable visible slot", () => {
    const registry = registryForTest();
    expect(
      registry.acceptRpcEvent(
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
    const registry = registryForTest();
    registry.acceptRpcEvent(
      contribution({ callerId: "panel:a", callerKind: "panel" }, [{ id: "a", label: "A" }])
    );
    registry.acceptRpcEvent(
      contribution({ callerId: "panel:b", callerKind: "panel" }, [{ id: "b", label: "B" }])
    );

    expect(registry.list("panel:b").map(({ panelId }) => panelId)).toEqual(["panel:b", "panel:a"]);
    registry.acceptRpcEvent(contribution({ callerId: "panel:b", callerKind: "panel" }, []));
    expect(registry.get("panel:b")).toEqual([]);
    registry.release("panel:a");
    expect(registry.list()).toEqual([]);
  });

  it("round-trips the declarative argument schema", () => {
    const registry = registryForTest();
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
      registry.acceptRpcEvent(contribution({ callerId: "panel:chat", callerKind: "panel" }, [command]))
    ).toBe(true);
    expect(registry.get("panel:chat")).toEqual([command]);
  });

  it("keeps legacy arg-less contributions valid", () => {
    const registry = registryForTest();
    expect(
      registry.acceptRpcEvent(
        contribution({ callerId: "panel:legacy", callerKind: "panel" }, [
          { id: "a", label: "A" },
          { id: "b", label: "B", description: "Second", group: "Legacy" },
        ])
      )
    ).toBe(true);
    expect(registry.get("panel:legacy")).toHaveLength(2);
  });

  it("rejects malformed arguments rather than half-accepting a command", () => {
    const registry = registryForTest();
    const reject = (args: unknown) =>
      registry.acceptRpcEvent(
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
    const registry = registryForTest();
    expect(
      registry.acceptRpcEvent(
        contribution({ callerId: "panel:chat", callerKind: "panel" }, [
          { id: "x", label: "X", requiresFocus: "yes" },
        ])
      )
    ).toBe(false);
    expect(
      registry.acceptRpcEvent(
        contribution({ callerId: "panel:chat", callerKind: "panel" }, [
          { id: "x", label: "X", danger: 1 },
        ])
      )
    ).toBe(false);
  });

  it("rejects unattributed or malformed contributions", () => {
    const registry = registryForTest();
    expect(
      registry.acceptRpcEvent(
        contribution({ callerId: "worker:untrusted", callerKind: "worker" }, [
          { id: "bad", label: "Bad" },
        ])
      )
    ).toBe(false);
    expect(
      registry.acceptRpcEvent(
        contribution({ callerId: "panel:bad", callerKind: "panel" }, [{ id: "missing-label" }])
      )
    ).toBe(false);
    expect(registry.list()).toEqual([]);
  });

  it("keeps every shell envelope local and accepts events only", () => {
    const warn = vi.fn();
    const registry = createHostCommandRegistry({ dispatchRun: () => {}, warn });
    const event = (name: string, payload: unknown) => ({
      message: { type: "event" as const, fromId: "panel:tree/a", event: name, payload },
    });
    registry.deliverShellEnvelope(
      "panel:tree/a",
      event(HOST_COMMAND_CONTRIBUTION_EVENT, {
        panelId: "panel:forged",
        commands: [{ id: "a", label: "A" }],
      })
    );
    expect(registry.get("panel:tree/a")).toEqual([{ id: "a", label: "A" }]);
    expect(registry.get("panel:forged")).toEqual([]);

    registry.deliverShellEnvelope("panel:tree/a", event("runtime:future-shell-capability", {}));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("runtime:future-shell-capability"));
    expect(() =>
      registry.deliverShellEnvelope("panel:tree/a", {
        message: { type: "request", requestId: "r1", fromId: "panel:tree/a", method: "x", args: [] },
      } as never)
    ).toThrow(/events only/);
  });

  it("replaces atomically, notifies observers, and releases on lifecycle", () => {
    const registry = registryForTest();
    const changes = vi.fn();
    const unsubscribe = registry.subscribe(changes);
    const caller = { callerId: "panel:a", callerKind: "panel" as const };
    registry.acceptRpcEvent(contribution(caller, [{ id: "one", label: "One" }]));
    registry.acceptRpcEvent(contribution(caller, [{ id: "two", label: "Two" }]));
    expect(registry.get("panel:a")).toEqual([{ id: "two", label: "Two" }]);
    registry.release("panel:a");
    expect(registry.get("panel:a")).toEqual([]);
    expect(changes).toHaveBeenCalledTimes(3);
    registry.release("panel:a");
    expect(changes).toHaveBeenCalledTimes(3);
    unsubscribe();
    registry.acceptRpcEvent(contribution(caller, [{ id: "one", label: "One" }]));
    expect(changes).toHaveBeenCalledTimes(3);
  });

  it("dispatches a run to the same slot", async () => {
    const dispatchRun = vi.fn();
    const registry = createHostCommandRegistry({ dispatchRun });
    await registry.run("panel:tree/a", "rename");
    expect(dispatchRun).toHaveBeenCalledWith("panel:tree/a", { commandId: "rename" });
  });
});
