import { extensionsMethods } from "@vibestudio/service-schemas/extensions";
import { templatesMethods, type TemplatesClient } from "@vibestudio/service-schemas/templates";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import type { ServiceMethodCaller } from "./typedClients.js";
import { typedClient } from "./typedClients.js";

/** Public extension short name advertised by `extensions.list`. */
export const TEMPLATE_COMPOSER_EXTENSION = "template-composer";

/**
 * CLI/headless template operations are ordinary calls into workspace
 * userland. The host's generic extension invocation venue supplies the call
 * path; this adapter only retains the schema validation and ergonomic method
 * surface used by the CLI.
 */
export function createTemplateComposerClient(rpc: ServiceMethodCaller): TemplatesClient {
  const extensions = typedClient("extensions", extensionsMethods, rpc);
  return createTypedServiceClient("template-composer", templatesMethods, (_service, method, args) =>
    extensions.invoke(TEMPLATE_COMPOSER_EXTENSION, method, args)
  );
}
