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

function readyObservation(panelId: string, source = "panels/a") {
  const browser = source.startsWith("browser:");
  return {
    panelId,
    title: "Panel A",
    source,
    kind: browser ? "browser" : "workspace",
    parentId: null,
    contextId: "ctx",
    requestedRef: "main",
    runtimeEntityId: `panel:${panelId}-current-entity`,
    attemptId: `panel:${panelId}-current-entity@build-a`,
    effectiveVersion: "ev-a",
    buildKey: "build-a",
    phase: "ready",
    updatedAt: 1,
  };
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
    await handle.call["ping"]?.();
    expect(handle.title).toBe("Panel A");
    expect(handle.source).toBe("panels/a");
    expect(handle.kind).toBe("workspace");
    expect(handle.parentId).toBe("root");
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

  it("reads canonical boot readiness from observe", async () => {
    const calls: Array<{ targetId: string; method: string; args: unknown[] }> = [];
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = parseReq(init);
      delete (body as Record<string, unknown>)["requestId"];
      delete (body as Record<string, unknown>)["idempotencyKey"];
      calls.push(body);
      if (body.method === "panelTree.observe") {
        return respond(init, readyObservation("slot-a"));
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

    await expect(runtime.panelTree.get("slot-a").observe()).resolves.toMatchObject({
      phase: "ready",
    });
    runtime.destroy();

    expect(calls).toEqual([
      {
        type: "call",
        targetId: "main",
        method: "panelTree.observe",
        args: ["slot-a"],
      },
    ]);
  });

  it("binds arbitrary handles to the runtime entity reported by observe", async () => {
    const calls: Array<{ type?: string; targetId: string; method: string; args: unknown[] }> = [];
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = parseReq(init);
      calls.push({
        type: body.type,
        targetId: body.targetId,
        method: body.method,
        args: body.args,
      });
      if (body.method === "panelTree.observe") {
        return respond(init, {
          panelId: "slot-a",
          title: "Panel A",
          source: "panels/a",
          kind: "workspace",
          parentId: "root",
          contextId: "ctx",
          requestedRef: "main",
          runtimeEntityId: "panel:slot-a-current-entity",
          attemptId: "panel:slot-a-current-entity@build-a",
          effectiveVersion: "ev-a",
          buildKey: "build-a",
          phase: "ready",
          updatedAt: 1,
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
    await handle.observe();
    await handle.call["ping"]?.();
    runtime.destroy();

    expect(calls).toEqual([
      {
        type: "call",
        targetId: "main",
        method: "panelTree.observe",
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
          observation: readyObservation("created-slot", "panels/direct"),
        });
      }
      if (body.method === "panelTree.focus") {
        return respond(init, readyObservation("browser-slot", "browser:https://example.com"));
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
          observation: readyObservation("created-slot", "panels/direct"),
        });
      }
      if (body.method === "panelTree.focus") {
        return respond(init, readyObservation("browser-slot", "browser:https://example.com"));
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

    const direct = await runtime.openPanel("panels/direct", {
      focus: true,
      placement: { disposition: "side", preferredWidth: 640 },
    });
    const listed = await runtime.listPanels();
    const browser = runtime.getPanelHandle("browser-slot", "browser");
    await browser.focus({ placement: { disposition: "split-below" } });
    runtime.destroy();

    expect(direct.id).toBe("created-slot");
    expect(listed).toEqual([]);
    expect(browser.kind).toBe("browser");
    expect(browser.source).toBe("https://example.com");
    expect(calls).toEqual([
      {
        type: "call",
        targetId: "main",
        method: "panelTree.create",
        args: [
          "panels/direct",
          {
            focus: true,
            parentId: "parent-slot",
            placement: { disposition: "side", preferredWidth: 640 },
          },
        ],
      },
      {
        type: "call",
        targetId: "main",
        method: "panelTree.list",
        args: [null],
      },
      {
        type: "call",
        targetId: "main",
        method: "panelTree.focus",
        args: [
          "browser-slot",
          {
            anchorPanelId: "parent-slot",
            placement: { disposition: "split-below" },
          },
        ],
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
      if (body.method === "panelCdp.getCdpEndpoint") {
        return respond(init, { wsEndpoint: "ws://cdp.test" });
      }
      if (body.method === "panelTree.reload" || body.method === "panelTree.rebuildPanel") {
        return respond(init, readyObservation("parent-slot", "panels/parent"));
      }
      return respond(init, undefined);
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
    expect(parent).toMatchObject({ id: "parent-slot", parentId: null });
    await parent?.call["ping"]?.();
    await expect(parent?.cdp.getCdpEndpoint()).resolves.toEqual({
      wsEndpoint: "ws://cdp.test",
    });
    await parent?.reload();
    await parent?.rebuild();
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
        method: "panelTree.rebuildPanel",
        args: ["parent-slot"],
      },
    ]);
  });
});
