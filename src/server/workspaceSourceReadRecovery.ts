import { createHash } from "node:crypto";
import { serializeRpcFailure, type RpcFailure } from "@vibestudio/rpc";
import { AMBIGUOUS_DO_DISPATCH, type DORef } from "@vibestudio/shared/doDispatcher";
import { canonicalJson } from "@vibestudio/shared/canonicalJson";
import {
  vcsListDirectoryInputSchema,
  vcsListFilesInputSchema,
  vcsReadFilesInputSchema,
  vcsResolveRepositoryInputSchema,
} from "@vibestudio/service-schemas/vcs";
import { z } from "zod";

const contextId = z.string().min(1).nullable();
const pinnedReads = {
  readHistoryFiles: z.object({ contextId, read: vcsReadFilesInputSchema }).strict(),
  resolveHistoryRepository: z.object({ contextId, repository: vcsResolveRepositoryInputSchema }).strict(),
  listHistoryFiles: z.object({ contextId, list: vcsListFilesInputSchema }).strict(),
  listHistoryDirectory: z.object({ contextId, list: vcsListDirectoryInputSchema }).strict(),
  readHistoryTemplateInstallation: z.object({ eventId: z.string().min(1) }).strict(),
};

/** Recovery belongs to the versioned read protocol, never the generic POST dispatcher. */
export function isPinnedWorkspaceRead(method: string, args: readonly unknown[]): boolean {
  return args.length === 1 && Object.hasOwn(pinnedReads, method) &&
    pinnedReads[method as keyof typeof pinnedReads].safeParse(args[0]).success;
}

/** Only structured local transport loss, never a semantic, protocol or cancellation verdict. */
export function isResetWorkspaceRead(error: unknown): boolean {
  let ambiguous = false;
  let disconnected = false;
  const seen = new Set<object>();
  while (error && typeof error === "object" && !seen.has(error)) {
    seen.add(error);
    const node = error as {
      name?: string; code?: string; errorKind?: string; cause?: unknown;
      errors?: unknown; systemError?: { code?: string };
    };
    if (Array.isArray(node.errors) || node.name === "AbortError" ||
        ["RPC_ABORTED", "ABORT_ERR", "ERR_CANCELED", "EACCES", "EPERM"].includes(node.code ?? "") ||
        ["access", "application", "protocol"].includes(node.errorKind ?? "")) return false;
    if (node.code && ![AMBIGUOUS_DO_DISPATCH, "ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "ECONNREFUSED"].includes(node.code)) {
      return false;
    }
    if (node.code === AMBIGUOUS_DO_DISPATCH) ambiguous = true;
    if (["ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "ECONNREFUSED"].includes(
      node.code ?? node.systemError?.code ?? ""
    )) disconnected = true;
    error = node.cause;
  }
  return ambiguous && disconnected;
}

export async function dispatchWorkspaceSourceRead(
  provider: DORef,
  method: string,
  args: unknown[],
  dispatch: (provider: DORef, args: unknown[]) => Promise<unknown>
): Promise<unknown> {
  if (process.env["VIBESTUDIO_RETRY_PINNED_READS"] === "0" || !isPinnedWorkspaceRead(method, args)) {
    return dispatch(provider, args);
  }
  // Snapshot before admission. A caller or receiver cannot change a selector
  // between attempts; each dispatch still resolves current executable authority.
  const target = { ...provider };
  const encoded = JSON.stringify(args);
  const requestDigest = createHash("sha256").update(canonicalJson({ target, method, args })).digest("hex");
  const failures: unknown[] = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await dispatch({ ...target }, JSON.parse(encoded) as unknown[]);
    } catch (error) {
      if (!isResetWorkspaceRead(error)) throw error;
      failures.push(error);
      const failure: RpcFailure = serializeRpcFailure(error);
      console.warn("[WorkspaceSourceRead] transport attempt failed", JSON.stringify({
        provider: target, method, requestDigest, attempt, attempts: 2,
        retry: attempt < 2, failure,
      }));
      if (attempt === 2) {
        throw Object.assign(new AggregateError(
          failures,
          `Versioned workspace read exhausted two transport attempts: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        ), { code: "VCS_READ_TRANSPORT_EXHAUSTED", errorKind: "transport" });
      }
    }
  }
  throw new Error("Unreachable workspace read recovery state");
}
