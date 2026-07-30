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

function workspaceDetailFor(panelId: string, source = "panels/a") {
  return {
    slot: { parent_slot_id: null, current_entity_title: "Panel A" },
    currentHistory: {
      source,
      context_id: "ctx",
      state_args: "{}",
      options: '{"ref":"main"}',
    },
    entity: {
      id: `panel:${panelId}-current-entity`,
      source: { effectiveVersion: "ev-a" },
      activeBuildKey: "build-a",
    },
  };
}

function readyRuntimeSlot() {
  return {
    lease: { holderLabel: "Headless", platform: "headless", supportsCdp: true },
    observation: {
      url: "http://panel.test/",
      loading: false,
      boot: { phase: "ready", updatedAt: 1 },
    },
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
      if (body.method === "workers.resolveService") {
        return respond(init, {
          kind: "durable-object",
          targetId: "do:vibestudio/internal:WorkspaceDO:workspace",
        });
      }
      if (body.method === "panelTreeDetail") {
        return respond(init, {
          slot: { parent_slot_id: "root", current_entity_title: "Panel A" },
          currentHistory: { source: "panels/a", context_id: "ctx", options: null },
          entity: {
            id: "panel:slot-a-current-entity",
            source: { effectiveVersion: "ev-a" },
          },
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
        method: "workers.resolveService",
        args: ["vibestudio.workspace-state.v1", null],
      },
      {
        type: "call",
        targetId: "do:vibestudio/internal:WorkspaceDO:workspace",
        method: "panelTreeDetail",
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
      if (body.method === "workers.resolveService")
        return respond(init, {
          kind: "durable-object",
          targetId: "do:vibestudio/internal:WorkspaceDO:workspace",
        });
      if (body.method === "panelTreeDetail")
        return respond(init, workspaceDetailFor("slot-a"));
      if (body.method === "panelRuntime.observeSlot") return respond(init, readyRuntimeSlot());
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

    expect(calls.map(({ method }) => method)).toEqual([
      "workers.resolveService",
      "panelTreeDetail",
      "panelRuntime.observeSlot",
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
      if (body.method === "workers.resolveService")
        return respond(init, {
          kind: "durable-object",
          targetId: "do:vibestudio/internal:WorkspaceDO:workspace",
        });
      if (body.method === "panelTreeDetail")
        return respond(init, workspaceDetailFor("slot-a"));
      if (body.method === "panelRuntime.observeSlot") return respond(init, readyRuntimeSlot());
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

    expect(calls.at(-1)).toEqual({
      type: "call",
      targetId: "panel:slot-a-current-entity",
      method: "ping",
      args: [],
    });
  });

  it("lists, hydrates children, and opens panels through the server panelTree service", async () => {
    const calls: Array<{ targetId: string; method: string; args: unknown[] }> = [];
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = parseReq(init);
      delete (body as Record<string, unknown>)["requestId"];
      delete (body as Record<string, unknown>)["idempotencyKey"];
      calls.push(body);
      if (body.method === "workers.resolveService") {
        return respond(init, {
          kind: "durable-object",
          targetId: "do:vibestudio/internal:WorkspaceDO:workspace",
        });
      }
      if (body.method === "panelTreeRootGroups") {
        return respond(init, {
          revision: 1,
          groups: [{ ownerUserId: null, rootCount: 1 }],
          nextCursor: null,
        });
      }
      if (body.method === "panelTreePage") {
        const group = (body.args[0] as { group: { kind: string; parentSlotId?: string } }).group;
        const nodes =
          group.kind === "roots"
            ? [
                {
                  slotId: "root-slot",
                  title: "Root",
                  source: "panels/root",
                  kind: "workspace",
                  parentSlotId: null,
                  ownerUserId: null,
                  contextId: "ctx-root",
                  runtimeEntityId: "panel:root-entity",
                  createdAt: 1,
                  childCount: 1,
                },
              ]
            : group.parentSlotId === "root-slot"
              ? [
                  {
                    slotId: "child-slot",
                    title: "Child",
                    source: "panels/child",
                    kind: "workspace",
                    parentSlotId: "root-slot",
                    ownerUserId: null,
                    contextId: "ctx-child",
                    runtimeEntityId: "panel:child-entity",
                    createdAt: 1,
                    childCount: 0,
                  },
                ]
              : [];
        return respond(init, { revision: 1, group, nodes, nextCursor: null });
      }
      if (
        body.method === "runtime.reserveEntity" ||
        body.method === "runtime.activateReservedEntity"
      ) {
        const spec = body.args[0] as { key: string; contextId?: string };
        return respond(init, {
          id: `panel:${spec.key}`,
          contextId: spec.contextId ?? "ctx-created",
          source: {
            effectiveVersion: body.method === "runtime.reserveEntity" ? "" : "ev-created",
          },
          ...(body.method === "runtime.reserveEntity" ? {} : { buildKey: "build-created" }),
        });
      }
      if (body.method === "build.getPanelMetadata") return respond(init, { title: "Created" });
      if (body.method === "panelTreeDetail")
        return respond(init, workspaceDetailFor(String(body.args[0]), "panels/new"));
      if (body.method === "panelRuntime.ensureSlot")
        return respond(init, { status: "assigned", lease: null });
      if (body.method === "panelRuntime.observeSlot") return respond(init, readyRuntimeSlot());
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

    const roots = await runtime.panelTree.page({
      group: { kind: "roots", ownerUserId: null },
      limit: 50,
    });
    const children = await runtime.panelTree.page({
      group: { kind: "children", parentSlotId: "root-slot" },
      limit: 50,
    });
    const created = await runtime.openPanel("panels/new");
    runtime.destroy();

    expect(roots.entries.map(({ handle }) => handle.id)).toEqual(["root-slot"]);
    expect(children.entries.map(({ handle }) => handle.id)).toEqual(["child-slot"]);
    expect(children.entries[0]?.handle.parent()?.id).toBe("root-slot");
    expect(created.id).toMatch(/^parent-slot\/panels~new\//);
    expect(created.parentId).toBe("parent-slot");
    expect(calls.map(({ method }) => method)).toContain("runtime.reserveEntity");
    expect(calls.map(({ method }) => method)).toContain("slotCreate");
    expect(calls.map(({ method }) => method)).toContain("runtime.activateReservedEntity");
    expect(calls.map(({ method }) => method)).not.toContain("panelTree.create");
  });

  it("exposes openPanel/getPanelHandle on the worker runtime", async () => {
    const calls: Array<{ targetId: string; method: string; args: unknown[] }> = [];
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = parseReq(init);
      delete (body as Record<string, unknown>)["requestId"];
      delete (body as Record<string, unknown>)["idempotencyKey"];
      calls.push(body);
      if (body.method === "workers.resolveService") {
        return respond(init, {
          kind: "durable-object",
          targetId: "do:vibestudio/internal:WorkspaceDO:workspace",
        });
      }
      if (body.method === "panelTreeRootGroups") {
        return respond(init, { revision: 1, groups: [], nextCursor: null });
      }
      if (
        body.method === "runtime.reserveEntity" ||
        body.method === "runtime.activateReservedEntity"
      ) {
        const spec = body.args[0] as { key: string; contextId?: string };
        return respond(init, {
          id: `panel:${spec.key}`,
          contextId: spec.contextId ?? "ctx-created",
          source: {
            effectiveVersion: body.method === "runtime.reserveEntity" ? "" : "ev-created",
          },
          ...(body.method === "runtime.reserveEntity" ? {} : { buildKey: "build-created" }),
        });
      }
      if (body.method === "build.getPanelMetadata") return respond(init, { title: "Created" });
      if (body.method === "panelTreeDetail") {
        const panelId = String(body.args[0]);
        return respond(
          init,
          workspaceDetailFor(
            panelId,
            panelId === "browser-slot" ? "browser:https://example.com" : "panels/direct"
          )
        );
      }
      if (body.method === "panelRuntime.ensureSlot")
        return respond(init, { status: "assigned", lease: null });
      if (body.method === "panelRuntime.observeSlot") return respond(init, readyRuntimeSlot());
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
    const browser = runtime.getPanelHandle("browser-slot", "browser");
    await browser.focus({ placement: { disposition: "split-below" } });
    runtime.destroy();

    expect(direct.id).toMatch(/^parent-slot\/panels~direct\//);
    expect(browser.kind).toBe("browser");
    expect(browser.source).toBe("https://example.com");
    expect(calls.map(({ method }) => method)).not.toContain("panelTree.create");
    expect(calls).toContainEqual({
      type: "call",
      targetId: "main",
      method: "view.focusPanel",
      args: [
        "browser-slot",
        {
          anchorPanelId: "parent-slot",
          placement: { disposition: "split-below" },
        },
      ],
    });
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
      if (body.method === "workers.resolveService")
        return respond(init, {
          kind: "durable-object",
          targetId: "do:vibestudio/internal:WorkspaceDO:workspace",
        });
      if (body.method === "panelTreeDetail")
        return respond(init, workspaceDetailFor("parent-slot", "panels/parent"));
      if (body.method === "panelRuntime.observeSlot") return respond(init, readyRuntimeSlot());
      if (body.method === "build.getPanelMetadata") return respond(init, { title: "Parent" });
      if (body.method === "runtime.createEntity") {
        const spec = body.args[0] as { key: string };
        return respond(init, {
          id: `panel:${spec.key}`,
          contextId: "ctx",
          source: { effectiveVersion: "ev-a" },
          buildKey: "build-a",
        });
      }
      if (body.method === "slotCommitPreparedNavigation") {
        const input = body.args[0] as {
          expectedCurrentEntityId: string;
          mutation: { entry: { entityId: string } };
        };
        return respond(init, {
          previousEntityId: input.expectedCurrentEntityId,
          currentEntityId: input.mutation.entry.entityId,
        });
      }
      if (body.method === "panelRuntime.ensureSlot")
        return respond(init, { status: "assigned", lease: null });
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

    expect(calls).toContainEqual({
      type: "call",
      targetId: "panel:parent-entity",
      method: "ping",
      args: [],
    });
    expect(calls).toContainEqual({
      type: "call",
      targetId: "main",
      method: "panelCdp.getCdpEndpoint",
      args: ["parent-slot"],
    });
    expect(calls.map(({ method }) => method)).toContain("runtime.supervision.restart");
    expect(calls.map(({ method }) => method)).toContain("slotCommitPreparedNavigation");
    expect(calls.map(({ method }) => method)).not.toContain("panelTree.reload");
    expect(calls.map(({ method }) => method)).not.toContain("panelTree.rebuildPanel");
  });
});
