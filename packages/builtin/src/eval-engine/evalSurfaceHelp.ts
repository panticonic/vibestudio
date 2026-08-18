/**
 * Eval-engine `help('<name>')` surface description — the pure core, so it can be unit-tested under Node
 * (evalDO.ts pulls worker-only imports). `EvalDO.describeInjectedSurface` gathers the live binding's
 * method names + the RPC-service schema and hands them here.
 */

/**
 * Help notes for injected runtime methods whose ergonomic shape isn't captured by the raw RPC-service
 * schema (the wrappers that deliberately diverge from the wire methods). Keyed `binding.method`.
 */
export const EVAL_RUNTIME_METHOD_NOTES: Record<string, { description: string }> = {
  "agent.describe": {
    description:
      "describe() → Promise<{ identity, config, channels, tools, turn, effects }>. Await it. " +
      "This is observational and is available in read-only agent evals.",
  },
  "automations.propose": {
    description:
      "propose({ name, summary, action, trigger, conversation?, toolExposure?, " +
      "declaredLineageClasses?, permissions?, standingRestrictions? }) → inert automation draft. " +
      "The owning agent supplies its exact source, class, object key, and effective version; do not " +
      "resolve a build version or construct a target yourself. Await the result. Agent eval only.",
  },
  "ctx.reportProgress": {
    description:
      "reportProgress(value) records bounded progress for the current deferred eval run. " +
      "It is present only when this eval has a durable run id.",
  },
  "ctx.onCancel": {
    description:
      "onCancel(handler) registers cleanup for cancellation of the current deferred eval run. " +
      "It is present only when this eval has a durable run id.",
  },
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
  "fs.mkdtemp": {
    description:
      "mkdtemp(prefix?) → creates and returns a unique temp DIRECTORY under .tmp/. This is the " +
      "Node-style directory counterpart to mktemp; use mktemp when you only need a unique file path.",
  },
  "vcs.commit": {
    description:
      "commit({ contextId, expectedWorkingHead, commandId, message? }) → one atomic workspace event containing the complete local application chain. Integration parents are derived exclusively from local merge decisions. There is no staging or selective commit; use another context for an independent boundary.",
  },
  "runtime.createEntity": {
    description:
      "Prefer workers.create(source, options) for regular workers. The raw equivalent is " +
      'rpc.call("main", `runtime.createEntity`, [{ kind: "worker", source, key, contextId, env, stateArgs }]). ' +
      "`key` names an immutable instance identity: it cannot silently switch to a different code " +
      "build. For disposable edit-and-run probes, generate a fresh key after each code change and " +
      "always retire the returned handle in finally; for a stable key, retire the old instance " +
      "before deliberately creating its replacement. Pass " +
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
      "Prefer workers.destroy(entityOrId) for regular workers and disposable resolved Durable Objects. The raw equivalent is " +
      'rpc.call("main", `runtime.retireEntity`, [{ id }]), passing the entity id returned by ' +
      "runtime.createEntity or the targetId returned by workers.resolveDurableObject. Resolving a shared service does not transfer ownership; retire only entities whose lifecycle you own. Verify retirement with runtime.listEntities.",
  },
  "workers.create": {
    description:
      "create(source, options?) → worker handle { id, targetId, … }. options.key is an immutable " +
      "instance identity and never silently changes code builds. Use a fresh key for each disposable " +
      "edit-and-run probe, call the worker through handle.targetId, and await workers.destroy(handle) " +
      "in finally. To reuse a stable key after a source update, retire its old instance first.",
  },
  "workers.destroy": {
    description:
      "destroy(handleOrId) retires one regular-worker instance. Await it from finally before " +
      "reusing a stable key or finishing a disposable probe.",
  },
};

/**
 * Public eval namespaces whose ergonomic name intentionally differs from the
 * canonical RPC service they type-wrap. Keeping aliases at the reflection
 * boundary lets help derive method contracts from the same schema as the
 * runtime client.
 */
export const EVAL_RUNTIME_SERVICE_NAMES: Readonly<Record<string, string>> = {
  git: "gitInterop",
};

