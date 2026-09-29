import { RpcBoundaryError } from "@vibestudio/rpc";
import { constantTimeStringEqual } from "@vibestudio/shared/tokenManager";
import type { VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";

const LOCAL_MODEL_USE_CAPABILITY = "internal-model-runtime.use";
const LOCAL_MODEL_RESOURCE = "local-models";
export interface LocalModelRuntimeAuth {
  apiKey: string;
  origins: string[];
}

export interface InternalRequestAuthorizationInput {
  caller: VerifiedCaller;
  targetUrl: URL;
  method: string;
  headers: Headers | Record<string, string | string[] | undefined>;
}

export interface LocalModelLoopbackAuthorityDeps {
  readRuntimeAuth(caller: VerifiedCaller): Promise<unknown>;
}

export class LocalModelRuntimeAuthorityError extends RpcBoundaryError {
  constructor(cause: unknown) {
    super("Local model runtime authority is unavailable", "service", "ELOCALMODEL_RUNTIME", cause);
    this.name = "LocalModelRuntimeAuthorityError";
  }
}

/**
 * Verifies the dynamic bearer capability minted by the local-model supervisor.
 * Nothing here grants general loopback access: the exact reviewed caller,
 * live endpoint, and in-flight destination credential must all agree.
 */
export class LocalModelLoopbackAuthority {
  constructor(private readonly deps: LocalModelLoopbackAuthorityDeps) {}

  async authorize(input: InternalRequestAuthorizationInput): Promise<boolean> {
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

    const authorization = readHeader(input.headers, "authorization");
    if (!authorization?.startsWith("Bearer ")) {
      console.warn("[local-model-authority] denied", {
        callerId: input.caller.runtime.id,
        reason: "bearer-missing",
      });
      return false;
    }
    const presentedKey = authorization.slice("Bearer ".length);
    if (!presentedKey) return false;

    try {
      // The owning extension attests its live endpoints in its own process
      // namespace. Host paths and PIDs cannot describe an isolated runtime.
      const auth = parseRuntimeAuth(await this.deps.readRuntimeAuth(input.caller));
      if (!auth || !auth.apiKey) {
        throw new Error("Local model provider returned an invalid runtime authority attestation");
      }
      if (!auth.origins.includes(input.targetUrl.origin)) {
        console.warn("[local-model-authority] denied", {
          callerId: input.caller.runtime.id,
          reason: "endpoint-not-live",
          origin: input.targetUrl.origin,
        });
        return false;
      }
      if (!constantTimeStringEqual(presentedKey, auth.apiKey)) {
        console.warn("[local-model-authority] denied", {
          callerId: input.caller.runtime.id,
          reason: "bearer-mismatch",
          origin: input.targetUrl.origin,
        });
        return false;
      }
      return true;
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
  if (
    typeof record["apiKey"] !== "string" ||
    !Array.isArray(record["origins"]) ||
    !record["origins"].every((origin) => typeof origin === "string")
  )
    return null;
  return { apiKey: record["apiKey"], origins: record["origins"] as string[] };
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

function readHeader(
  headers: InternalRequestAuthorizationInput["headers"],
  name: string
): string | null {
  if (headers instanceof Headers) return headers.get(name);
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  const value = entry?.[1];
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) return value.find((item) => item.trim())?.trim() ?? null;
  return null;
}
