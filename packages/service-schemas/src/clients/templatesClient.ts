import { extensionsMethods } from "../extensions.js";
import { templatesMethods, type TemplatesClient } from "../templates.js";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";

/** Templates is an extension; every caller uses its ordinary invocation boundary. */
export function createTemplatesClient(
  call: (service: string, method: string, args: unknown[]) => Promise<unknown>
): TemplatesClient {
  const extensions = createTypedServiceClient("extensions", extensionsMethods, call);
  return createTypedServiceClient("templates", templatesMethods, (_service, method, args) =>
    extensions.invoke("templates", method, args)
  );
}
