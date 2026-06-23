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
      "NOT Node's mkdtemp (which creates the directory).",
  },
};

/**
 * Disambiguate the eval ambient `rpc.call` arguments. EVAL.md documents the 2-arg sugar
 * `call(method, args)` (targets the server, "main"); for ergonomics we ALSO accept the full-client
 * habit `call(target, method, args)` (e.g. `call("main", "docs.describeService", [...])` or a
 * runtime-id target). They're told apart by whether the 2nd arg is a method STRING (→ 3-arg) vs an
 * args ARRAY / undefined (→ 2-arg). Returns the resolved `[target, method, args]`.
 */
export function normalizeAmbientRpcCall(
  a: string,
  b?: unknown,
  c?: unknown
): [target: string, method: string, args: unknown[]] {
  if (typeof b === "string") return [a, b, (c as unknown[]) ?? []];
  return ["main", a, (b as unknown[]) ?? []];
}

export interface InjectedSurfaceDescription {
  name: string;
  surface: "injected-runtime";
  note: string;
  methods: Record<string, unknown>;
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
      `\`${name}\` RPC service (via \`services.${name}\`/\`rpc.call("${name}.…")\`) may differ; ` +
      `low-level wire methods are intentionally hidden behind these ergonomic wrappers.`,
    methods,
  };
}
