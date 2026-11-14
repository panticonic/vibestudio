/**
 * Hosting code in an entity (docs/dolt-redesign.md §7.2).
 *
 * Any durable object may host a class of dynamic code as a facet of its own
 * cell. The entity does not choose the grants: it names the class, and its
 * UniversalDO root asks the host what the entity's manifest permits (`hosts`)
 * and what the class needs (`hosted`: Dolt storage, `codegen`, `residency`, a
 * CPU limit). The entity's only capability is the `CODE_HOST` service binding,
 * which names no entity: the proof in its facet's props selects its own root.
 *
 * Both durable bases (this package's and Base's `durable-base.ts`) use this one
 * helper, so the call contract is written once.
 */
import {
  decodeRpcJson,
  deserializeRpcFailure,
  encodeRpcJson,
  rpcExposedMethodNames,
  serializeRpcFailure,
} from "@vibestudio/rpc";

/** The code to host: a class of a workspace worker source, resolved by the host. */
export interface HostedExecutable {
  readonly source: string;
  readonly className: string;
}

export interface HostCodeSpec {
  /** Names the hosted instance inside this entity (one kernel per name). */
  readonly name: string;
  readonly executable: HostedExecutable;
}

/** A class hosted in the calling entity's own cell. */
export interface HostedCode {
  readonly name: string;
  /** Calls an `@rpc` method of the hosted class and returns its result. */
  call<T = unknown>(method: string, ...args: unknown[]): Promise<T>;
  /** Ends the residency hold. The class's storage stays; the heap may now be evicted. */
  release(): Promise<void>;
  /**
   * The same hosted class, with a limit for each call made through the result:
   * `cpuMs` is the CPU one call (and the work it leaves running under
   * `waitUntil`) may use, lower-wins against the class's own limit. A run's
   * `timeoutMs` bounds its CPU through this. The heap and the storage are the
   * same; only the call carries the limit.
   */
  limited(limits: HostedCallLimits): HostedCode;
  /**
   * Ends the running hosted instance without ending its storage: the heap goes,
   * the committed state stays, and the next call starts the class again. The
   * recovery for an instance that stopped answering (docs/dolt-redesign.md §7.8):
   * the hosted class sees an ordinary restart and settles what it left running.
   */
  restart(): Promise<void>;
}

export interface HostedCallLimits {
  readonly cpuMs?: number;
  readonly subRequests?: number;
}

/** What the facet's props carry for the entity's own code (`ctx.props`). */
export interface CodeHostProps {
  readonly codeHost?: { readonly name: string; readonly proof: string } | null;
  /** Set only on a hosted class: the entity that hosts it, and its gateway token. */
  readonly host?: { readonly entityId: string; readonly token: string } | null;
}

/**
 * The CPU limit one call carries for a run that declared a `timeoutMs`
 * (docs/dolt-redesign.md §7.8). A run executes under the `start` call's
 * `waitUntil`, so a limit on that call bounds the run's CPU, and `timeoutMs` is
 * the budget the run declared. The lower of this and the class's own `cpuMs`
 * applies, and a spinning run is ended at the limit while its kernel keeps its
 * heap; the kernel's own timeout then settles the run, whose timer is already
 * due. No `timeoutMs` means the class's own limit alone.
 */
export function cpuLimitForTimeout(timeoutMs: unknown): HostedCallLimits | undefined {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0)
    return undefined;
  return { cpuMs: Math.max(1, Math.ceil(timeoutMs)) };
}

interface CodeHostFetcher {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

const HOSTED_ROUTE = "__hosted";

/** Why the entity's root refused or could not run a hosting request. */
export class CodeHostError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message);
    this.name = "CodeHostError";
  }
}

/**
 * One call to a hosted class that must answer within `budgetMs`. A hosted instance
 * whose isolate was ended by its CPU limit while it held work stops answering any
 * call (celld leaves the cell with an event that never completes; probed with a
 * real kernel, docs/dolt-redesign.md §7.8), and a pull that waits on it waits
 * forever. A call that overruns its budget is therefore not slow: the instance is
 * restarted (heap gone, storage kept) and the caller gets `EUNRESPONSIVE`, so the
 * next call reaches a fresh instance whose own restart handling settles what the
 * old one left running. Budgets must be generous: a restart discards the heap.
 */
