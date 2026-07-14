import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rpc } from "@vibestudio/rpc";
import { createTestDirectAuthority } from "./durable-test-utils.js";

// Envelope-native /rpc: the mock receives an RpcEnvelope and must reply with a
// response envelope echoing the requestId (else the connectionless client never
// settles). parseReq reconstructs the legacy recorded {type,targetId,method,args}
// shape; respond wraps a result into a response envelope.
function parseReq(init?: RequestInit) {
  const envelope = JSON.parse(String(init?.body ?? "{}")) as {
    from?: string;
    target?: string;
    message?: {
      type?: string;
      requestId?: string;
      method?: string;
      args?: unknown[];
      event?: string;
      payload?: unknown;
    };
  };
  const msg = envelope.message ?? {};
  return {
    type: msg.type === "event" ? "emit" : "call",
    targetId: envelope.target ?? "",
    method: msg.method ?? msg.event ?? "",
    args: msg.args ?? (msg.payload !== undefined ? [msg.payload] : []),
  } as { type: string; targetId: string; method: string; args: unknown[] };
}
function respond(init: RequestInit | undefined, result: unknown) {
  const envelope = JSON.parse(String(init?.body ?? "{}")) as {
    from?: string;
    target?: string;
    message?: { requestId?: string };
  };
  return new Response(
    JSON.stringify({
      from: envelope.target,
      target: envelope.from,
      delivery: { caller: { callerId: "main", callerKind: "server" } },
      provenance: [],
      message: { type: "response", requestId: envelope.message?.requestId, result },
    })
  );
}

