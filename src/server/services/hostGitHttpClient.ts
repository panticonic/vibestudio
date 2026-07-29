import { GitClient, type FsPromisesLike } from "@vibestudio/git";
import type { VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import type { EgressProxy, GitCredentialSelection, HostGitHttpOperation } from "./egressProxy.js";

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
        (cause instanceof Error && cause.message ? `: ${cause.message}` : "")
    );
    this.name = "GitCredentialSelectionRequiredError";
  }
}

export function createHostGitReadClient(input: {
  egress: Pick<EgressProxy, "forwardGitHttp">;
  caller: VerifiedCaller;
  operation(request: GitHttpRequest): HostGitHttpOperation;
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

function statusCode(error: unknown): number | null {
  const value = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof value === "number" ? value : null;
}

export function assertHostGitReadRequest(request: GitHttpRequest): void {
  const url = new URL(request.url);
  const service = url.searchParams.get("service");
  if (service === "git-receive-pack" || url.pathname.endsWith("/git-receive-pack")) {
    throw new Error("Host Git acquisition clients cannot publish to a remote");
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
