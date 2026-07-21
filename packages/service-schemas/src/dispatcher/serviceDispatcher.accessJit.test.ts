import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  createVerifiedCaller,
  type CallerKind,
  type ServiceDispatcher,
  type ServiceContext,
} from "@vibestudio/shared/serviceDispatcher";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { createTestServiceDispatcher } from "@vibestudio/shared/serviceDispatcherTestUtils";
import { blobstoreMethods } from "../blobstore.js";

function makeDispatcher(): ServiceDispatcher {
  const d = createTestServiceDispatcher();
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
    const d = createTestServiceDispatcher();
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
});