describe("DurableObjectBase panelTree handles", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("routes bare handle RPC events through the refreshed runtime entity id", async () => {
    const calls: Array<{ type?: string; targetId: string; method: string; args: unknown[] }> = [];
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = parseReq(init);
      calls.push({
        type: body.type,
        targetId: body.targetId,
        method: body.method,
        args: body.args,
      });
      if (body.method === "panelTree.metadata") {
        return respond(init, {
          id: "slot-a",
          title: "Panel A",
          source: "panels/a",
          kind: "workspace",
          parentId: "root",
          contextId: "ctx-slot-a",
          runtimeEntityId: "panel:nav-slot-a-current",
        });
      }
      return respond(init, "ok");
    }) as typeof fetch;

    const [{ DurableObjectBase }, { createTestDO }] = await Promise.all([
      import("./durable-base.js"),
      import("./durable-test-utils.js"),
    ]);

    class PanelTreeProbeDO extends DurableObjectBase {
      protected createTables(): void {}

      @rpc({ principals: ["host", "user", "code"] })
      async probePanelTree(): Promise<{
        title: string | undefined;
        source: string | undefined;
        kind: "workspace" | "browser";
        parentId: string | null;
      }> {
        const handle = this.panelTree.get("slot-a");
        await handle.refresh();
        await handle.call["ping"]?.();
        await handle.emit("ready", { ok: true });
        return {
          title: handle.title,
          source: handle.source,
          kind: handle.kind,
          parentId: handle.parentId,
        };
      }
    }

    const { call } = await createTestDO(PanelTreeProbeDO, {
      GATEWAY_URL: "http://server.test",
    });

    await expect(call("probePanelTree")).resolves.toEqual({
      title: "Panel A",
      source: "panels/a",
      kind: "workspace",
      parentId: "root",
    });

    expect(calls).toEqual([
      {
        type: "call",
        targetId: "main",
        method: "panelTree.metadata",
        args: ["slot-a"],
      },
      {
        type: "call",
        targetId: "panel:nav-slot-a-current",
        method: "ping",
        args: [],
      },
      {
        type: "emit",
        targetId: "panel:nav-slot-a-current",
        method: "ready",
        args: [{ ok: true }],
      },
    ]);
  });

  it("resolves isLoaded from the server runtime lease", async () => {
    const calls: Array<{ targetId: string; method: string; args: unknown[] }> = [];
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = parseReq(init);
      // Strip the opaque transport requestId/idempotencyKey; these tests assert routing.
      delete (body as Record<string, unknown>)["requestId"];
      delete (body as Record<string, unknown>)["idempotencyKey"];
      calls.push(body);
      if (body.method === "panelTree.getRuntimeLease") {
        return respond(init, {
          slotId: "panel:tree/slot-a",
          runtimeEntityId: "panel:nav-slot-a-current",
          clientSessionId: "desktop",
          hostConnectionId: "desktop",
          connectionId: "desktop",
          holderLabel: "Desktop",
          platform: "desktop",
          supportsCdp: true,
          loadOnLeaseAssignment: true,
          acquiredAt: 1,
        });
      }
      return respond(init, null);
    }) as typeof fetch;

    const [{ DurableObjectBase }, { createTestDO }] = await Promise.all([
      import("./durable-base.js"),
      import("./durable-test-utils.js"),
    ]);

    class PanelTreeProbeDO extends DurableObjectBase {
      protected createTables(): void {}

      @rpc({ principals: ["host", "user", "code"] })
      async probePanelTree(): Promise<boolean> {
        return this.panelTree.get("slot-a").isLoaded();
      }
    }

    const { call } = await createTestDO(PanelTreeProbeDO, {
      GATEWAY_URL: "http://server.test",
    });

    await expect(call("probePanelTree")).resolves.toBe(true);

    expect(calls).toEqual([
      {
        type: "call",
        targetId: "main",
        method: "panelTree.getRuntimeLease",
        args: ["slot-a"],
      },
    ]);
  });

  it("lists, hydrates children, and opens panels through the server panelTree service", async () => {
    const calls: Array<{ targetId: string; method: string; args: unknown[] }> = [];
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = parseReq(init);
      // Strip the opaque transport requestId/idempotencyKey; these tests assert routing.
      delete (body as Record<string, unknown>)["requestId"];
      delete (body as Record<string, unknown>)["idempotencyKey"];
      calls.push(body);
      if (body.method === "panelTree.list" && body.args[0] === null) {
        return respond(init, [
          {
            panelId: "root-slot",
            title: "Root",
            source: "panels/root",
            kind: "workspace",
            parentId: null,
            contextId: "ctx-root",
            runtimeEntityId: "panel:nav-root",
          },
        ]);
      }
      if (body.method === "panelTree.list" && body.args[0] === "root-slot") {
        return respond(init, [
          {
            panelId: "child-slot",
            title: "Child",
            source: "panels/child",
            kind: "workspace",
            parentId: "root-slot",
            contextId: "ctx-child",
            runtimeEntityId: "panel:nav-child",
          },
        ]);
      }
      if (body.method === "panelTree.create") {
        return respond(init, {
          id: "created-slot",
          title: "Created",
          kind: "workspace",
          runtimeEntityId: "panel:nav-created",
        });
      }
      return respond(init, "ok");
    }) as typeof fetch;

    const [{ DurableObjectBase }, { createTestDO }] = await Promise.all([
      import("./durable-base.js"),
      import("./durable-test-utils.js"),
    ]);

    class PanelTreeProbeDO extends DurableObjectBase {
      protected createTables(): void {}

      @rpc({ principals: ["host", "user", "code"] })
      async probePanelTree(): Promise<{
        allIds: string[];
        childParentId: string | null | undefined;
        createdId: string;
        createdParentId: string | null;
      }> {
        const all = await this.panelTree.list();
        const children = await this.panelTree.children("root-slot");
        const created = await this.openPanel("panels/new");
        return {
          allIds: all.map((handle) => handle.id),
          childParentId: children[0]?.parent()?.id,
          createdId: created.id,
          createdParentId: created.parentId,
        };
      }
    }

    const { call } = await createTestDO(PanelTreeProbeDO, {
      GATEWAY_URL: "http://server.test",
    });

    await expect(call("probePanelTree")).resolves.toEqual({
      allIds: ["root-slot"],
      childParentId: "root-slot",
      createdId: "created-slot",
      createdParentId: null,
    });

    expect(calls).toEqual([
      {
        type: "call",
        targetId: "main",
        method: "panelTree.list",
        args: [null],
      },
      {
        type: "call",
        targetId: "main",
        method: "panelTree.list",
        args: ["root-slot"],
      },
      {
        type: "call",
        targetId: "main",
        method: "panelTree.create",
        args: ["panels/new", { parentId: null }],
      },
    ]);
  });

  it("exposes openPanel/listPanels/getPanelHandle aliases on DurableObjectBase", async () => {
    const calls: Array<{ targetId: string; method: string; args: unknown[] }> = [];
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = parseReq(init);
      delete (body as Record<string, unknown>)["requestId"];
      delete (body as Record<string, unknown>)["idempotencyKey"];
      calls.push(body);
      if (body.method === "panelTree.list") {
        return respond(init, []);
      }
      if (body.method === "panelTree.create") {
        return respond(init, {
          id: "created-slot",
          title: "Created",
          kind: "workspace",
          runtimeEntityId: "panel:nav-created",
        });
      }
      return respond(init, null);
    }) as typeof fetch;

    const [{ DurableObjectBase }, { createTestDO }] = await Promise.all([
      import("./durable-base.js"),
      import("./durable-test-utils.js"),
    ]);

    class PanelAliasProbeDO extends DurableObjectBase {
      protected createTables(): void {}

      @rpc({ principals: ["host", "user", "code"] })
      async probePanelAliases(): Promise<{
        createdId: string;
        listedCount: number;
        knownId: string;
      }> {
        const created = await this.openPanel("panels/new", { focus: true });
        const listed = await this.listPanels();
        const known = this.getPanelHandle("known-slot");
        return { createdId: created.id, listedCount: listed.length, knownId: known.id };
      }
    }

    const { call } = await createTestDO(PanelAliasProbeDO, {
      GATEWAY_URL: "http://server.test",
    });

    await expect(call("probePanelAliases")).resolves.toEqual({
      createdId: "created-slot",
      listedCount: 0,
      knownId: "known-slot",
    });
    expect(calls).toEqual([
      {
        type: "call",
        targetId: "main",
        method: "panelTree.create",
        args: ["panels/new", { focus: true, parentId: null }],
      },
      {
        type: "call",
        targetId: "main",
        method: "panelTree.list",
        args: [null],
      },
    ]);
  });

  it("builds a panel parent handle with entity-scoped RPC and slot-scoped CDP", async () => {
    const calls: Array<{ targetId: string; method: string; args: unknown[] }> = [];
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = parseReq(init);
      // Strip the opaque transport requestId/idempotencyKey; these tests assert routing.
      delete (body as Record<string, unknown>)["requestId"];
      delete (body as Record<string, unknown>)["idempotencyKey"];
      calls.push(body);
      if (body.method === "panelCdp.getCdpEndpoint") {
        return respond(init, { wsEndpoint: "ws://cdp.test" });
      }
      if (body.method === "panelTree.reload") {
        return respond(init, {
          panelId: "parent-slot",
          operation: "reload",
          status: "reloaded",
          loaded: true,
          rebuilt: false,
          reloaded: true,
        });
      }
      if (body.method === "panelTree.rebuildAndReload") {
        return respond(init, {
          panelId: "parent-slot",
          operation: "rebuildAndReload",
          status: "reloaded",
          loaded: true,
          rebuilt: true,
          reloaded: true,
        });
      }
      return respond(init, null);
    }) as typeof fetch;

    const [{ DurableObjectBase }, { createTestDO }] = await Promise.all([
      import("./durable-base.js"),
      import("./durable-test-utils.js"),
    ]);

    class ParentProbeDO extends DurableObjectBase {
      protected createTables(): void {}

      @rpc({ principals: ["host", "user", "code"] })
      async probeParent(): Promise<{
        id: string;
        title: string | undefined;
        cdpEndpoint: unknown;
      } | null> {
        const parent = this.getParent();
        if (!parent) return null;
        const info = await parent.getInfo();
        await parent.call["ping"]?.();
        const cdpEndpoint = await parent.cdp.getCdpEndpoint();
        await parent.reload();
        await parent.rebuildAndReload();
        return { id: info.id, title: info.title, cdpEndpoint };
      }
    }

    const { instance } = await createTestDO(ParentProbeDO, {
      GATEWAY_URL: "http://server.test",
    });
    const fetchable = instance as unknown as { fetch(request: Request): Promise<Response> };
    // Converged inbound dispatch: caller attribution rides in the envelope's
    // delivery.caller (POSTed to __rpc), not X-vibestudio-Rpc-Caller-* headers.
    const caller = {
      callerId: "panel:nav-parent",
      callerKind: "panel",
      callerPanelId: "parent-slot",
      authorization: createTestDirectAuthority({
        callerKind: "panel",
        source: "test",
        className: "TestDO",
        objectKey: "test-key",
        method: "probeParent",
      }),
    };
    const response = await fetchable.fetch(
      new Request("http://test/test-key/__rpc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: caller.callerId,
          target: "do:test:ParentProbeDO:test-key",
          delivery: { caller },
          provenance: [caller],
          message: {
            type: "request",
            requestId: "r-probe",
            fromId: caller.callerId,
            method: "probeParent",
            args: [],
          },
        }),
      })
    );

    const responseEnvelope = (await response.json()) as { message: { result: unknown } };
    expect(responseEnvelope.message.result).toEqual({
      id: "parent-slot",
      title: "parent-slot",
      cdpEndpoint: { wsEndpoint: "ws://cdp.test" },
    });
    expect(calls).toEqual([
      {
        type: "call",
        targetId: "panel:nav-parent",
        method: "ping",
        args: [],
      },
      {
        type: "call",
        targetId: "main",
        method: "panelCdp.getCdpEndpoint",
        args: ["parent-slot"],
      },
      {
        type: "call",
        targetId: "main",
        method: "panelTree.reload",
        args: ["parent-slot"],
      },
      {
        type: "call",
        targetId: "main",
        method: "panelTree.rebuildAndReload",
        args: ["parent-slot"],
      },
    ]);
  });
});
