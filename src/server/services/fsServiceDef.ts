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
 * This definition deliberately remains a dynamic adapter rather than using
 * `defineServiceHandler`. Each fs schema accepts two tuple shapes because the
 * server/shell form prepends a context id, but schema data alone cannot choose
 * between them: verified caller identity does. FsService first resolves that
 * identity-dependent scope and consumes the prefix, then applies the explicitly
 * constructed semantic-context or scratch-only authority before operation
 * dispatch. Scratch-only adapters fail closed for every reserved workspace
 * source root; a missing semantic bridge can never fall through to disk. An exhaustive forwarding
 * table here would neither type the normalized tuples nor remove that dispatch;
 * it would only duplicate every method name around the real adapter boundary.
 *
 * `chown` remains deliberately absent. `symlink` is exposed only through the
 * FsService's contained, scratch-only implementation.
 */

import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { handleFsCall, type FsService } from "@vibestudio/shared/fsService";
import { fsMethods } from "@vibestudio/service-schemas/fs";

export function createFsServiceDefinition(getFsService: () => FsService): ServiceDefinition {
  return {
    name: "fs",
    description:
      "Filesystem operations. Context-bound callers are sandboxed to their context folder; the semantic workspace records managed reads and mutations before host projection, with structured move/copy preserving explicit provenance. Scratch-only adapters may access context-local paths outside reserved workspace source roots and fail closed for managed paths. An unchained extension granted the explicit host-fs-access capability is unrestricted and uses host filesystem paths.",
    authority: { principals: ["code", "host", "user"] },
    methods: fsMethods,
    handler: (ctx, method, serviceArgs) => handleFsCall(getFsService(), ctx, method, serviceArgs),
  };
}
