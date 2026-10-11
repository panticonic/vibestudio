import { portableExports } from "@vibestudio/service-schemas/runtime/runtimeSurface.portable";
import { jsonSchemaNumericType } from "@vibestudio/shared/jsonSchemaNumericType";

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
      "describe() → Promise<{ identity, config, channels, tools, execution }>. Await it. " +
      "This is the owning agent’s self-inspection/debug snapshot and is available in read-only agent evals.",
  },
  "chat.callMethod": {
    description:
      "callMethod(participantId: string, method: string, args: JSON value) → delivered result content. " +
      "Resolve the exact participant and its advertised method first; this calls a participant method, not channel history. " +
      "For channel history, use the bounded gad.inspectChannelEnvelopes inspector.",
  },
  "chat.callMethodResult": {
    description:
      "callMethodResult(participantId: string, method: string, args: JSON value) → { content }. " +
      "All three arguments are required. Resolve the exact participant and its advertised method first; " +
      "for channel history, use the bounded gad.inspectChannelEnvelopes inspector.",
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
      "Prefer workers.create(source, options) for regular workers. Import mainRpcMethods from " +
      "@vibestudio/service-schemas/mainRpc; the raw equivalent is " +
      'rpc.call("main", mainRpcMethods["runtime.createEntity"], [{ kind: "worker", source, key, contextId, env, stateArgs }]). ' +
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
      'rpc.call("main", mainRpcMethods["workers.listSources"], [])).',
  },
  "runtime.retireEntity": {
    description:
      "Prefer workers.destroy(entityOrId) for regular workers and caller-created Durable Objects. " +
      "Import mainRpcMethods from @vibestudio/service-schemas/mainRpc; the raw equivalent is " +
      'rpc.call("main", mainRpcMethods["runtime.retireEntity"], [{ id }]), passing the entity id returned by ' +
      "runtime.createEntity. Resolving a Durable Object or shared service does not transfer ownership; create owned disposable objects with workers.createDurableObject. Verify retirement with runtime.listEntities.",
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
      "destroy(handleOrId) retires one caller-created worker or Durable Object. Await it from finally before " +
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

/** Generated service clients group dotted methods into enumerable namespaces. */
export function evalBindingMethodNames(binding: Record<string, unknown>): string[] {
  const names: string[] = [];
  const ancestors = new Set<object>();
  function visit(value: Record<string, unknown>, prefix: string): void {
    if (ancestors.has(value)) return;
    ancestors.add(value);
    for (const [key, member] of Object.entries(value)) {
      const name = prefix ? `${prefix}.${key}` : key;
      if (typeof member === "function") names.push(name);
      else if (member && typeof member === "object" && !Array.isArray(member))
        visit(member as Record<string, unknown>, name);
    }
    ancestors.delete(value);
  }
  visit(binding, "");
  return names.sort();
}

export interface InjectedSurfaceDescription {
  name: string;
  surface: "injected-runtime";
  note: string;
  description?: string;
  signature?: string;
  methods: Record<string, unknown>;
}

export interface InjectedSurfaceIndexDescription {
  name: string;
  surface: "injected-runtime-index";
  description?: string;
  signature?: string;
  note: string;
  methods: Array<{ name: string; description: string }>;
  next: string;
}

export interface InjectedSurfaceMethodDescription {
  name: string;
  surface: "injected-runtime-method";
  description?: string;
  signature?: string;
  call?: string;
  overloads?: string[];
  parameters?: Array<{ name: string; type: string }>;
  returns?: string;
  examples?: Array<{ call: string; returns?: unknown; note?: string }>;
  access?: unknown;
  authority?: unknown;
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
  if (type === "string") return value["format"] === "binary" ? "Uint8Array" : "string";
  if (type === "integer" || type === "number") return jsonSchemaNumericType(type, value);
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
  const additionalProperties = value["additionalProperties"];
  const hasAdditionalProperties =
    additionalProperties === true ||
    (additionalProperties !== null && typeof additionalProperties === "object");
  if (hasAdditionalProperties && (!properties || typeof properties !== "object")) {
    return `Record<string, ${schemaType(additionalProperties, depth + 1)}>`;
  }
  if (properties && typeof properties === "object") {
    const required = new Set(
      Array.isArray(value["required"]) ? (value["required"] as string[]) : []
    );
    const fields = Object.entries(properties as Record<string, unknown>).map(
      ([name, property]) =>
        `${name}${required.has(name) ? "" : "?"}: ${schemaType(property, depth + 1)}`
    );
    if (hasAdditionalProperties) {
      return fields.length > 0
        ? `{ ${fields.join("; ")}; [key: string]: ${schemaType(additionalProperties, depth + 1)} }`
        : `Record<string, ${schemaType(additionalProperties, depth + 1)}>`;
    }
    return `{ ${fields.join("; ")} }`;
  }
  if (typeof value["$ref"] === "string") {
    return (value["$ref"] as string).split("/").at(-1) ?? "unknown";
  }
  return typeof type === "string" ? type : "unknown";
}

function methodArgumentLists(argsSchema: unknown): string[][] {
  if (!argsSchema || typeof argsSchema !== "object") return [[]];
  const schema = argsSchema as JsonSchema;
  const union = schema["anyOf"] ?? schema["oneOf"];
  if (Array.isArray(union)) return union.flatMap(methodArgumentLists);
  const tuple = schema["prefixItems"] ?? schema["items"];
  if (schema["type"] === "array" && Array.isArray(tuple)) {
    return [(tuple as unknown[]).map((item) => schemaType(item))];
  }
  return [[schemaType(schema)]];
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
  const argumentLists = methodArgumentLists(source["argsSchema"]);
  const args = argumentLists[0] ?? [];
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
    ...(typeof source["signature"] === "string" ? { signature: source["signature"] } : {}),
    ...(source["argsSchema"]
      ? {
          call: `await ${qualifiedName}(${parameterNames.join(", ")})`,
          parameters: args.map((type, index) => ({ name: parameterNames[index]!, type })),
        }
      : {}),
    ...(argumentLists.length > 1
      ? { overloads: argumentLists.map((types) => `${qualifiedName}(${types.join(", ")})`) }
      : {}),
    ...(source["returnsSchema"] ? { returns: schemaType(source["returnsSchema"]) } : {}),
    ...(examples.length > 0 ? { examples } : {}),
    ...("access" in source ? { access: source["access"] } : {}),
    ...("authority" in source ? { authority: source["authority"] } : {}),
    ...("errors" in source ? { errors: source["errors"] } : {}),
    ...("seeAlso" in source ? { seeAlso: source["seeAlso"] } : {}),
    note: source["argsSchema"]
      ? "Compact exact types for the injected call. Use the docs service only when machine-readable JSON Schema is needed."
      : "No argument schema is available. Use the public signature and referenced source types; missing metadata does not mean the method takes no arguments.",
  };
}

