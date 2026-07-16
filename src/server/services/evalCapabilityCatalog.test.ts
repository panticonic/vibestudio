import { describe, expect, it } from "vitest";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { EVAL_SERVER_HOST_METHODS } from "./evalInvocationExposure.generated.js";
import { assertEvalServerCapabilityRegistrations } from "./evalCapabilityCatalog.js";

function liveDefinitions(): ServiceDefinition[] {
  const byService = new Map<string, Record<string, object>>();
  for (const { service, method } of EVAL_SERVER_HOST_METHODS) {
    const methods = byService.get(service) ?? {};
    methods[method] = {};
    byService.set(service, methods);
  }
  return [...byService].map(([name, methods]) => ({ name, methods }) as ServiceDefinition);
}

describe("eval server capability registration census", () => {
  it("accepts the exact reviewed server host surface", () => {
    expect(() =>
      assertEvalServerCapabilityRegistrations({ getServiceDefinitions: liveDefinitions })
    ).not.toThrow();
  });

  it("fails startup when cleanup strands a reviewed service method", () => {
    const definitions = liveDefinitions();
    const target = definitions.find((definition) => Object.keys(definition.methods).length > 0)!;
    const method = Object.keys(target.methods)[0]!;
    delete target.methods[method];

    expect(() =>
      assertEvalServerCapabilityRegistrations({ getServiceDefinitions: () => definitions })
    ).toThrow(`Reviewed server capabilities are not registered: ${target.name}.${method}`);
  });
});
