import { extensionsMethods } from "@vibestudio/service-schemas/extensions";
import { templatesMethods, type TemplatesClient } from "@vibestudio/service-schemas/templates";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import type { ServiceMethodCaller } from "./typedClients.js";
import { typedClient } from "./typedClients.js";

export const TEMPLATES_EXTENSION = "templates";

export function createTemplatesClient(rpc: ServiceMethodCaller): TemplatesClient {
  const extensions = typedClient("extensions", extensionsMethods, rpc);
  return createTypedServiceClient("templates", templatesMethods, (_service, method, args) =>
    extensions.invoke(TEMPLATES_EXTENSION, method, args)
  );
}
