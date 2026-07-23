import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

describe("worker panelTree handles", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("exports panel-shared pure runtime helpers from the worker entrypoint", async () => {
    const runtimeModule = await import("./index.js");

    expect(runtimeModule.Rpc).toBeDefined();
    expect(runtimeModule.z.object).toBeTypeOf("function");
    expect(runtimeModule.defineContract).toBeTypeOf("function");
    expect(runtimeModule.buildPanelLink("panels/editor")).toBe("/panels/editor/");
    expect(runtimeModule.parseContextId("ctx_project")).toEqual({ instanceId: "project" });
    expect(runtimeModule.isValidContextId("ctx_project")).toBe(true);
    expect(runtimeModule.getInstanceId("ctx_project")).toBe("project");
    expect(runtimeModule.normalizePath("path\\to/mixed\\slashes")).toBe("path/to/mixed/slashes");
    expect(runtimeModule.getFileName("path/to/file.txt")).toBe("file.txt");
    expect(runtimeModule.resolvePath("/root", "child")).toBe("/root/child");
  });

  it("uses the exact source-qualified sealed worker identity for outbound RPC", async () => {
    let runtimeHeader: string | null = null;
    let envelopeFrom: string | undefined;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      runtimeHeader = new Headers(init?.headers).get("x-vibestudio-runtime-id");
      envelopeFrom = JSON.parse(String(init?.body ?? "{}"))?.from;
      return respond(init, { ok: true });
    }) as typeof fetch;

    const { createWorkerRuntime } = await import("./index.js");
    const runtime = createWorkerRuntime({
      WORKER_ID: "probe",
      WORKER_SOURCE: "workers/identity-probe",
      RPC_AUTH_TOKEN: "token",
      CONTEXT_ID: "ctx",
      GATEWAY_URL: "http://server.test",
    });
    await runtime.rpc.call("main", "probe.read", []);
    runtime.destroy();

    expect(runtimeHeader).toBe("worker:workers/identity-probe:probe");
    expect(envelopeFrom).toBe("worker:workers/identity-probe:probe");
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
          runtimeEntityId: "panel:slot-a-current-entity",
        });
      }
      return respond(init, "ok");
    }) as typeof fetch;

    const { createWorkerRuntime } = await import("./index.js");
    const runtime = createWorkerRuntime({
      WORKER_ID: "agent",
      WORKER_SOURCE: "workers/agent",
      RPC_AUTH_TOKEN: "token",
      CONTEXT_ID: "ctx",
      GATEWAY_URL: "http://server.test",
    });

    const handle = runtime.panelTree.get("slot-a");
    await handle.refresh();
    expect(handle.title).toBe("Panel A");
    expect(handle.source).toBe("panels/a");
    expect(handle.kind).toBe("workspace");
    expect(handle.parentId).toBe("root");
    await handle.call["ping"]?.();
    await handle.emit("ready", { ok: true });
    runtime.destroy();

    expect(calls).toEqual([
      {
        type: "call",
        targetId: "main",
        method: "panelTree.metadata",
        args: ["slot-a"],
      },
      {
        type: "call",
        targetId: "panel:slot-a-current-entity",
        method: "ping",
        args: [],
      },
      {
        type: "emit",
        targetId: "panel:slot-a-current-entity",
        method: "ready",
        args: [{ ok: true }],
      },
    ]);
  });

  it("resolves isLoaded from the server runtime lease", async () => {
    const calls: Array<{ targetId: string; method: string; args: unknown[] }> = [];
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = parseReq(init);
      delete (body as Record<string, unknown>)["requestId"];
      delete (body as Record<string, unknown>)["idempotencyKey"];
      calls.push(body);
      if (body.method === "panelTree.getRuntimeLease") {
        return respond(init, {
          slotId: "slot-a",
          runtimeEntityId: "panel:slot-a-current-entity",
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

    const { createWorkerRuntime } = await import("./index.js");
    const runtime = createWorkerRuntime({
      WORKER_ID: "agent",
      WORKER_SOURCE: "workers/agent",
      RPC_AUTH_TOKEN: "token",
      CONTEXT_ID: "ctx",
      GATEWAY_URL: "http://server.test",
    });

    await expect(runtime.panelTree.get("slot-a").isLoaded()).resolves.toBe(true);
    runtime.destroy();

    expect(calls).toEqual([
      {
        type: "call",
        targetId: "main",
        method: "panelTree.getRuntimeLease",
        args: ["slot-a"],
      },
    ]);
  });

  it("refreshes arbitrary handles after ensureLoaded before target RPC", async () => {
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
          runtimeEntityId: "panel:slot-a-current-entity",
        });
      }
      return respond(init, { loaded: true });
    }) as typeof fetch;

    const { createWorkerRuntime } = await import("./index.js");
    const runtime = createWorkerRuntime({
      WORKER_ID: "agent",
      WORKER_SOURCE: "workers/agent",
      RPC_AUTH_TOKEN: "token",
      CONTEXT_ID: "ctx",
      GATEWAY_URL: "http://server.test",
    });

    const handle = runtime.panelTree.get("slot-a");
    await handle.ensureLoaded();
    await handle.call["ping"]?.();
    runtime.destroy();

    expect(calls).toEqual([
      {
        type: "call",
        targetId: "main",
        method: "panelTree.ensureLoaded",
        args: ["slot-a"],
      },
      {
        type: "call",
        targetId: "main",
        method: "panelTree.metadata",
        args: ["slot-a"],
      },
      {
        type: "call",
        targetId: "panel:slot-a-current-entity",
        method: "ping",
        args: [],
      },
    ]);
  });

  it("lists, hydrates children, and opens panels through the server panelTree service", async () => {
    const calls: Array<{ targetId: string; method: string; args: unknown[] }> = [];
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = parseReq(init);
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
            runtimeEntityId: "panel:root-entity",
            children: [
              {
                panelId: "child-slot",
                title: "Child",
                source: "panels/child",
                kind: "workspace",
                parentId: "root-slot",
                contextId: "ctx-child",
                runtimeEntityId: "panel:child-entity",
              },
            ],
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
            runtimeEntityId: "panel:child-entity",
          },
        ]);
      }
      if (body.method === "panelTree.create") {
        return respond(init, {
          id: "created-slot",
          title: "Created",
          kind: "workspace",
          runtimeEntityId: "panel:created-entity",
        });
      }
      return respond(init, "ok");
    }) as typeof fetch;

    const { createWorkerRuntime } = await import("./index.js");
    const runtime = createWorkerRuntime({
      WORKER_ID: "agent",
      WORKER_SOURCE: "workers/agent",
      RPC_AUTH_TOKEN: "token",
      CONTEXT_ID: "ctx",
      GATEWAY_URL: "http://server.test",
      PARENT_ID: "parent-slot",
      PARENT_KIND: "panel",
    });

    const all = await runtime.panelTree.list();
    const children = await runtime.panelTree.children("root-slot");
    const created = await runtime.openPanel("panels/new");
    runtime.destroy();

    expect(all.map((handle) => handle.id)).toEqual(["root-slot", "child-slot"]);
    expect(children.map((handle) => handle.id)).toEqual(["child-slot"]);
    expect(children[0]?.parent()?.id).toBe("root-slot");
    expect(created.id).toBe("created-slot");
    expect(created.parentId).toBe("parent-slot");
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
        args: ["panels/new", { parentId: "parent-slot" }],
      },
    ]);
  });

  it("exposes openPanel/listPanels/getPanelHandle on the worker runtime", async () => {
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
          runtimeEntityId: "panel:created-entity",
        });
      }
      return respond(init, null);
    }) as typeof fetch;

    const { createWorkerRuntime } = await import("./index.js");
    const runtime = createWorkerRuntime({
      WORKER_ID: "agent",
      WORKER_SOURCE: "workers/agent",
      RPC_AUTH_TOKEN: "token",
      CONTEXT_ID: "ctx",
      GATEWAY_URL: "http://server.test",
      PARENT_ID: "parent-slot",
      PARENT_KIND: "panel",
    });

    const direct = await runtime.openPanel("panels/direct", { focus: true });
    const listed = await runtime.listPanels();
    const browser = runtime.getPanelHandle("browser-slot", "browser");
    runtime.destroy();

    expect(direct.id).toBe("created-slot");
    expect(listed).toEqual([]);
    expect(browser.kind).toBe("browser");
    expect(browser.source).toBe("browser-slot");
    expect(calls).toEqual([
      {
        type: "call",
        targetId: "main",
        method: "panelTree.create",
        args: ["panels/direct", { focus: true, parentId: "parent-slot" }],
      },
      {
        type: "call",
        targetId: "main",
        method: "panelTree.list",
        args: [null],
      },
    ]);
  });

  it("builds panel parent handles with entity-scoped RPC and slot-scoped CDP", async () => {
    const calls: Array<{ targetId: string; method: string; args: unknown[] }> = [];
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = parseReq(init);
      delete (body as Record<string, unknown>)["requestId"];
      delete (body as Record<string, unknown>)["idempotencyKey"];
      calls.push(body);
      return respond(init, { wsEndpoint: "ws://cdp.test" });
    }) as typeof fetch;

    const { createWorkerRuntime } = await import("./index.js");
    const runtime = createWorkerRuntime({
      WORKER_ID: "agent",
      WORKER_SOURCE: "workers/agent",
      RPC_AUTH_TOKEN: "token",
      CONTEXT_ID: "ctx",
      GATEWAY_URL: "http://server.test",
      PARENT_ID: "parent-slot",
      PARENT_ENTITY_ID: "panel:parent-entity",
      PARENT_KIND: "panel",
    });

    const parent = runtime.getParent();
    expect(runtime.parent.id).toBe("parent-slot");
    expect(parent?.id).toBe("parent-slot");
    expect(runtime.getParentWithContract({ source: "panels/child" })?.id).toBe("parent-slot");
    await expect(parent?.getInfo()).resolves.toMatchObject({
      id: "parent-slot",
      parentId: null,
    });
    await parent?.call["ping"]?.();
    await expect(parent?.cdp.getCdpEndpoint()).resolves.toEqual({
      wsEndpoint: "ws://cdp.test",
    });
    await parent?.reload();
    await parent?.rebuildAndReload();
    runtime.destroy();

    expect(calls).toEqual([
      {
        type: "call",
        targetId: "panel:parent-entity",
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