export async function callOrRestart<T>(
  hosted: HostedCode,
  budgetMs: number,
  method: string,
  ...args: unknown[]
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unresponsive = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new CodeHostError(
            `hosted call ${method} did not answer within ${budgetMs}ms; the instance was restarted`,
            "EUNRESPONSIVE"
          )
        ),
      budgetMs
    );
  });
  const call = hosted.call<T>(method, ...args);
  // The abandoned call may still settle (or never); nothing may escape from it.
  call.catch(() => undefined);
  try {
    return await Promise.race([call, unresponsive]);
  } catch (error) {
    if (error instanceof CodeHostError && error.code === "EUNRESPONSIVE")
      await hosted.restart().catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** `hostCode` for an entity: its `CODE_HOST` binding and the proof in its props. */
export function createCodeHostClient(input: {
  env: Record<string, unknown>;
  props: CodeHostProps;
}): (spec: HostCodeSpec) => Promise<HostedCode> {
  const request = async (body: Record<string, unknown>): Promise<Response> => {
    const fetcher = input.env["CODE_HOST"] as CodeHostFetcher | undefined;
    const proof = input.props.codeHost;
    if (!fetcher || !proof)
      throw new CodeHostError("This object cannot host code: no CODE_HOST binding", "EUNAVAILABLE");
    return fetcher.fetch("http://code-host/", {
      method: "POST",
      headers: { "X-Code-Host-Name": proof.name, "X-Code-Host-Proof": proof.proof },
      body: JSON.stringify(body),
    });
  };
  const failure = async (response: Response): Promise<never> => {
    const text = await response.text();
    let error: unknown;
    try {
      error = (decodeRpcJson(text) as { error?: unknown }).error;
    } catch {
      /* not JSON: the text is the failure */
    }
    if (error && typeof error === "object") throw deserializeRpcFailure(error as never);
    throw new CodeHostError(
      `code host: ${text || response.statusText} (${response.status})`,
      response.status === 403 ? "EACCES" : "EHOST"
    );
  };
  return async (spec) => {
    const hosted = await request({ op: "host", name: spec.name, executable: spec.executable });
    if (!hosted.ok) await failure(hosted);
    await hosted.arrayBuffer();
    const handle = (limits: HostedCallLimits | undefined): HostedCode => ({
      name: spec.name,
      limited: (more) => handle({ ...limits, ...more }),
      async call<T>(method: string, ...args: unknown[]): Promise<T> {
        const response = await request({
          op: "call",
          name: spec.name,
          executable: spec.executable,
          method,
          args: JSON.parse(encodeRpcJson(args)) as unknown[],
          ...(limits ? { limits } : {}),
        });
        const text = await response.text();
        const decoded = decodeRpcJson(text) as { result?: T; error?: unknown };
        if (decoded && typeof decoded === "object" && "error" in decoded && decoded.error)
          throw deserializeRpcFailure(decoded.error as never);
        if (!response.ok)
          throw new CodeHostError(`hosted call ${method} failed (${response.status})`, "EHOST");
        return decoded.result as T;
      },
      async release(): Promise<void> {
        const response = await request({
          op: "release",
          name: spec.name,
          executable: spec.executable,
        });
        await response.arrayBuffer();
      },
      async restart(): Promise<void> {
        const response = await request({
          op: "restart",
          name: spec.name,
          executable: spec.executable,
        });
        if (!response.ok) await failure(response);
        await response.arrayBuffer();
      },
    });
    return handle(undefined);
  };
}

/** The hosted class's side of a call: only the root can name this facet, so no caller check is needed. */
export function isHostedCall(method: string): boolean {
  return method.startsWith(`${HOSTED_ROUTE}/`);
}

export async function serveHostedCall(input: {
  instance: object;
  props: CodeHostProps;
  method: string;
  body: string;
  onRevoked(reason: string): Promise<void>;
}): Promise<Response> {
  const respond = (value: unknown, status = 200): Response =>
    new Response(encodeRpcJson(value), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  if (!input.props.host) return respond({ error: { message: "This object is not hosted" } }, 403);
  const method = input.method.slice(HOSTED_ROUTE.length + 1);
  const parsed = input.body ? (decodeRpcJson(input.body) as Record<string, unknown>) : {};
  if (method === "__revoked") {
    await input.onRevoked(String(parsed["reason"] ?? "operator"));
    return respond({ result: null });
  }
  if (!rpcExposedMethodNames(input.instance).has(method))
    return respond({ error: { message: `Hosted method ${method} is not exposed` } }, 404);
  const handler = (input.instance as Record<string, unknown>)[method];
  if (typeof handler !== "function")
    return respond({ error: { message: `Hosted method ${method} is not callable` } }, 404);
  try {
    const args = Array.isArray(parsed["args"]) ? parsed["args"] : [];
    const result = await (handler as (...values: unknown[]) => unknown).apply(input.instance, args);
    return respond({ result: result === undefined ? null : result });
  } catch (error) {
    return respond({ error: serializeRpcFailure(error) }, 500);
  }
}