export function evalRuntimeServiceName(bindingName: string): string {
  return EVAL_RUNTIME_SERVICE_NAMES[bindingName] ?? bindingName;
}

export interface InjectedSurfaceDescription {
  name: string;
  surface: "injected-runtime";
  note: string;
  methods: Record<string, unknown>;
}

export interface InjectedSurfaceIndexDescription {
  name: string;
  surface: "injected-runtime-index";
  note: string;
  methods: Array<{ name: string; description: string }>;
  next: string;
}

export interface InjectedSurfaceMethodDescription {
  name: string;
  surface: "injected-runtime-method";
  description?: string;
  call: string;
  parameters: Array<{ name: string; type: string }>;
  returns?: string;
  examples?: Array<{ call: string; returns?: unknown; note?: string }>;
  access?: unknown;
  errors?: unknown;
  seeAlso?: unknown;
  note: string;
}

type JsonSchema = Record<string, unknown>;

function schemaType(schema: unknown, depth = 0): string {
  if (!schema || typeof schema !== "object" || depth > 24) return "unknown";
  const value = schema as JsonSchema;
  if (value["nullable"] === true) {
    const inner = { ...value };
    delete inner["nullable"];
    return `${schemaType(inner, depth + 1)} | null`;
  }
  if (Array.isArray(value["enum"])) {
    return (value["enum"] as unknown[]).map((item) => JSON.stringify(item)).join(" | ");
  }
  if ("const" in value) return JSON.stringify(value["const"]);
  const union = (value["anyOf"] ?? value["oneOf"]) as unknown[] | undefined;
  if (Array.isArray(union)) {
    return union.map((item) => schemaType(item, depth + 1)).join(" | ");
  }
  if (Array.isArray(value["allOf"])) {
    return (value["allOf"] as unknown[]).map((item) => schemaType(item, depth + 1)).join(" & ");
  }
  const type = value["type"];
  if (Array.isArray(type)) return type.map(String).join(" | ");
  if (type === "string") return "string";
  if (type === "integer") return "integer";
  if (type === "number") return "number";
  if (type === "boolean") return "boolean";
  if (type === "null") return "null";
  if (type === "array") {
    if (Array.isArray(value["items"])) {
      return `[${(value["items"] as unknown[])
        .map((item) => schemaType(item, depth + 1))
        .join(", ")}]`;
    }
    return `(${schemaType(value["items"], depth + 1)})[]`;
  }
  const properties = value["properties"];
  if (properties && typeof properties === "object") {
    const required = new Set(
      Array.isArray(value["required"]) ? (value["required"] as string[]) : []
    );
    const fields = Object.entries(properties as Record<string, unknown>).map(
      ([name, property]) =>
        `${name}${required.has(name) ? "" : "?"}: ${schemaType(property, depth + 1)}`
    );
    return `{ ${fields.join("; ")} }`;
  }
  if (typeof value["$ref"] === "string") {
    return (value["$ref"] as string).split("/").at(-1) ?? "unknown";
  }
  return typeof type === "string" ? type : "unknown";
}

function methodArgumentTypes(argsSchema: unknown): string[] {
  if (!argsSchema || typeof argsSchema !== "object") return [];
  const schema = argsSchema as JsonSchema;
  const tuple = schema["prefixItems"] ?? schema["items"];
  if (schema["type"] === "array" && Array.isArray(tuple)) {
    return (tuple as unknown[]).map((item) => schemaType(item));
  }
  return [schemaType(schema)];
}

/** Bounded projection of MethodSchema.examples into exact executable calls. */
const MAX_RENDERED_EXAMPLES = 3;

