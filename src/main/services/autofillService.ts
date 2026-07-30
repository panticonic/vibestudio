import { autofillMethods } from "@vibestudio/service-schemas/autofill";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";

export function createAutofillService(deps: {
  invoke(
    ctx: ServiceContext,
    method: keyof typeof autofillMethods,
    args: unknown[]
  ): Promise<unknown>;
}): ServiceDefinition {
  return {
    name: "autofill",
    description: "Password autofill management",
    authority: { principals: ["user", "host", "code"] },
    methods: autofillMethods,
    handler: defineServiceHandler("autofill", autofillMethods, {
      confirmSave: (ctx, args) => deps.invoke(ctx, "confirmSave", args),
      confirmFormFill: (ctx, args) => deps.invoke(ctx, "confirmFormFill", args),
    }),
  };
}
