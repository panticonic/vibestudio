/**
 * Eval `help('<name>')` surface description — the pure core, so it can be unit-tested under Node
 * (evalDO.ts pulls worker-only imports). `EvalDO.describeInjectedSurface` gathers the live binding's
 * method names + the RPC-service schema and hands them here.
 */

/**
 * Help notes for injected runtime methods whose ergonomic shape isn't captured by the raw RPC-service
 * schema (the wrappers that deliberately diverge from the wire methods). Keyed `binding.method`.
 */
export const EVAL_RUNTIME_METHOD_NOTES: Record<string, { description: string }> = {
  "blobstore.putBytes": {
    description:
      "putBytes(bytes: Uint8Array | ArrayBuffer) → { digest, size }. Runtime-only convenience " +
      "that losslessly base64-encodes exactly one byte buffer and calls blobstore.putBase64. " +
      "The content-addressed store keeps bytes only; return MIME metadata alongside the digest.",
  },
  "fs.open": {
    description:
      "open(path, flags?, mode?) → FileHandle { fd, read(buf, off, len, pos), " +
      "write(data, off?, len?, pos?) where data is Uint8Array | string, close(), stat() }. " +
      "The low-level fs.handle* RPC methods are internal — use this FileHandle, not handle*.",
  },
  "fs.mktemp": {
    description:
      "mktemp(prefix?) → a unique temp FILE path under .tmp/ (the file is NOT created — write to it, " +
      "or use it as a name and rename into place). For a temp DIRECTORY, mkdir it yourself. This is " +
      "NOT Node's mkdtemp (which creates the directory), and .tmp paths are scratch space, not " +
      "tracked edit/VCS destinations.",
  },
  "vcs.fileHistory": {
    description:
      "fileHistory({ path, repoPath?, head?, limit? }) → edit rows in commit-lineage order plus the uncommitted tail. `path` is workspace-relative unless `repoPath` makes it repo-relative; `head` defaults to this runtime's own ctx head.",
  },
  "vcs.commit": {
    description:
      "commit(input) → per-repo result array. For a single result, its fields are also available on the array (`result.eventId`, `result.status`, etc.) while `result[0]` remains canonical.",
  },
  "vcs.editsByActor": {
    description: "editsByActor(actorId, limit?) → edit rows attributed to that actor.",
  },
  "vcs.editsByTurn": {
    description: "editsByTurn(turnId) → edit rows causally attributed to that agent turn.",
  },
  "vcs.editsByInvocation": {
    description:
      "editsByInvocation(invocationId) → edit rows causally attributed to one tool invocation.",
  },
  "runtime.createEntity": {
    description:
      "Prefer workers.create(source, options) for regular workers. The raw equivalent is " +
      'rpc.call("main", `runtime.createEntity`, [{ kind: "worker", source, key, contextId, env, stateArgs }]). ' +
      "`key` names the instance (it maps to the worker entity key); pass " +
      "`ref: `ctx:${ctx.contextId}`` for worker code created or edited on the current context head, " +
      "and omit ref only when intentionally launching the main build. `env` accepts extra string " +
      "bindings delivered to the worker fetch handler's WorkerEnv; successful creation proves the " +
      "configuration was accepted, not that worker code observed a value. Verify a named non-secret " +
      "probe through a worker endpoint/RPC; workers/hello provides readNonSecretProbe for the fixed " +
      "NON_SECRET_PROBE binding. Launchable sources and their real manifest entry points " +
      "are listed with workers.listSources() (raw: " +
      'rpc.call("main", `workers.listSources`, [])).',
  },
  "runtime.retireEntity": {
    description:
      "Prefer workers.destroy(handleOrId) for regular workers. The raw equivalent is " +
      'rpc.call("main", `runtime.retireEntity`, [{ id }]), passing the entity id returned by ' +
      "runtime.createEntity. Verify it disappeared with workers.list() or runtime.listEntities.",
  },
};

export interface InjectedSurfaceDescription {
  name: string;
  surface: "injected-runtime";
  note: string;
  methods: Record<string, unknown>;
}

export function invalidHelpArgumentResponse(value: unknown): Record<string, unknown> {
  const received =
    value && typeof value === "object"
      ? Object.keys(value as Record<string, unknown>).length > 0
        ? Object.keys(value as Record<string, unknown>)
            .slice(0, 8)
            .join(", ")
        : "object"
      : typeof value;
  return {
    error: "help() expects a string service or runtime binding name.",
    received,
    example: 'await help("workers")',
    note:
      "Pass the binding name as a string. For a live object's enumerable methods, " +
      "Object.keys(workers) also works.",
  };
}

/**
 * Describe an injected runtime binding as eval ACTUALLY sees it: its live method names, each enriched
 * from the RPC-service schema where names match — but a known ergonomic note wins (e.g. fs.open
 * returns a FileHandle, NOT the service's `{handleId}`), and methods absent from `liveMethodNames`
 * (the hidden wire methods like fs.handleClose) are dropped. Returns null when there are no live
 * methods, so the caller can fall back to the raw service schema.
 */
export function describeEvalBindingSurface(
  name: string,
  liveMethodNames: string[],
  serviceMethods: Record<string, unknown>,
  notes: Record<string, { description: string }> = EVAL_RUNTIME_METHOD_NOTES
): InjectedSurfaceDescription | null {
  if (liveMethodNames.length === 0) return null;
  const methods: Record<string, unknown> = {};
  for (const m of [...liveMethodNames].sort()) {
    methods[m] = notes[`${name}.${m}`] ??
      serviceMethods[m] ?? {
        description:
          "Runtime method — no RPC-service schema; introspect the return value or see skills/sandbox/EVAL.md.",
      };
  }
  return {
    name,
    surface: "injected-runtime",
    note:
      `Methods on the injected \`${name}\` binding — what eval code calls directly. The raw ` +
      `\`${name}\` RPC service (via \`rpc.call("main", "${name}.…", [...])\`) may differ. ` +
      `When a service name also exists as a runtime binding, \`services.${name}\` is this ` +
      `ergonomic client; use \`rpc.call\` for raw service-only methods. Low-level wire methods ` +
      `are intentionally hidden behind these wrappers.`,
    methods,
  };
}
