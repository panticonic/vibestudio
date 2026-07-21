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
  "blobstore.getBytes": {
    description:
      "getBytes(digest) → Uint8Array | null. Runtime-only convenience that decodes the " +
      "canonical blobstore.getBase64 wire result, so binary content can be compared or consumed " +
      "without importing a base64 library.",
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
  "vcs.commit": {
    description:
      "commit({ contextId, expectedWorkingHead, commandId, integratesEventId?, message? }) → one atomic workspace event containing the complete local application chain. Integration parents are derived from local decisions; pass integratesEventId only for a zero-change source or to confirm the derived source. There is no staging or selective commit; use another context for an independent boundary.",
  },
  "runtime.createEntity": {
    description:
      "Prefer workers.create(source, options) for regular workers. The raw equivalent is " +
      'rpc.call("main", `runtime.createEntity`, [{ kind: "worker", source, key, contextId, env, stateArgs }]). ' +
      "`key` names the instance (it maps to the worker entity key); pass " +
      "`ref: ctx:${ctx.contextId}` only when deliberately resolving code from that semantic context, " +
      "and omit ref only when intentionally launching the current main build. The build resolver binds either selector to an exact source identity before compilation. `env` accepts extra string " +
      "bindings delivered to the worker fetch handler's WorkerEnv; successful creation proves the " +
      "configuration was accepted, not that worker code observed a value. Verify a named non-secret " +
      "probe implemented by the worker under test through its endpoint/RPC. Launchable sources and " +
      "their real manifest entry points " +
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
