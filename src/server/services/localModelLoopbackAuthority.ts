import { RpcBoundaryError } from "@vibestudio/rpc";
import type { VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import {
  exactActiveLocalModel,
  type ResolveActiveNativeInvocation,
} from "./localModelRuntimeService.js";

const LOCAL_MODEL_USE_CAPABILITY = "internal-model-runtime.use";
const LOCAL_MODEL_RESOURCE = "local-models";
export interface LocalModelRuntimeAuth {
  baseUrl: string;
  apiKey: string;
}

export interface InternalRequestAuthorizationInput {
  caller: VerifiedCaller;
  targetUrl: URL;
  method: string;
  headers: Headers | Record<string, string | string[] | undefined>;
}

export interface LocalModelLoopbackAuthorityDeps {
  resolveNativeInvocation: ResolveActiveNativeInvocation;
  readRuntimeAuth(caller: VerifiedCaller, modelId: string): Promise<unknown>;
}

export class LocalModelRuntimeAuthorityError extends RpcBoundaryError {
  constructor(cause: unknown) {
    super("Local model runtime authority is unavailable", "service", "ELOCALMODEL_RUNTIME", cause);
    this.name = "LocalModelRuntimeAuthorityError";
  }
}

/**
 * Revalidates the exact active native model task and asks the owning supervisor
 * for a model-scoped live endpoint attestation. The bearer is injected only
 * after validation and never accepted from or returned to userland code.
 */
export class LocalModelLoopbackAuthority {
  constructor(private readonly deps: LocalModelLoopbackAuthorityDeps) {}

  async authorize(
    input: InternalRequestAuthorizationInput
  ): Promise<{ trustedForwardHeaders: Record<string, string> } | false> {
    if (input.targetUrl.protocol !== "http:" || !isLoopback(input.targetUrl.hostname)) return false;
    if (!input.targetUrl.pathname.startsWith("/v1/")) return false;
    if (!isApprovedAgentModelRuntime(input.caller)) {
      const code = input.caller.code;
      console.warn("[local-model-authority] denied", {
        callerId: input.caller.runtime.id,
        reason: "caller-not-authorized",
        codeApproved: input.caller.codeApproved === true,
        codeIdentityMatches:
          code?.callerId === input.caller.runtime.id &&
          code?.callerKind === input.caller.runtime.kind,
        executionDigestPresent: Boolean(code?.executionDigest),
        modelRuntimeRequested: hasModelRuntimeRequest(input.caller),
      });
      return false;
    }

    try {
      // The owning extension attests its live endpoints in its own process
      // namespace. Host paths and PIDs cannot describe an isolated runtime.
      const model = exactActiveLocalModel(
        input.caller,
        await this.deps.resolveNativeInvocation(input.caller)
      );
      const auth = parseRuntimeAuth(await this.deps.readRuntimeAuth(input.caller, model.modelId));
      if (!auth || !auth.apiKey) {
        throw new Error("Local model provider returned an invalid runtime authority attestation");
      }
      if (new URL(auth.baseUrl).origin !== input.targetUrl.origin) {
        console.warn("[local-model-authority] denied", {
          callerId: input.caller.runtime.id,
          reason: "endpoint-not-live",
          origin: input.targetUrl.origin,
        });
        return false;
      }
      return {
        trustedForwardHeaders: {
          authorization: `Bearer ${auth.apiKey}`,
        },
      };
    } catch (cause) {
      // Provider failure is an execution error, not a request for broader
      // network permission. Preserve its cause and keep credentials private.
      console.warn("[local-model-authority] provider unavailable", {
        callerId: input.caller.runtime.id,
        callerKind: input.caller.runtime.kind,
        errorName: cause instanceof Error ? cause.name : "unknown",
        errorCode: cause && typeof cause === "object" && "code" in cause ? cause.code : undefined,
      });
      throw new LocalModelRuntimeAuthorityError(cause);
    }
  }
}

function parseRuntimeAuth(value: unknown): LocalModelRuntimeAuth | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record["apiKey"] !== "string" || typeof record["baseUrl"] !== "string") return null;
  try {
    new URL(record["baseUrl"]);
  } catch {
    return null;
  }
  return { apiKey: record["apiKey"], baseUrl: record["baseUrl"] };
}

function isApprovedAgentModelRuntime(caller: VerifiedCaller): boolean {
  const code = caller.code;
  if (
    caller.codeApproved !== true ||
    !code ||
    code.callerId !== caller.runtime.id ||
    code.callerKind !== caller.runtime.kind ||
    !code.executionDigest
  ) {
    return false;
  }
  return hasModelRuntimeRequest(caller);
}

function hasModelRuntimeRequest(caller: VerifiedCaller): boolean {
  return Boolean(
    caller.code?.requested?.some(
      (request) =>
        request.capability === LOCAL_MODEL_USE_CAPABILITY &&
        ((request.resource.kind === "exact" && request.resource.key === LOCAL_MODEL_RESOURCE) ||
          (request.resource.kind === "prefix" &&
            LOCAL_MODEL_RESOURCE.startsWith(request.resource.prefix)))
    )
  );
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}
