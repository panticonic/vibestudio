import type { ServicePolicy } from "./servicePolicy.js";
import type { ServiceHandler } from "./serviceDispatcher.js";
import type { MethodSchema } from "./typedServiceClient.js";

export interface ServiceDefinition {
  name: string;
  description?: string;
  /**
   * A desktop host normally dispatches its registered services in-process.
   * A service may instead keep selected callers on their authenticated remote
   * session (for example panel event subscriptions, whose delivery session is
   * owned by the server). This travels with the registration so transports do
   * not maintain a second service-name list.
   */
  hostRouting?: Partial<Record<"shell" | "app" | "panel", "host" | "session">>;
  policy: ServicePolicy;
  /**
   * Method schema table — pure data (Zod arg tuples, optional return schemas,
   * per-method policies). For services with external callers this should be a
   * table from `@vibestudio/service-schemas` so typed clients derive their types
   * from the same source of truth (see typedServiceClient.ts).
   */
  methods: Record<string, MethodSchema>;
  handler: ServiceHandler;
}
