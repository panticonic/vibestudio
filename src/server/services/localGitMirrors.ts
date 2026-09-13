import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeRemoteUrl } from "@vibestudio/workspace/remoteUrl";
import type { GitHttpTransportResponse } from "./gitHttpRpc.js";

/**
 * Host-authorized local acquisition transport for a Git remote.
 *
 * A project is adopted into the workspace through `gitInterop.importProject`,
 * which clones the declared canonical upstream over smart HTTP. That is the
 * only adoption path, and it is the right one: the adoption record must fix a
 * credential-free canonical URL that survives re-import (§34.1). But it also
 * means a checkout that already exists on this machine — the Vibestudio source
 * itself, during self-development — could only be adopted by round-tripping
 * through its published remote.
 *
 * A mirror declares that the bytes for one canonical URL may be served from a
 * local Git directory. Durable source identity remains the exact canonical
 * URL; the checkout is an owned transport for those bytes, exactly as
 * `VIBESTUDIO_WORKSPACE_SOURCES` already is for a reviewed template pin.
 *
 * Mirrors are read-only: they answer `git-upload-pack` and refuse
 * `git-receive-pack`, so a publication still has to reach the real remote.
 */
export const LOCAL_GIT_MIRRORS_ENV = "VIBESTUDIO_LOCAL_GIT_MIRRORS" as const;

export interface LocalGitMirror {
  /** Canonical credential-free upstream URL these bytes stand in for. */
  url: string;
  /** Local Git directory (a work tree or a bare repository) serving them. */
  checkout: string;
}

const UPLOAD_PACK_SERVICE = "git-upload-pack";
/** A single-commit snapshot mirror is small; a full history mirror is not. */
const MAX_PACK_BYTES = 512 * 1024 * 1024;

function gitDirectoryFor(checkout: string): string {
  const resolved = path.resolve(checkout);
  if (fs.existsSync(path.join(resolved, ".git"))) return resolved;
  if (fs.existsSync(path.join(resolved, "HEAD")) && fs.existsSync(path.join(resolved, "objects"))) {
    return resolved;
  }
  throw new Error(`Local Git mirror is not a Git repository: ${checkout}`);
}

export function parseLocalGitMirrors(raw: string | undefined): LocalGitMirror[] {
  const value = raw?.trim();
  if (!value) return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error(`${LOCAL_GIT_MIRRORS_ENV} must be a JSON array`);
  const byUrl = new Map<string, LocalGitMirror>();
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${LOCAL_GIT_MIRRORS_ENV} entries must be objects`);
    }
    const record = entry as Record<string, unknown>;
    if (typeof record["url"] !== "string" || typeof record["checkout"] !== "string") {
      throw new Error(`${LOCAL_GIT_MIRRORS_ENV} entries must declare url and checkout`);
    }
    const url = normalizeRemoteUrl(record["url"]);
    // `.../repo` and `.../repo.git` address one repository, and routing treats
    // them as one, so two spellings of it are a conflicting declaration rather
    // than two mirrors.
    const identity = mirrorIdentity(url);
    if (byUrl.has(identity)) {
      throw new Error(`${LOCAL_GIT_MIRRORS_ENV} declares ${url} more than once`);
    }
    byUrl.set(identity, { url, checkout: gitDirectoryFor(record["checkout"]) });
  }
  return [...byUrl.values()];
}

export function readLocalGitMirrors(
  environment: NodeJS.ProcessEnv = process.env
): LocalGitMirror[] {
  return parseLocalGitMirrors(environment[LOCAL_GIT_MIRRORS_ENV]);
}

export function serializeLocalGitMirrors(mirrors: readonly LocalGitMirror[]): string {
  return JSON.stringify(
    mirrors.map((mirror) => ({ url: normalizeRemoteUrl(mirror.url), checkout: mirror.checkout }))
  );
}

/** Identity of the repository a canonical URL addresses, spelling aside. */
function mirrorIdentity(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}${parsed.pathname
    .replace(/\/+$/u, "")
    .replace(/\.git$/u, "")}`;
}

function packetLine(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const length = (payload.byteLength + 4).toString(16).padStart(4, "0");
  return Buffer.concat([Buffer.from(length, "utf8"), payload]);
}

const FLUSH_PACKET = Buffer.from("0000", "utf8");

export interface LocalGitMirrorRequest {
  url: string;
  method: string;
  body?: Uint8Array | undefined;
}

