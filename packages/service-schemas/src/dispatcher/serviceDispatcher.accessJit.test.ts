import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import {
  createVerifiedCaller,
  isDeferredResult,
  ServiceDispatcher,
  type CallerKind,
  type ServiceContext,
} from "@vibestudio/shared/serviceDispatcher";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import {
  createTestServiceDispatcher,
  testAuthority,
} from "@vibestudio/shared/serviceDispatcherTestUtils";
import { blobstoreMethods } from "../blobstore.js";
import { requirementForPrincipals } from "@vibestudio/shared/authorization";

function makeDispatcher(): ServiceDispatcher {
  const d = createTestServiceDispatcher({
    openMethods: ["demo.put", "demo.restricted", "demo.workerOnly", "demo.peek"],
  });
  const svc: ServiceDefinition = {
    name: "demo",
    description: "Demo",
    authority: { principals: ["code", "host"] },
    methods: {
      put: {
        description: "Store a value.",
        args: z.tuple([z.string()]),
        examples: [{ args: ["hello"] }],
      },
      restricted: {
        description: "Restricted op.",
        args: z.tuple([]),
        authority: { principals: ["host"] },
        access: {
          restrictedTo: [{ when: "kind is app", principals: ["host"], reason: "host-managed" }],
          approval: [
            {
              capability: "demo.cap",
              reason: "needs grant",
              operation: { kind: "runtime", verb: "Do thing" },
            },
          ],
        },
      },
      workerOnly: {
        description: "Worker only.",
        args: z.tuple([]),
        authority: { principals: ["code"] },
      },
      peek: {
        description: "Read-only peek.",
        args: z.tuple([]),
        access: { sensitivity: "read" },
      },
    },
    handler: async () => "ok",
  };
  d.registerService(svc);
  d.markInitialized();
  return d;
}

const ctx = (kind: CallerKind): ServiceContext => ({ caller: createVerifiedCaller("t", kind) });