function renderMethodExamples(
  qualifiedName: string,
  examples: unknown
): Array<{ call: string; returns?: unknown; note?: string }> {
  if (!Array.isArray(examples)) return [];
  const rendered: Array<{ call: string; returns?: unknown; note?: string }> = [];
  for (const example of examples) {
    if (rendered.length >= MAX_RENDERED_EXAMPLES) break;
    if (!example || typeof example !== "object") continue;
    const { args, returns, note } = example as {
      args?: unknown;
      returns?: unknown;
      note?: unknown;
    };
    if (!Array.isArray(args)) continue;
    let renderedArgs: string[];
    try {
      renderedArgs = args.map((arg) => JSON.stringify(arg) ?? "undefined");
    } catch {
      // Method examples are pure catalog data. A non-JSON value must not make
      // the whole live help request fail; omit only that malformed example.
      continue;
    }
    rendered.push({
      call: `await ${qualifiedName}(${renderedArgs.join(", ")})`,
      ...(returns !== undefined ? { returns } : {}),
      ...(typeof note === "string" ? { note } : {}),
    });
  }
  return rendered;
}

/**
 * Project a method's machine JSON Schema into a shallow, faithful contract.
 *
 * Eval transport serialization is deliberately depth-bounded. Returning raw
 * schemas made nested discriminated unions look incomplete precisely when an
 * agent asked for exact help. Strings preserve the whole type while keeping
 * the normal help path much smaller than the raw catalog entry.
 */
export function describeEvalMethod(
  qualifiedName: string,
  method: unknown
): InjectedSurfaceMethodDescription {
  const source = method && typeof method === "object" ? (method as Record<string, unknown>) : {};
  const args = methodArgumentTypes(source["argsSchema"]);
  // Preserve positions. Filtering malformed metadata would shift every later
  // name onto the wrong argument, which is worse than falling back to argN.
  const declaredNames = Array.isArray(source["argumentNames"])
    ? (source["argumentNames"] as unknown[])
    : [];
  const parameterNames = args.map((_, index) =>
    typeof declaredNames[index] === "string" &&
    /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(declaredNames[index] as string)
      ? (declaredNames[index] as string)
      : args.length === 1
        ? "input"
        : `arg${index}`
  );
  const examples = renderMethodExamples(qualifiedName, source["examples"]);
  return {
    name: qualifiedName,
    surface: "injected-runtime-method",
    ...(typeof source["description"] === "string"
      ? { description: source["description"] as string }
      : {}),
    call: `await ${qualifiedName}(${parameterNames.join(", ")})`,
    parameters: args.map((type, index) => ({ name: parameterNames[index]!, type })),
    ...(source["returnsSchema"] ? { returns: schemaType(source["returnsSchema"]) } : {}),
    ...(examples.length > 0 ? { examples } : {}),
    ...("access" in source ? { access: source["access"] } : {}),
    ...("errors" in source ? { errors: source["errors"] } : {}),
    ...("seeAlso" in source ? { seeAlso: source["seeAlso"] } : {}),
    note: "Compact exact types for the injected call. Use the docs service only when machine-readable JSON Schema is needed.",
  };
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
  notes: Record<string, { description: string }> = EVAL_RUNTIME_METHOD_NOTES,
  serviceName = name
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
      `\`${serviceName}\` RPC service (via \`rpc.call("main", "${serviceName}.…", [...])\`) may differ. ` +
      `When a service name also exists as a runtime binding, \`services.${name}\` is this ` +
      `ergonomic client; use \`rpc.call\` for raw service-only methods. Low-level wire methods ` +
      `are intentionally hidden behind these wrappers.`,
    methods,
  };
}

/**
 * Keep binding-level discovery small. Exact schemas are intentionally exposed
 * only by `help("<binding>.<method>")`; returning every nested schema from
 * `help("<binding>")` makes the useful method list disappear inside a
 * transport-truncated payload.
 */
export function describeEvalBindingIndex(
  description: InjectedSurfaceDescription
): InjectedSurfaceIndexDescription {
  return {
    name: description.name,
    surface: "injected-runtime-index",
    note: description.note,
    methods: Object.entries(description.methods).map(([name, method]) => ({
      name,
      description:
        method &&
        typeof method === "object" &&
        typeof (method as Record<string, unknown>)["description"] === "string"
          ? ((method as Record<string, unknown>)["description"] as string)
          : "Runtime method.",
    })),
    next: `Call help("${description.name}.<method>") for that method's exact arguments, return schema, and typed errors.`,
  };
}
