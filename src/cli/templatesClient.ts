import type { TemplatesClient } from "@vibestudio/service-schemas/templates";
import { createTemplatesClient as bindTemplatesClient } from "@vibestudio/service-schemas/clients/templatesClient";
import { qualifyServiceMethod } from "@vibestudio/shared/typedServiceClient";
import type { ServiceMethodCaller } from "./typedClients.js";

export const TEMPLATES_EXTENSION = "templates";

export function createTemplatesClient(rpc: ServiceMethodCaller): TemplatesClient {
  return bindTemplatesClient((service, method, args) =>
    rpc.call(qualifyServiceMethod(service, method), args)
  );
}
