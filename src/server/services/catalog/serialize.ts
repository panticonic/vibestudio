/**
 * Shared serialization of service definitions / method schemas to the wire
 * (JSON-Schema for args/returns + literate doc/access metadata).
 *
 * The single place that turns a `MethodSchema` into agent-facing JSON, used by
 * the capability catalog and the `docs` service's listServices/describeService
 * (these absorbed the former `meta` service). Emits the literate doc fields
 * (`access`, `examples`, `errors`, `seeAlso`) as conditional
 * spreads, so output is byte-identical for methods that don't declare them.
 */
import { zodToJsonSchema as convertZodToJsonSchema } from "zod-to-json-schema";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import type { MethodSchema } from "@vibestudio/shared/typedServiceClient";

export function serializeMethod(method: MethodSchema) {
  return {
    ...(method.description ? { description: method.description } : {}),
    ...(method.authority ? { authority: method.authority } : {}),
    ...(method.access ? { access: method.access } : {}),
    ...(method.examples ? { examples: method.examples } : {}),
    ...(method.errors ? { errors: method.errors } : {}),
    ...(method.seeAlso ? { seeAlso: method.seeAlso } : {}),
    argsSchema: convertZodToJsonSchema(method.args, { target: "openApi3" }) as Record<
      string,
      unknown
    >,
    ...(method.returns
      ? {
          returnsSchema: convertZodToJsonSchema(method.returns, {
            target: "openApi3",
          }) as Record<string, unknown>,
        }
      : {}),
  };
}

export function serializeDef(def: ServiceDefinition) {
  return {
    name: def.name,
    ...(def.description ? { description: def.description } : {}),
    authority: def.authority,
    methods: Object.fromEntries(
      Object.entries(def.methods)
        .filter(([, method]) => method.agentFacing !== false)
        .map(([name, method]) => [name, serializeMethod(method)])
    ),
  };
}