export function unknownHelpNameResponse(name: string): {
  name: string;
  error: string;
  guidance: string;
} {
  return {
    name,
    error: "No injected runtime binding or callable service has this name.",
    guidance:
      "help() describes injected @workspace/runtime bindings and receiver services, not exports of other packages. " +
      "For a workspace package or skill, read its SKILL.md/API reference and exported source types, then import its documented functions from its package name. " +
      "A missing help entry does not make a documented package API unavailable. Use docs_search/docs_open as agent tools for receiver contracts, or await help() for binding names.",
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
 * from the canonical injected-runtime catalog first, then the RPC-service schema where names match.
 * Supplementary usage notes enrich canonical contracts; where no canonical catalog exists an
 * ergonomic note takes precedence over a differing raw schema (e.g. fs.open
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
    const surface = portableExports[name];
    const canonical = surface?.kind === "namespace" ? surface.methodCatalog?.[m] : undefined;
    const guidance = notes[`${name}.${m}`];
    methods[m] = canonical
      ? guidance
        ? {
            ...canonical,
            description: [canonical.description, guidance.description].filter(Boolean).join(" "),
          }
        : canonical
      : (guidance ??
        serviceMethods[m] ?? {
          description:
            "Runtime method — no RPC-service schema; introspect the return value or see skills/sandbox/EVAL.md.",
        });
  }
  return {
    name,
    surface: "injected-runtime",
    ...(portableExports[name]?.description
      ? { description: portableExports[name].description }
      : {}),
    ...(portableExports[name]?.kind === "value" && portableExports[name].signature
      ? { signature: portableExports[name].signature }
      : {}),
    note:
      `Methods on the injected \`${name}\` binding — what eval code calls directly. The raw ` +
      `\`${serviceName}\` RPC service (via \`services.${serviceName}\` or ` +
      `\`rpc.call("main", mainRpcMethods["${serviceName}.<method>"], [...])\`) may differ. ` +
      `Import mainRpcMethods from \`@vibestudio/service-schemas/mainRpc\`. Low-level wire methods ` +
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
    ...(description.description ? { description: description.description } : {}),
    ...(description.signature ? { signature: description.signature } : {}),
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

/**
 * Create the interactive eval help function. Help is both display-oriented and
 * composable: each request is written to the captured output stream, while its
 * structured description remains the function's resolved value.
 */
export function createEvalHelp(
  describe: (name?: string) => Promise<unknown>,
  emit: (text: string) => void
): (name?: unknown) => Promise<unknown> {
  return async (name?: unknown) => {
    const result =
      name !== undefined && typeof name !== "string"
        ? invalidHelpArgumentResponse(name)
        : await describe(name);
    emit(JSON.stringify(result, null, 2) ?? String(result));
    return result;
  };
}

/** Resolve one named help request without confusing a qualified service method with a service name. */
export async function describeEvalHelpName(
  serviceName: string,
  deps: {
    bindings: Record<string, unknown>;
    runtimeModuleName: string;
    describeBinding: (name: string, binding: Record<string, unknown>) => Promise<unknown | null>;
    docs: {
      describe: (id: string) => Promise<unknown | null>;
      describeService: (name: string) => Promise<unknown | null>;
    };
  }
): Promise<unknown> {
  const dot = serviceName.indexOf(".");
  if (dot > 0) {
    const bindingName = serviceName.slice(0, dot);
    const methodName = serviceName.slice(dot + 1);
    const binding = deps.bindings[bindingName];
    if (binding && typeof binding === "object") {
      const described = await deps.describeBinding(bindingName, binding as Record<string, unknown>);
      if (described && typeof described === "object") {
        const surface = described as { methods?: Record<string, unknown> };
        if (surface.methods?.[methodName]) {
          return describeEvalMethod(serviceName, surface.methods[methodName]);
        }
        const prefix = `${methodName}.`;
        const nestedMethods = Object.fromEntries(
          Object.entries(surface.methods ?? {})
            .filter(([name]) => name.startsWith(prefix))
            .map(([name, method]) => [name.slice(prefix.length), method])
        );
        if (Object.keys(nestedMethods).length > 0) {
          return describeEvalBindingIndex({
            name: serviceName,
            surface: "injected-runtime",
            note: "Live methods in this injected runtime namespace.",
            methods: nestedMethods,
          });
        }
        return {
          name: serviceName,
          surface: "injected-runtime-method",
          error: `Unknown method ${methodName} on ${bindingName}`,
          knownMethods: Object.keys(surface.methods ?? {}).sort(),
        };
      }
    }
    // A plain service has no injected namespace. Resolve its exact
    // method from the same canonical catalog used by docs_open.
    const method = await deps.docs.describe(`service:${serviceName}`);
    return method
      ? describeEvalMethod(`services.${serviceName}`, method)
      : unknownHelpNameResponse(serviceName);
  }
  // Prefer the INJECTED binding's surface (what eval actually calls) over the raw RPC
  // service — they can diverge (fs's low-level handle* wire methods are hidden behind
  // open()→FileHandle).
  const injected = deps.bindings[serviceName];
  if (injected !== undefined) {
    if (injected && typeof injected === "object") {
      const described = await deps.describeBinding(
        serviceName,
        injected as Record<string, unknown>
      );
      if (described && typeof described === "object") {
        return describeEvalBindingIndex(described as InjectedSurfaceDescription);
      }
    }
    // Runtime functions and opaque values carry canonical source signatures in
    // the runtime surface catalog. Preserve those here instead of reducing all
    // function exports to a generic docs link.
    const canonical = portableExports[serviceName];
    if (canonical?.kind === "callable") {
      const method = await deps.docs.describe(
        `service:${canonical.schemaRef}.${canonical.schemaMethod}`
      );
      if (method) {
        const described = describeEvalMethod(serviceName, method);
        return {
          ...described,
          surface: "injected-runtime-method",
          ...(canonical.description
            ? {
                description: [canonical.description, described.description]
                  .filter(Boolean)
                  .join(" "),
              }
            : {}),
          note: "Callable runtime export, described from its canonical service contract.",
        };
      }
    }
    return {
      name: serviceName,
      surface: "injected-runtime",
      kind: typeof injected,
      ...(canonical?.kind === "value" && canonical.signature
        ? { signature: canonical.signature }
        : {}),
      ...(canonical?.description ? { description: canonical.description } : {}),
      note:
        `\`${serviceName}\` is a top-level runtime export from \`${deps.runtimeModuleName}\` (a ` +
        `${typeof injected}) — call it directly, it is not an RPC service. ` +
        (canonical?.kind === "value" && canonical.signature
          ? `Its canonical signature is \`${canonical.signature}\`. `
          : "") +
        `See its signature ` +
        `in skills/sandbox/RUNTIME_API.md (panel APIs: skills/workspace-dev/PANEL_API.md). ` +
        `Use \`help('<name>')\` with a name from the \`services\` list for RPC services.`,
    };
  }
  // Not a rich runtime binding — a plain RPC service. It is reachable as
  // `services.${serviceName}.<method>(...)` (dynamic proxy) or, always, via
  // `rpc.call("main", mainRpcMethods["${serviceName}.<method>"], [...])`.
  return (await deps.docs.describeService(serviceName)) ?? unknownHelpNameResponse(serviceName);
}
