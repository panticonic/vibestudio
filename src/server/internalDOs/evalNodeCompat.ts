import * as nodePath from "node:path";
import * as nodeUtil from "node:util";
import * as nodeCrypto from "node:crypto";
import * as nodeBuffer from "node:buffer";

const { Buffer } = nodeBuffer;

const TWO_PATH_METHODS = new Set(["copyFile", "cp", "link", "rename", "symlink"]);

function virtualizeOwnCwdPath(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const cwd = process.cwd();
  if (value === cwd) return ".";
  const prefix = cwd.endsWith(nodePath.sep) ? cwd : `${cwd}${nodePath.sep}`;
  return value.startsWith(prefix)
    ? value.slice(prefix.length).replaceAll(nodePath.sep, "/")
    : value;
}

function scopedFsFacade(runtimeFs: Record<string, unknown>): Record<string, unknown> {
  const facade: Record<string, unknown> = {};
  for (const [name, member] of Object.entries(runtimeFs)) {
    if (typeof member !== "function") {
      facade[name] = member;
      continue;
    }
    facade[name] = (...rawArgs: unknown[]) => {
      const args = [...rawArgs];
      if (args.length > 0) args[0] = virtualizeOwnCwdPath(args[0]);
      if (TWO_PATH_METHODS.has(name) && args.length > 1) {
        args[1] = virtualizeOwnCwdPath(args[1]);
      }
      return member.apply(runtimeFs, args);
    };
  }
  return facade;
}

/**
 * Safe Node-shaped modules for sandbox eval. `node:fs` is deliberately backed
 * by the owner-scoped portable runtime filesystem; it never exposes workerd's
 * or the host process's real filesystem. Pure `node:path` is safe and keeps
 * ordinary cross-target utility code portable.
 */
export function createEvalNodeCompat(runtimeFs: Record<string, unknown>): Record<string, unknown> {
  const scopedFs = scopedFsFacade(runtimeFs);
  const scopedReadFile = scopedFs["readFile"] as
    | ((path: string, encoding?: string) => Promise<unknown>)
    | undefined;
  const nodeReadFile = scopedReadFile
    ? async (path: string, encoding?: string): Promise<unknown> => {
        const value = await scopedReadFile(path, encoding);
        if (typeof value === "string" || Buffer.isBuffer(value)) return value;
        if (value instanceof Uint8Array) return Buffer.from(value);
        return value;
      }
    : undefined;
  const fsFacade: Record<string, unknown> = {
    ...scopedFs,
    promises: scopedFs,
    ...(nodeReadFile ? { readFile: nodeReadFile } : {}),
  };
  fsFacade["default"] = fsFacade;
  Object.defineProperty(fsFacade, "__esModule", { value: true });

  const fsPromises: Record<string, unknown> = {
    ...scopedFs,
    ...(nodeReadFile ? { readFile: nodeReadFile } : {}),
  };
  fsFacade["promises"] = fsPromises;
  fsPromises["default"] = fsPromises;
  Object.defineProperty(fsPromises, "__esModule", { value: true });

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
    fs: fsFacade,
    "fs/promises": fsPromises,
    buffer: bufferFacade,
    crypto: cryptoFacade,
    os: osFacade,
    path: nodePath,
    util: utilFacade,
    "node:buffer": bufferFacade,
    "node:crypto": cryptoFacade,
    "node:fs": fsFacade,
    "node:fs/promises": fsPromises,
    "node:os": osFacade,
    "node:path": nodePath,
    "node:util": utilFacade,
  };
}
