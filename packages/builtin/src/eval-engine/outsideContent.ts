/**
 * Which host calls bring content from outside the workspace into an eval.
 *
 * An agent's standing approvals were granted for its task as it stood; once a web
 * page, a remote repository, or a browser page's contents enter that task, they
 * no longer cover what the agent is acting on. The agent's tools drop those
 * approvals when they ingest such content (`outside-content-reset`). Eval code
 * can reach the same content through the runtime's bindings, the raw service
 * proxy, or `rpc` directly, so the one place that sees all of them is the eval's
 * RPC transport: this module names the calls, and `guardOutsideContent*` wraps
 * the transport so the owning agent is told before the content is returned.
 */

interface UrlArgument {
  url?: unknown;
}

function urlHost(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return new URL(value).hostname || null;
  } catch {
    return null;
  }
}

function firstArgument(args: readonly unknown[]): unknown {
  return args[0];
}

function fieldOf(value: unknown, ...names: string[]): string | null {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return null;
  for (const name of names) {
    const field = (value as Record<string, unknown>)[name];
    if (typeof field === "string") return field;
  }
  return null;
}

/** Egress that returns a remote server's response body to the caller. */
const URL_EGRESS = new Set([
  "credentials.proxyFetch",
  "credentials.publishFetch",
  "credentials.proxyGitHttp",
  "credentials.openWebSocketScope",
  "chromiumFetch.openPublic",
  "chromiumFetch.openBrowser",
]);

/** Remote Git operations: the repository, branch, or default-branch name comes from the remote. */
const GIT_EGRESS = new Set([
  "gitInterop.importProject",
  "gitInterop.cloneRepo",
  "gitInterop.pullUpstream",
  "gitInterop.remoteDefaultBranch",
]);

/** Reads of a live browser page: its DOM, script results, screenshots, console, downloads. */
const PAGE_EGRESS = new Set([
  "panelCdp.getCdpEndpoint",
  "panelCdp.evaluate",
  "panelCdp.screenshot",
  "panelCdp.consoleHistory",
  "panelCdp.browserOperation",
]);

/**
 * The source key for a call that ingests outside content, or null for any other
 * call. Keys name where the content came from (`web:<host>`, `git:<method>:<repo>`,
 * `cdp:<panel>`); the agent's latch resets once per distinct key.
 */
export function outsideContentSource(
  targetId: string,
  method: string,
  args: readonly unknown[]
): string | null {
  if (targetId !== "main") return null;
  const first = firstArgument(args);
  if (URL_EGRESS.has(method)) {
    const target = method.startsWith("chromiumFetch.")
      ? first
      : (first as UrlArgument | undefined)?.url;
    return `web:${urlHost(target) ?? "unknown-host"}`;
  }
  if (GIT_EGRESS.has(method)) {
    const subject =
      method === "gitInterop.remoteDefaultBranch"
        ? (urlHost((first as UrlArgument | undefined)?.url) ?? "unknown-host")
        : (fieldOf(first, "repoPath", "path") ?? "unknown-repo");
    return `git:${method.slice("gitInterop.".length)}:${subject}`;
  }
  if (PAGE_EGRESS.has(method)) {
    return `cdp:${fieldOf(first) ?? "unknown-panel"}`;
  }
  return null;
}

/** Reports a source to the agent that owns the eval; rejects if it cannot be recorded. */
export type OutsideContentRecorder = (entry: { key: string }) => Promise<void>;

async function record(
  recorder: OutsideContentRecorder | undefined,
  targetId: string,
  method: string,
  args: readonly unknown[]
): Promise<void> {
  if (!recorder) return;
  const key = outsideContentSource(targetId, method, args);
  if (key) await recorder({ key });
}

/**
 * A unary call whose response is outside content is recorded once it succeeds
 * and before it is returned: a failed request ingested nothing.
 */
export function guardOutsideContentCall<A extends unknown[], R>(
  call: (targetId: string, method: string, args: unknown[], ...rest: A) => Promise<R>,
  recorder: OutsideContentRecorder | undefined
): (targetId: string, method: string, args: unknown[], ...rest: A) => Promise<R> {
  if (!recorder) return call;
  return async (targetId, method, args, ...rest) => {
    const result = await call(targetId, method, args, ...rest);
    await record(recorder, targetId, method, args);
    return result;
  };
}

/**
 * A stream cannot be intercepted chunk by chunk, so it is recorded before it
 * opens: no byte reaches the task until the owner has dropped its approvals.
 */
export function guardOutsideContentStream<A extends unknown[], R>(
  open: (targetId: string, method: string, args: unknown[], ...rest: A) => Promise<R>,
  recorder: OutsideContentRecorder | undefined
): (targetId: string, method: string, args: unknown[], ...rest: A) => Promise<R> {
  if (!recorder) return open;
  return async (targetId, method, args, ...rest) => {
    await record(recorder, targetId, method, args);
    return open(targetId, method, args, ...rest);
  };
}
