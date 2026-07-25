import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { durableWorkMethods } from "@vibestudio/service-schemas/durableWork";
import type { DurableWorkDriver } from "./durableWorkDriver.js";

export function createDurableWorkService(driver: DurableWorkDriver): ServiceDefinition {
  return {
    name: "durableWork",
    description: "Payload-free host durable-work dispatcher diagnostics",
    authority: { principals: ["user", "host", "code"] },
    methods: durableWorkMethods,
    handler: defineServiceHandler("durableWork", durableWorkMethods, {
      inspect: () => driver.inspect(),
    }),
  };
}
