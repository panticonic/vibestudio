/**
 * fs service definition — per-context filesystem operations, sandboxed to the
 * caller's context folder. The implementation lives in
 * `@natstack/shared/fsService` (FsService); this module declares the RPC
 * surface (method schemas + policy) for dispatcher registration.
 *
 * Caller-kind argument conventions (handled inside FsService):
 * - panel/app/worker/do callers: context resolved from the EntityCache.
 * - extension callers: chained caller context (or explicit host-fs capability).
 * - server/shell/harness callers: explicit contextId as the first argument.
 *
 * `symlink` and `chown` are deliberately absent (audit findings #38/#39):
 * they are sandbox-escape primitives and nothing on the service surface
 * needs them.
 */

import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import { handleFsCall, type FsService } from "@natstack/shared/fsService";

/** Path-first methods (server/shell/harness callers prepend a contextId). */
const pathMethod = { args: z.tuple([z.string()]).rest(z.unknown()) };
/** Handle-op methods: handleId number first (or contextId string when prepended). */
const handleMethod = { args: z.tuple([z.union([z.number(), z.string()])]).rest(z.unknown()) };
/** `mktemp` takes an optional prefix string (plus optional leading contextId). */
const mktempMethod = { args: z.array(z.string()).max(2) };

export function createFsServiceDefinition(getFsService: () => FsService): ServiceDefinition {
  return {
    name: "fs",
    description: "Per-context filesystem operations (sandboxed to context folder)",
    policy: {
      allowed: ["panel", "app", "server", "worker", "do", "extension", "shell", "harness"],
    },
    methods: {
      // File content
      readFile: pathMethod,
      writeFile: pathMethod,
      appendFile: pathMethod,
      // Directories
      readdir: pathMethod,
      mkdir: pathMethod,
      rmdir: pathMethod,
      rm: pathMethod,
      // Stat / metadata
      stat: pathMethod,
      lstat: pathMethod,
      exists: pathMethod,
      access: pathMethod,
      // File manipulation
      unlink: pathMethod,
      copyFile: pathMethod,
      rename: pathMethod,
      realpath: pathMethod,
      truncate: pathMethod,
      readlink: pathMethod,
      chmod: pathMethod,
      utimes: pathMethod,
      // Search
      grep: pathMethod,
      glob: pathMethod,
      // File handles
      open: pathMethod,
      handleRead: handleMethod,
      handleWrite: handleMethod,
      handleClose: handleMethod,
      handleStat: handleMethod,
      // Tmp files
      mktemp: mktempMethod,
    },
    handler: (ctx, method, serviceArgs) => handleFsCall(getFsService(), ctx, method, serviceArgs),
  };
}
