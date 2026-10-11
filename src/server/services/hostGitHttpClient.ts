import { GitClient, type FsPromisesLike } from "@vibestudio/git";
import type { VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import type { EgressProxy, GitCredentialSelection, HostHttpOperation } from "./egressProxy.js";
import { withPublicHostHttp } from "./hostHttpTransport.js";
import { normalizeRemoteUrl } from "@vibestudio/workspace/remoteUrl";

export interface GitHttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: Uint8Array | AsyncIterable<Uint8Array>;
}

/**
 * A private Git remote was tried anonymously and no unambiguous existing
 * credential could open it. This carries only the durable binding coordinate;
 * it never contains credential material or an account identity.
 */
export class GitCredentialSelectionRequiredError extends Error {
  constructor(
    readonly requirement: { name: string; remoteUrl: string; provider: string },
    readonly statusCode: number,
    cause?: unknown
  ) {
    super(
      `A credential must be selected for ${requirement.remoteUrl}` +
        (cause instanceof Error && cause.message ? `: ${cause.message}` : ""),
      { cause }
    );
    this.name = "GitCredentialSelectionRequiredError";
  }
}

export function createHostGitReadClient(input: {
  egress: Pick<EgressProxy, "forwardGitHttp">;
  caller: VerifiedCaller;
  operation(request: GitHttpRequest): HostHttpOperation;
  credential: GitCredentialSelection;
  /** Retried only after an anonymous request is rejected by the remote. */
  fallbackCredential?: GitCredentialSelection;
  /** Coordinate to present if the automatic fallback cannot choose a credential. */
  credentialRequirement?: { name: string; remoteUrl: string; provider: string };
  fs?: FsPromisesLike;
  author?: { name: string; email: string };
}): GitClient {
  return new GitClient(input.fs, {
    http: {
      request: async (request) => {
        assertHostGitReadRequest(request);
        const body = await collectGitRequestBody(request.body);
        const forward = (credential: GitCredentialSelection) =>
          input.egress.forwardGitHttp({
            authority: {
              kind: "host-operation",
              caller: input.caller,
              operation: input.operation(request),
            },
            url: request.url,
            method: request.method ?? "GET",
            headers: request.headers ?? {},
            body,
            credential,
          });
        let result = await forward(input.credential);
        if (input.fallbackCredential && (result.statusCode === 401 || result.statusCode === 403)) {
          try {
            result = await forward(input.fallbackCredential);
          } catch (error) {
            if (input.credentialRequirement) {
              throw new GitCredentialSelectionRequiredError(
                input.credentialRequirement,
                statusCode(error) ?? 409,
                error
              );
            }
            throw error;
          }
          if (
            input.credentialRequirement &&
            (result.statusCode === 401 || result.statusCode === 403)
          ) {
            throw new GitCredentialSelectionRequiredError(
              input.credentialRequirement,
              result.statusCode
            );
          }
        }
        return {
          url: result.url,
          method: result.method,
          statusCode: result.statusCode,
          statusMessage: result.statusMessage,
          headers: result.headers,
          body: (async function* () {
            yield result.body;
          })(),
        };
      },
    },
    ...(input.author ? { author: input.author } : {}),
  });
}

/**
 * Git reads for trusted host bootstrap inputs. The pins/manifest that select
 * repositories are the authority here; requests remain anonymous, public-only,
 * redirect-free and DNS-pinned by the shared host HTTP transport.
 */
export interface HostBootstrapGitReadClient {
  git: GitClient;
  admitRemote(url: string): void;
}

export function createHostBootstrapGitReadClient(
  input: {
    signal?: AbortSignal;
    fs?: FsPromisesLike;
  } = {}
): HostBootstrapGitReadClient {
  const signal = input.signal ?? new AbortController().signal;
  const remotes = new Set<string>();
  const client = new GitClient(input.fs, {
    http: {
      request: async (request) => {
        assertHostGitReadRequest(request);
        const url = new URL(request.url);
        if (url.username || url.password) {
          throw new Error("Host bootstrap Git reads cannot use URL credentials");
        }
        for (const name of Object.keys(request.headers ?? {})) {
          if (
            [
              "authorization",
              "proxy-authorization",
              "cookie",
              "host",
              "connection",
              "proxy-connection",
              "transfer-encoding",
            ].includes(name.toLowerCase())
          ) {
            throw new Error("Host bootstrap Git reads cannot forward credentials");
          }
        }
        if (
          ![...remotes].some((remote) => isGitRemoteRequest(url, request.method ?? "GET", remote))
        ) {
          throw new Error("Host bootstrap Git request is outside the admitted template remotes");
        }
        const body = await collectGitRequestBody(request.body);
        const result = await withPublicHostHttp<{
          url: string;
          method: string;
          statusCode: number;
          statusMessage: string;
          headers: Record<string, string>;
          body: Uint8Array;
        }>(
          {
            url,
            method: request.method ?? "GET",
            headers: request.headers ?? {},
            ...(body ? { body: Buffer.from(body) } : {}),
            signal,
          },
          async (response) => {
            if (response.status >= 300 && response.status < 400) {
              throw new Error("Host Git acquisition does not follow remote redirects");
            }
            return {
              url: response.url || request.url,
              method: request.method ?? "GET",
              statusCode: response.status,
              statusMessage: response.statusText,
              headers: Object.fromEntries(response.headers.entries()),
              body: new Uint8Array(await response.arrayBuffer()),
            };
          }
        );
        return {
          url: result.url,
          method: result.method,
          statusCode: result.statusCode,
          statusMessage: result.statusMessage,
          headers: result.headers,
          body: (async function* () {
            yield result.body;
          })(),
        };
      },
    },
  });
  return {
    git: client,
    admitRemote(url) {
      remotes.add(normalizeRemoteUrl(url));
    },
  };
}

function isGitRemoteRequest(requestUrl: URL, method: string, remote: string): boolean {
  const base = new URL(remote);
  const basePath = base.pathname.replace(/\/$/u, "");
  const endpoint =
    (method.toUpperCase() === "GET" &&
      requestUrl.pathname === `${basePath}/info/refs` &&
      requestUrl.searchParams.size === 1 &&
      requestUrl.searchParams.get("service") === "git-upload-pack") ||
    (method.toUpperCase() === "POST" &&
      requestUrl.pathname === `${basePath}/git-upload-pack` &&
      requestUrl.search === "");
  return requestUrl.origin === base.origin && endpoint;
}

function statusCode(error: unknown): number | null {
  const value = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof value === "number" ? value : null;
}

export function assertHostGitReadRequest(request: GitHttpRequest): void {
  const url = new URL(request.url);
  const method = (request.method ?? "GET").toUpperCase();
  const discovery =
    method === "GET" &&
    url.pathname.endsWith("/info/refs") &&
    url.searchParams.size === 1 &&
    url.searchParams.get("service") === "git-upload-pack";
  const upload =
    method === "POST" && url.pathname.endsWith("/git-upload-pack") && url.search === "";
  if (!discovery && !upload) {
    throw new Error("Host Git acquisition permits only smart-HTTP upload-pack reads");
  }
}

async function collectGitRequestBody(
  body: Uint8Array | AsyncIterable<Uint8Array> | undefined
): Promise<Uint8Array | undefined> {
  if (!body || body instanceof Uint8Array) return body;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    chunks.push(chunk);
    size += chunk.byteLength;
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}