/**
 * Which mirror operation `url` names, or null when no declared mirror owns it.
 *
 * Smart HTTP addresses one repository through two exact routes, so the base URL
 * is whatever precedes them. Matching on the base rather than the whole request
 * keeps `https://host/owner/repo.git` and the routes under it one identity.
 */
export function resolveLocalGitMirrorRoute(
  mirrors: readonly LocalGitMirror[],
  request: LocalGitMirrorRequest
): { mirror: LocalGitMirror; operation: "advertise" | "upload-pack" } | null {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }
  const method = request.method.toUpperCase();
  let operation: "advertise" | "upload-pack" | "refused" | null = null;
  let base: string | null = null;
  if (method === "GET" && url.pathname.endsWith("/info/refs")) {
    const service = url.searchParams.get("service");
    operation =
      service === UPLOAD_PACK_SERVICE ? "advertise" : service === null ? "advertise" : "refused";
    base = url.pathname.slice(0, -"/info/refs".length);
  } else if (method === "POST" && url.pathname.endsWith(`/${UPLOAD_PACK_SERVICE}`)) {
    operation = "upload-pack";
    base = url.pathname.slice(0, -`/${UPLOAD_PACK_SERVICE}`.length);
  } else if (url.pathname.endsWith("/git-receive-pack")) {
    operation = "refused";
    base = url.pathname.slice(0, -"/git-receive-pack".length);
  }
  if (!operation || base === null) return null;
  const baseUrl = `${url.protocol}//${url.host}${base}`;
  const requested = mirrorIdentity(`${url.protocol}//${url.host}${base}`);
  const mirror = mirrors.find((candidate) => mirrorIdentity(candidate.url) === requested);
  if (!mirror) return null;
  if (operation === "refused") {
    throw new Error(
      `Local Git mirror for ${mirror.url} is read-only; publication must reach the real remote (${baseUrl})`
    );
  }
  return { mirror, operation };
}

export interface LocalGitMirrorTransport {
  /** Serve `request` from a declared mirror, or null when none owns its URL. */
  request(request: LocalGitMirrorRequest): Promise<GitHttpTransportResponse | null>;
}

export function createLocalGitMirrorTransport(input: {
  mirrors: readonly LocalGitMirror[];
}): LocalGitMirrorTransport | null {
  if (input.mirrors.length === 0) return null;
  const run = runGit;
  return {
    async request(request) {
      const route = resolveLocalGitMirrorRoute(input.mirrors, request);
      if (!route) return null;
      const dir = route.mirror.checkout;
      if (route.operation === "advertise") {
        const advertised = await run(["upload-pack", "--stateless-rpc", "--advertise-refs", "."], {
          cwd: dir,
        });
        return {
          url: request.url,
          method: request.method,
          statusCode: 200,
          statusMessage: "OK",
          headers: {
            "content-type": `application/x-${UPLOAD_PACK_SERVICE}-advertisement`,
            "cache-control": "no-cache",
          },
          body: new Uint8Array(
            Buffer.concat([
              packetLine(`# service=${UPLOAD_PACK_SERVICE}\n`),
              FLUSH_PACKET,
              advertised,
            ])
          ),
        };
      }
      const result = await run(["upload-pack", "--stateless-rpc", "."], {
        cwd: dir,
        input: request.body,
      });
      return {
        url: request.url,
        method: request.method,
        statusCode: 200,
        statusMessage: "OK",
        headers: {
          "content-type": `application/x-${UPLOAD_PACK_SERVICE}-result`,
          "cache-control": "no-cache",
        },
        body: new Uint8Array(result),
      };
    },
  };
}

function runGit(
  args: readonly string[],
  options: { cwd: string; input?: Uint8Array | undefined }
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      [...args],
      {
        cwd: options.cwd,
        maxBuffer: MAX_PACK_BYTES,
        encoding: "buffer",
        // Protocol v2 is negotiated by the client through this variable. The
        // callers are isomorphic-git clients that speak v0 only, so leaving it
        // unset is what keeps the advertisement readable to them.
        env: { ...process.env, GIT_PROTOCOL: "" },
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = Buffer.isBuffer(stderr) ? stderr.toString("utf8").trim() : "";
          reject(
            new Error(`git ${args[0]} failed in ${options.cwd}${detail ? `: ${detail}` : ""}`)
          );
          return;
        }
        resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
      }
    );
    if (options.input) child.stdin?.end(Buffer.from(options.input));
    else child.stdin?.end();
  });
}
