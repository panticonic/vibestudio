import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  ServiceDispatcher,
  createVerifiedCaller,
  type CallerKind,
  type ServiceContext,
} from "./serviceDispatcher.js";
import type { ServiceDefinition } from "./serviceDefinition.js";

function makeDispatcher(): ServiceDispatcher {
  const d = new ServiceDispatcher();
  const svc: ServiceDefinition = {
    name: "demo",
    description: "Demo",
    policy: { allowed: ["panel", "server"] },
    methods: {
      put: {
        description: "Store a value.",
        args: z.tuple([z.string()]),
        examples: [{ args: ["hello"] }],
      },
      restricted: {
        description: "Restricted op.",
        args: z.tuple([]),
        access: {
          restrictedTo: [{ when: "kind is app", callers: ["server"], reason: "host-managed" }],
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
        policy: { allowed: ["worker"] },
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
  it("getMethodPolicy returns the method-level policy", () => {
    const d = makeDispatcher();
    expect(d.getMethodPolicy("demo", "workerOnly")?.allowed).toEqual(["worker"]);
    expect(d.getMethodPolicy("demo", "put")?.allowed).toBeUndefined(); // no method-level gate
  });

  it("enriches args-validation errors with description + example", async () => {
    const d = makeDispatcher();
    await expect(d.dispatch(ctx("panel"), "demo", "put", [123])).rejects.toThrow(/Store a value\./);
    await expect(d.dispatch(ctx("panel"), "demo", "put", [123])).rejects.toThrow(
      /Example: demo\.put\("hello"\)/
    );
  });

  it("enriches access-denied errors with declared restrictions/approval", async () => {
    const d = makeDispatcher();
    // Worker is outside the panel/server service policy, so the JIT access hint
    // should surface the method's declared restrictions and approval metadata.
    const p = d.dispatch(ctx("worker"), "demo", "restricted", []);
    await expect(p).rejects.toThrow(/host-managed/);
    await expect(d.dispatch(ctx("worker"), "demo", "restricted", [])).rejects.toThrow(
      /needs grant/
    );
  });

  it("applies the DO userland inheritance rule through policy", async () => {
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
});