describe("dispatcher: access descriptor + JIT errors", () => {
  it("retains method-level authority on the canonical definition", () => {
    const d = makeDispatcher();
    const methods = d.getServiceDefinitions().find((entry) => entry.name === "demo")?.methods;
    expect(methods?.["workerOnly"]?.authority).toEqual({ principals: ["code"] });
    expect(methods?.["put"]?.authority).toBeUndefined();
  });

  it("enriches args-validation errors with description + example", async () => {
    const d = makeDispatcher();
    await expect(d.dispatch(ctx("panel"), "demo", "put", [123])).rejects.toThrow(/Store a value\./);
    await expect(d.dispatch(ctx("panel"), "demo", "put", [123])).rejects.toThrow(
      /Example: demo\.put\("hello"\)/
    );
  });

  it("teaches the byte-only one-argument putBase64 call on an arity error", async () => {
    const d = createTestServiceDispatcher({ openMethods: ["blobstore.putBase64"] });
    d.registerService({
      name: "blobstore",
      authority: { principals: ["code"] },
      methods: { putBase64: blobstoreMethods.putBase64 },
      handler: async () => null,
    });
    d.markInitialized();

    const call = () =>
      d.dispatch(ctx("panel"), "blobstore", "putBase64", [
        "iVBORw0KGgo=",
        { contentType: "image/png" },
      ]);
    await expect(call()).rejects.toThrow(/exactly one base64 string/);
    await expect(call()).rejects.toThrow(/do not pass MIME\/options metadata/);
    await expect(call()).rejects.toThrow(/Example: blobstore\.putBase64\("iVBORw0KGgo="\)/);
  });

  it("enriches access-denied errors with declared restrictions/approval", async () => {
    const d = makeDispatcher();
    // The method requires a host principal, so a code-originated worker is
    // denied while the declared restriction and acquisition hint stay visible.
    const p = d.dispatch(ctx("worker"), "demo", "restricted", []);
    await expect(p).rejects.toThrow(/host-managed/);
    await expect(d.dispatch(ctx("worker"), "demo", "restricted", [])).rejects.toThrow(
      /needs grant/
    );
  });

  it("authorizes DO code through the declared code principal", async () => {
    const d = makeDispatcher();
    await expect(d.dispatch(ctx("do"), "demo", "workerOnly", [])).resolves.toBe("ok");
    await expect(d.dispatch(ctx("do"), "demo", "put", ["x"])).resolves.toBe("ok");
  });

  it("read-only mode allows readonly methods and blocks the rest (default-deny)", async () => {
    const d = makeDispatcher();
    const ro = (kind: CallerKind): ServiceContext => ({
      caller: createVerifiedCaller("t", kind),
      readOnly: true,
    });
    await expect(d.dispatch(ro("panel"), "demo", "peek", [])).resolves.toBe("ok");
    await expect(d.dispatch(ro("panel"), "demo", "put", ["x"])).rejects.toThrow(
      /Blocked in read-only mode/
    );
  });

  it("preflights the same contract without prompting, consuming, or invoking", async () => {
    const acquire = vi.fn();
    const consume = vi.fn();
    const handler = vi.fn(async () => "effect");
    const d = new ServiceDispatcher({
      tierLookup: () => ({ tier: "gated", session: "family", rationale: "test" }),
      capabilityLookup: (method) => `test:${method}`,
    });
    d.setAuthorityResolver(({ caller, capability, resourceKey }) => ({
      ...testAuthority(caller, capability, resourceKey),
      grants: [],
    }));
    d.setAuthorityAcquirer({ request: vi.fn(), acquire, consume, invalidate: vi.fn() });
    d.registerService({
      name: "dry",
      authority: { principals: ["code"] },
      methods: {
        write: {
          description: "Write a thing",
          args: z.tuple([z.string()]),
          access: {
            sensitivity: "write",
            approval: [{ reason: "review", operation: { kind: "workspace", verb: "write it" } }],
          },
        },
      },
      handler,
    });
    d.markInitialized();

    await expect(d.preflightAuthority(ctx("worker"), "dry", "write", ["x"])).resolves.toEqual({
      decision: "acquirable",
      leaves: [
        {
          capability: "test:dry.write",
          resourceKey: "test:dry.write",
          status: "acquirable",
          tier: "gated",
        },
      ],
      severityPreview: "sensitive",
      wouldPrompt: { cardType: "permission.gated", renderedAction: "write it" },
    });
    expect(acquire).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("keeps discovery open while gating a dynamically selected authority leaf", async () => {
    const d = new ServiceDispatcher({
      tierLookup: () => ({ tier: "open", session: "family", rationale: "discovery" }),
    });
    d.setAuthorityResolver(({ caller, capability, resourceKey }) => ({
      ...testAuthority(caller, capability, resourceKey),
      grants: [],
    }));
    d.setAuthorityAcquirer({
      request: vi.fn(),
      acquire: vi.fn(),
      consume: vi.fn(),
      invalidate: vi.fn(),
    });
    const methodCapability = "service:discovery.resolve";
    d.registerService({
      name: "discovery",
      authority: { principals: ["code"] },
      methods: {
        resolve: {
          args: z.tuple([z.string()]),
          authority: {
            requirement: requirementForPrincipals(["code"], methodCapability),
            resource: { kind: "literal", key: methodCapability },
            prepared: {
              resolver: "discovery.resolve.dynamic",
              leaves: [
                {
                  capability: "workspace-service:*",
                  requirement: { kind: "selected", principals: ["code"] },
                  tier: "gated",
                },
              ],
            },
          },
          access: { sensitivity: "read" },
        },
      },
      authorityPreparation: {
        "discovery.resolve.dynamic": () => [
          {
            capability: "workspace-service:local",
            resourceKey: "do:workers/local:LocalDO:main",
            requirement: requirementForPrincipals(["code"], "workspace-service:local"),
          },
        ],
      },
      handler: vi.fn(async () => "resolved"),
    });
    d.markInitialized();

    await expect(
      d.preflightAuthority(ctx("worker"), "discovery", "resolve", ["local"])
    ).resolves.toEqual({
      decision: "acquirable",
      leaves: [
        {
          capability: methodCapability,
          resourceKey: methodCapability,
          status: "granted",
          tier: "open",
        },
        {
          capability: "workspace-service:local",
          resourceKey: "do:workers/local:LocalDO:main",
          status: "acquirable",
          tier: "gated",
        },
      ],
      severityPreview: "sensitive",
      wouldPrompt: {
        cardType: "permission.gated",
        renderedAction: "use Local",
      },
    });
  });

  it("re-resolves prepared host state after acquisition before invoking the handler", async () => {
    let selectedTarget = "target-a";
    const grantedResources = new Set<string>();
    const acquiredResources: string[] = [];
    const handler = vi.fn(async () => "resolved");
    const d = new ServiceDispatcher({
      tierLookup: () => ({ tier: "open", session: "family", rationale: "discovery" }),
    });
    d.setAuthorityResolver(({ caller, capability, resourceKey }) => {
      const resolved = testAuthority(caller, capability, resourceKey);
      return capability === "workspace-service:local" && !grantedResources.has(resourceKey)
        ? { ...resolved, grants: [] }
        : resolved;
    });
    d.setAuthorityAcquirer({
      request: vi.fn(),
      acquire: vi.fn(async ({ resource }) => {
        acquiredResources.push(resource.key);
        grantedResources.add(resource.key);
        if (resource.key === "workspace:target-a") selectedTarget = "target-b";
        return { state: "decided" as const, decision: "session" as const };
      }),
      consume: vi.fn(),
      invalidate: vi.fn(),
    });
    const methodCapability = "service:dynamic.resolve";
    d.registerService({
      name: "dynamic",
      authority: { principals: ["code"] },
      methods: {
        resolve: {
          args: z.tuple([]),
          authority: {
            requirement: requirementForPrincipals(["code"], methodCapability),
            resource: { kind: "literal", key: methodCapability },
            prepared: {
              resolver: "dynamic.resolve.target",
              leaves: [
                {
                  capability: "workspace-service:*",
                  requirement: { kind: "selected", principals: ["code"] },
                  tier: "gated",
                },
              ],
            },
          },
          access: { sensitivity: "read" },
        },
      },
      authorityPreparation: {
        "dynamic.resolve.target": () => [
          {
            capability: "workspace-service:local",
            resourceKey: `workspace:${selectedTarget}`,
            requirement: requirementForPrincipals(["code"], "workspace-service:local"),
          },
        ],
      },
      handler,
    });
    d.markInitialized();

    await expect(
      d.dispatch({ ...ctx("worker"), authorityAcquisition: "wait" }, "dynamic", "resolve", [])
    ).resolves.toBe("resolved");
    expect(acquiredResources).toEqual(["workspace:target-a", "workspace:target-b"]);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("returns EACQUIRE immediately to installed code while interactive origins suspend", async () => {
    type AuthorityAcquirer = Parameters<ServiceDispatcher["setAuthorityAcquirer"]>[0];
    const request: AuthorityAcquirer["request"] = vi.fn((input) => ({
      acquisitionId: `acq:${input.snapshotDigest}`,
      ownerRuntimeId: input.caller.runtime.id,
      snapshotDigest: input.snapshotDigest,
      capability: input.snapshot.capability,
      resourceKey: input.snapshot.resourceKey,
      tier: input.tier,
      cardType: "permission.gated" as const,
      renderedAction: input.renderedAction,
      pending: true,
    }));
    const acquire: AuthorityAcquirer["acquire"] = vi.fn(async (input) => ({
      state: "closed" as const,
      info: request(input),
    }));
    const d = new ServiceDispatcher({
      tierLookup: () => ({ tier: "gated", session: "family", rationale: "test" }),
      capabilityLookup: (method) => `test:${method}`,
    });
    d.setAuthorityResolver(({ caller, capability, resourceKey }) => ({
      ...testAuthority(caller, capability, resourceKey),
      grants: [],
    }));
    d.setAuthorityAcquirer({ request, acquire, consume: vi.fn(), invalidate: vi.fn() });
    d.registerService({
      name: "acquisition",
      authority: { principals: ["code", "user"] },
      methods: { act: { args: z.tuple([]), access: { sensitivity: "write" } } },
      handler: vi.fn(async () => "effect"),
    });
    d.markInitialized();

    await expect(d.dispatch(ctx("worker"), "acquisition", "act", [])).rejects.toMatchObject({
      code: "EACQUIRE",
      errorData: { acquisition: { pending: true } },
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(acquire).not.toHaveBeenCalled();

    const sessionCtx: ServiceContext = {
      caller: createVerifiedCaller("t", "agent", null, null, null, true),
    };
    await expect(d.dispatch(sessionCtx, "acquisition", "act", [])).rejects.toMatchObject({
      code: "EACQUIRE",
      errorData: { acquisition: { pending: true } },
    });
    expect(acquire).toHaveBeenCalledTimes(1);

    const userCtx: ServiceContext = {
      caller: createVerifiedCaller("shell:user", "shell", null, null, {
        userId: "usr_test",
        handle: "test",
      }),
    };
    await expect(d.dispatch(userCtx, "acquisition", "act", [])).rejects.toMatchObject({
      code: "EACQUIRE",
      errorData: { acquisition: { pending: true } },
    });
    expect(acquire).toHaveBeenCalledTimes(2);
  });

  it("defers the complete authority acquisition and handler continuation exactly once", async () => {
    let granted = false;
    let parkedWork: ((signal: AbortSignal) => Promise<unknown>) | undefined;
    const handler = vi.fn(async (handlerCtx: ServiceContext) => {
      expect(handlerCtx.deferral).toBeUndefined();
      expect(handlerCtx.authorityAcquisition).toBe("wait");
      return "effect";
    });
    const d = new ServiceDispatcher({
      tierLookup: () => ({ tier: "gated", session: "family", rationale: "test" }),
      capabilityLookup: (method) => `test:${method}`,
    });
    d.setAuthorityResolver(({ caller, capability, resourceKey }) => {
      const resolved = testAuthority(caller, capability, resourceKey);
      return granted ? resolved : { ...resolved, grants: [] };
    });
    d.setAuthorityAcquirer({
      request: vi.fn(),
      acquire: vi.fn(async () => {
        granted = true;
        return { state: "decided" as const, decision: "session" as const };
      }),
      consume: vi.fn(),
      invalidate: vi.fn(),
    });
    d.registerService({
      name: "deferred-acquisition",
      authority: { principals: ["code"] },
      methods: { act: { args: z.tuple([]), access: { sensitivity: "write" } } },
      handler,
    });
    d.markInitialized();
    const installedCodeCtx: ServiceContext = {
      caller: createVerifiedCaller("t", "do"),
      deferral: {
        canDefer: true,
        run: vi.fn((work) => {
          parkedWork = work;
          return {
            [Symbol.for("vibestudio.rpc.deferredResult")]: true,
            requestId: "request-1",
          } as never;
        }),
      },
    };

    const acknowledged = await d.dispatch(installedCodeCtx, "deferred-acquisition", "act", []);
    expect(isDeferredResult(acknowledged)).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    expect(parkedWork).toBeTypeOf("function");
    await expect(parkedWork!(new AbortController().signal)).resolves.toBe("effect");
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
