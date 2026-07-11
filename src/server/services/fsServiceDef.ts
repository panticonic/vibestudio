/**
 * fs service definition — filesystem operations sandboxed to the caller's
 * context folder for context-bound callers. An unchained extension granted the
 * explicit `host-fs-access` capability is the deliberate unrestricted-host
 * exception. The implementation lives in
 * `@vibestudio/shared/fsService` (FsService); this module declares the RPC
 * surface (method schemas + policy) for dispatcher registration.
 *
 * Caller-kind argument conventions (handled inside FsService):
 * - panel/app/worker/do callers: context resolved from the EntityCache.
 * - extension callers: chained caller context (or explicit host-fs capability).
 * - server/shell callers: explicit contextId as the first argument.
 *
 * `symlink` and `chown` are deliberately absent (audit findings #38/#39):
 * they are sandbox-escape primitives and nothing on the service surface
 * needs them.
 */

import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { handleFsCall, type FsService } from "@vibestudio/shared/fsService";
import { fsMethods } from "@vibestudio/shared/serviceSchemas/fs";

export function createFsServiceDefinition(getFsService: () => FsService): ServiceDefinition {
  return {
    name: "fs",
    description:
      "Filesystem operations. Context-bound callers are sandboxed to their context folder; supported workspace-repo file mutations route through GAD working edits, while platform-ignored paths and paths outside reserved workspace source roots remain context-local scratch. An unchained extension granted the explicit host-fs-access capability is unrestricted and uses host filesystem paths.",
    policy: {
      allowed: ["panel", "app", "server", "worker", "do", "extension", "shell", "agent"],
    },
    methods: fsMethods,
    handler: (ctx, method, serviceArgs) => handleFsCall(getFsService(), ctx, method, serviceArgs),
  };
}
