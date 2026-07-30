import * as nodePath from "node:path";
import * as nodeUtil from "node:util";
import * as nodeCrypto from "node:crypto";
import * as nodeBuffer from "node:buffer";

/**
 * Node import aliases available to sandbox eval. Filesystem specifiers resolve
 * to the exact context-bound portable runtime filesystem already injected as
 * `fs`; this loader adds no filesystem behavior, authority, path translation,
 * or lifetime of its own.
 */
export function createEvalNodeCompat(runtimeFs: Record<string, unknown>): Record<string, unknown> {
  // Stable, tenant-neutral values: enough for portable libraries and temp-file
  // recipes without exposing host machine identity or resource telemetry.
  const osFacade: Record<string, unknown> = {
    EOL: "\n",
    devNull: "/dev/null",
    arch: () => "wasm32",
    availableParallelism: () => 1,
    cpus: () => [],
    endianness: () => "LE",
    freemem: () => 0,
    homedir: () => "/",
    hostname: () => "vibestudio",
    loadavg: () => [0, 0, 0],
    machine: () => "wasm32",
    networkInterfaces: () => ({}),
    platform: () => "linux",
    release: () => "",
    tmpdir: () => "/.tmp",
    totalmem: () => 0,
    type: () => "Linux",
    uptime: () => 0,
    userInfo: () => ({ uid: -1, gid: -1, username: "vibestudio", homedir: "/", shell: null }),
    version: () => "Vibestudio sandbox",
  };
  osFacade["default"] = osFacade;
  Object.defineProperty(osFacade, "__esModule", { value: true });

  const utilFacade: Record<string, unknown> = { ...nodeUtil };
  utilFacade["default"] = utilFacade;
  Object.defineProperty(utilFacade, "__esModule", { value: true });

  const cryptoFacade: Record<string, unknown> = { ...nodeCrypto };
  cryptoFacade["default"] = cryptoFacade;
  Object.defineProperty(cryptoFacade, "__esModule", { value: true });

  const bufferFacade: Record<string, unknown> = { ...nodeBuffer };
  bufferFacade["default"] = bufferFacade;
  Object.defineProperty(bufferFacade, "__esModule", { value: true });

  return {
    // Node accepts both the explicit `node:` specifiers and their historical
    // bare aliases. Keep them identity-equal so packages that mix the two
    // spellings share the same scoped facade and never fall through to a host
    // module loader.
    fs: runtimeFs,
    "fs/promises": runtimeFs,
    buffer: bufferFacade,
    crypto: cryptoFacade,
    os: osFacade,
    path: nodePath,
    util: utilFacade,
    "node:buffer": bufferFacade,
    "node:crypto": cryptoFacade,
    "node:fs": runtimeFs,
    "node:fs/promises": runtimeFs,
    "node:os": osFacade,
    "node:path": nodePath,
    "node:util": utilFacade,
  };
}
