/** Canonical runtime client for the deliberately small semantic VCS API. */

import { vcsMethods } from "@vibestudio/service-schemas/vcs";
import {
  createTypedServiceClient,
  type TypedServiceClient,
} from "@vibestudio/shared/typedServiceClient";

export type * from "@vibestudio/service-schemas/vcs";

/**
 * Runtime code uses the service contract directly. There are no alternate
 * merge verbs, selective-commit compilers, provenance facades, or routing
 * overlays to keep synchronized with it.
 */
export type VcsClient = TypedServiceClient<typeof vcsMethods>;

export function createVcsClient(
  callMain: <T>(method: string, ...args: unknown[]) => Promise<T>
): VcsClient {
  return createTypedServiceClient("vcs", vcsMethods, (_service, method, args) =>
    callMain(`vcs.${method}`, ...args)
  );
}
