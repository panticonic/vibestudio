import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createTypedServiceClient,
  defineServiceMethods,
  fixedPreparedAuthorityRequirement,
  preparedAuthoritySelectorKey,
  selectedPreparedAuthorityRequirement,
} from "./typedServiceClient.js";
import { createLazyTypedServiceClient } from "./lazyTypedServiceClient.js";
import {
  fixedPreparedAuthoritySelection,
  selectedPreparedAuthoritySelection,
} from "./serviceDefinition.js";
import { relationship, requirementForPrincipals } from "./authorization.js";

const methods = defineServiceMethods({
  ping: { args: z.tuple([]), returns: z.literal("pong") },
  echo: { args: z.tuple([z.string(), z.number().optional()]) },
  "units.list": { args: z.tuple([]), returns: z.array(z.object({ name: z.string() })) },
  "units.logs": {
    args: z.tuple([z.string(), z.object({ limit: z.number() }).optional()]),
  },
  "hostTargets.selection.get": { args: z.tuple([z.string()]) },
  voidResult: { args: z.tuple([]), returns: z.void() },
  nullableResult: { args: z.tuple([]), returns: z.string().nullable() },
});

describe("createTypedServiceClient", () => {
  it("forwards flat and dotted methods with the full method name", async () => {
    const call = vi.fn(async (_s: string, method: string) => (method === "ping" ? "pong" : null));
    const client = createTypedServiceClient("demo", methods, call);

    await expect(client.ping()).resolves.toBe("pong");
    await client.units.logs("workers/foo", { limit: 5 });
    await client.hostTargets.selection.get("electron");

    expect(call).toHaveBeenCalledWith("demo", "ping", []);
    expect(call).toHaveBeenCalledWith("demo", "units.logs", ["workers/foo", { limit: 5 }]);
    expect(call).toHaveBeenCalledWith("demo", "hostTargets.selection.get", ["electron"]);
  });

  it("allows omitting trailing optional arguments", async () => {
    const call = vi.fn(async () => null);
    const client = createTypedServiceClient("demo", methods, call);
    await client.echo("hello");
    expect(call).toHaveBeenCalledWith("demo", "echo", ["hello"]);
  });

  it("rejects invalid outbound arguments before invoking the transport", async () => {
    const call = vi.fn(async () => null);
    const client = createTypedServiceClient("demo", methods, call);

    await expect(client.echo(42 as never)).rejects.toThrow(
      'method "echo" arguments failed schema validation. Expected call shape: demo.echo(arg1, arg2)'
    );
    expect(call).not.toHaveBeenCalled();
  });

  it("renders object request fields in outbound schema errors", async () => {
    const objectMethods = defineServiceMethods({
      inspect: {
        args: z.tuple([
          z.object({
            state: z.object({ eventId: z.string() }),
            repoPath: z.string(),
            limit: z.number().optional(),
          }),
        ]),
      },
    });
    const client = createTypedServiceClient("vcs", objectMethods, async () => null);

    await expect(client.inspect({ state: {} } as never)).rejects.toThrow(
      "Expected call shape: vcs.inspect({ state, repoPath, limit? })"
    );
  });

  it("rejects invalid inbound return values with the service and method name", async () => {
    const client = createTypedServiceClient("demo", methods, async () => "not-pong");

    await expect(client.ping()).rejects.toThrow(
      'method "ping" return value failed schema validation'
    );
  });

  it("decodes wire null as logical void without changing nullable domain results", async () => {
    const client = createTypedServiceClient("demo", methods, async () => null);

    await expect(client.voidResult()).resolves.toBeUndefined();
    await expect(client.nullableResult()).resolves.toBeNull();
  });

  it("rejects method names that collide with a group prefix", () => {
    const colliding = defineServiceMethods({
      "units.list": { args: z.tuple([]) },
      units: { args: z.tuple([]) },
    });
    expect(() => createTypedServiceClient("demo", colliding, async () => null)).toThrow(/collides/);
  });
});

describe("createLazyTypedServiceClient", () => {
  it("is enumerable before loading and validates through one shared schema load", async () => {
    const loadMethods = vi.fn(async () => methods);
    const call = vi.fn(async (_service: string, method: string) =>
      method === "ping" ? "pong" : null
    );
    const client = createLazyTypedServiceClient(
      "demo",
      Object.keys(methods) as (keyof typeof methods & string)[],
      loadMethods,
      call
    );

    expect(Object.keys(client)).toEqual([
      "ping",
      "echo",
      "units",
      "hostTargets",
      "voidResult",
      "nullableResult",
    ]);
    expect(loadMethods).not.toHaveBeenCalled();

    await expect(client.echo(42 as never)).rejects.toThrow(/arguments failed schema validation/);
    expect(call).not.toHaveBeenCalled();
    await expect(client.ping()).resolves.toBe("pong");
    expect(loadMethods).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith("demo", "ping", []);
  });
});

describe("preparedAuthoritySelectorKey", () => {
  it("accepts exact capabilities and colon-terminated namespaces", () => {
    expect(preparedAuthoritySelectorKey({ capability: "workspace.read" })).toBe(
      "capability:workspace.read"
    );
    expect(preparedAuthoritySelectorKey({ capabilityPrefix: "workspace-service:" })).toBe(
      "prefix:workspace-service:"
    );
  });

  it("rejects empty, broad, and ambiguous selectors", () => {
    expect(() => preparedAuthoritySelectorKey({ capability: "" })).toThrow(/must not be empty/);
    expect(() => preparedAuthoritySelectorKey({ capabilityPrefix: "workspace-service" })).toThrow(
      /end with ':'/
    );
    expect(() =>
      preparedAuthoritySelectorKey({
        capability: "workspace.read",
        capabilityPrefix: "workspace:",
      } as never)
    ).toThrow(/exactly one/);
  });
});

describe("prepared authority constructors", () => {
  it("separates fixed resource selection from complete dynamic authority selection", () => {
    const fixedRequirement = requirementForPrincipals(["code"], "external.open");
    expect(fixedPreparedAuthorityRequirement(fixedRequirement)).toBe(fixedRequirement);
    expect(
      fixedPreparedAuthoritySelection({
        capability: "external.open",
        resourceKey: "origin:https://example.com",
      })
    ).not.toHaveProperty("requirement");

    expect(
      selectedPreparedAuthoritySelection({
        capability: "workspace-service:demo",
        resourceKey: "do:demo",
        requirement: {
          kind: "all",
          requirements: [
            requirementForPrincipals(["code"], "workspace-service:demo"),
            relationship("code-source", "workers/demo"),
          ],
        },
      })
    ).toHaveProperty("requirement");
  });

  it("rejects incomplete or mismatched dynamic selections at construction", () => {
    expect(() =>
      selectedPreparedAuthoritySelection({
        capability: "workspace-service:demo",
        resourceKey: "do:demo",
        requirement: relationship("code-source", "workers/demo"),
      })
    ).toThrow(/has no capability leaf/);
    expect(() =>
      selectedPreparedAuthoritySelection({
        capability: "workspace-service:demo",
        resourceKey: "do:demo",
        requirement: requirementForPrincipals(["code"], "workspace-service:other"),
      })
    ).toThrow(/contains capability 'workspace-service:other'/);
    expect(() => selectedPreparedAuthorityRequirement([])).toThrow(/at least one principal/);
  });
});
