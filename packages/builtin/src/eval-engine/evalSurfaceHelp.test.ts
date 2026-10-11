import templatesRuntimeCatalog from "../../../service-schemas/src/runtime/generated/templatesRuntimeCatalog.json";
import gitRuntimeCatalog from "../../../service-schemas/src/runtime/generated/gitRuntimeCatalog.json";
import {
  PANEL_TREE_METHOD_CATALOG,
  portableExports,
} from "@vibestudio/service-schemas/runtime/runtimeSurface.portable";
import { describe, expect, it, vi } from "vitest";
import {
  describeEvalBindingSurface,
  describeEvalHelpName,
  evalBindingMethodNames,
  describeEvalBindingIndex,
  describeEvalMethod,
  createEvalHelp,
  EVAL_RUNTIME_METHOD_NOTES,
  evalRuntimeServiceName,
  invalidHelpArgumentResponse,
  unknownHelpNameResponse,
} from "./evalSurfaceHelp.js";

describe("unknownHelpNameResponse", () => {
  it("distinguishes package exports from unavailable runtime bindings", () => {
    const response = unknownHelpNameResponse("some-skill");
    expect(response.name).toBe("some-skill");
    expect(response.error).toContain("runtime binding");
    expect(response.guidance).toContain("not exports of other packages");
    expect(response.guidance).toContain("read its SKILL.md/API reference");
  });
});

describe("describeEvalBindingSurface (help('<binding>') reflects the injected surface)", () => {
  it("describes template authoring arguments from its canonical receiver schema", () => {
    const method = describeEvalMethod(
      "templates.inspectAuthoring",
      templatesRuntimeCatalog.inspectAuthoring
    );
    expect(method.call).toBe("await templates.inspectAuthoring(input)");
    expect(method.parameters).toHaveLength(1);
    expect(method.parameters![0]!.type).toContain("parts");
    expect(method.parameters![0]!.type).toContain("string");
    expect(method.returns).toContain("fingerprint");
  });

  // The fs case: the injected client exposes open()/readFile()/mktemp() but NOT the low-level
  // handle* wire methods, which the raw service schema DOES advertise.
  const fsService = {
    open: { description: "wire open → { handleId }", argsSchema: {} },
    readFile: { description: "read a file", argsSchema: {} },
    handleClose: { description: "low-level handle close", argsSchema: {} },
    handleStat: { description: "low-level handle stat", argsSchema: {} },
  };

  it("drops wire methods the injected object doesn't expose (no fs.handleClose leak)", () => {
    const out = describeEvalBindingSurface("fs", ["open", "readFile", "mktemp"], fsService);
    expect(out).not.toBeNull();
    expect(Object.keys(out!.methods).sort()).toEqual(["mktemp", "open", "readFile"]);
    expect(out!.methods).not.toHaveProperty("handleClose");
    expect(out!.methods).not.toHaveProperty("handleStat");
  });

  it("a known ergonomic note WINS over the raw wire schema (fs.open → FileHandle, not {handleId})", () => {
    const out = describeEvalBindingSurface("fs", ["open"], fsService);
    expect(out!.methods["open"]).toBe(EVAL_RUNTIME_METHOD_NOTES["fs.open"]);
    expect((out!.methods["open"] as { description: string }).description).toContain("FileHandle");
    expect((out!.methods["open"] as { description: string }).description).not.toContain("handleId");
  });

  it("reuses the RPC-service schema for methods with no override (rich arg info preserved)", () => {
    const out = describeEvalBindingSurface("fs", ["readFile"], fsService);
    expect(out!.methods["readFile"]).toBe(fsService.readFile);
  });

  it("maps ergonomic Git help to the canonical gitInterop service contract", () => {
    const importSchema = {
      description: "Import an external Git project.",
      argsSchema: { type: "array", items: [{ type: "object" }] },
    };
    const out = describeEvalBindingSurface(
      "git",
      ["importProject"],
      { importProject: importSchema },
      EVAL_RUNTIME_METHOD_NOTES,
      evalRuntimeServiceName("git")
    );

    expect(evalRuntimeServiceName("git")).toBe("gitInterop");
    expect(evalRuntimeServiceName("vcs")).toBe("vcs");
    expect(out!.methods["importProject"]).toBe(gitRuntimeCatalog.importProject);
    expect(out!.note).toContain('rpc.call("main", mainRpcMethods["gitInterop.<method>"]');
  });

  it("documents the runtime-only blobstore byte helpers without inventing wire methods", () => {
    const putBase64Schema = { description: "wire base64 method", argsSchema: {} };
    const out = describeEvalBindingSurface("blobstore", ["putBase64", "putBytes", "getBytes"], {
      putBase64: putBase64Schema,
    });

    expect(out!.methods["putBase64"]).toBe(putBase64Schema);
    expect(out!.methods["putBytes"]).toBe(EVAL_RUNTIME_METHOD_NOTES["blobstore.putBytes"]);
    const description = (out!.methods["putBytes"] as { description: string }).description;
    expect(description).toContain("Uint8Array | ArrayBuffer");
    expect(description).toContain("MIME metadata");
    expect(out!.methods["getBytes"]).toBe(EVAL_RUNTIME_METHOD_NOTES["blobstore.getBytes"]);
    expect((out!.methods["getBytes"] as { description: string }).description).toContain(
      "Uint8Array | null"
    );
  });

  it("uses the canonical semantic VCS schema and documents the runtime commit wrapper", () => {
    const historySchema = {
      description: "history({ root, limit?, cursor? }) → a focused chronological projection",
      argsSchema: {},
    };
    const result = describeEvalBindingSurface("vcs", ["history", "commit"], {
      history: historySchema,
    });
    expect(result?.methods["history"]).toBe(historySchema);
    expect(result?.methods["commit"]).toMatchObject({
      description: expect.stringContaining("complete local application chain"),
    });
  });

  it("describes mktemp as a temp FILE path (not a directory) so it isn't misused", () => {
    const out = describeEvalBindingSurface("fs", ["mktemp"], fsService);
    const desc = (out!.methods["mktemp"] as { description: string }).description;
    expect(desc).toContain("NOT created");
    expect(desc).toMatch(/mkdir|NOT Node's mkdtemp/);
  });

  it("describes the composed temp-directory helper separately", () => {
    const out = describeEvalBindingSurface("fs", ["mkdtemp"], fsService);
    const desc = (out!.methods["mkdtemp"] as { description: string }).description;
    expect(desc).toContain("temp DIRECTORY");
    expect(desc).toContain("creates");
  });

  it("documents the worker launch/retire path via runtime.createEntity/retireEntity", () => {
    const out = describeEvalBindingSurface("runtime", ["createEntity", "retireEntity"], {});

    const createDesc = (out!.methods["createEntity"] as { description: string }).description;
    expect(createDesc).toContain('kind: "worker"');
    expect(createDesc).toContain("ctx:${ctx.contextId}");
    expect(createDesc).toContain("workers.listSources()");
    expect(createDesc).toContain("real manifest entry points");
    expect(createDesc).toContain("not that worker code observed");
    expect(createDesc).toContain("implemented by the worker under test");
    expect(createDesc).toContain("immutable instance identity");
    expect(createDesc).toContain("fresh key after each code change");
    expect(createDesc).toContain('rpc.call("main", mainRpcMethods["workers.listSources"], [])');
    expect(createDesc).toContain("@vibestudio/service-schemas/mainRpc");
    expect(createDesc).toContain('mainRpcMethods["runtime.createEntity"]');
    const retireDesc = (out!.methods["retireEntity"] as { description: string }).description;
    expect(retireDesc).toContain("runtime.retireEntity");
    expect(retireDesc).toContain("runtime.listEntities");
  });

  it("emits each help result while preserving each structured return value", async () => {
    const descriptions = new Map([
      ["rpc", { name: "rpc", methods: ["call"] }],
      ["workers.createDurableObject", { name: "workers.createDurableObject", args: ["source"] }],
    ]);
    const emitted: string[] = [];
    const help = createEvalHelp(
      async (name) => descriptions.get(name ?? "rpc"),
      (text) => emitted.push(text)
    );

    const first = await help("rpc");
    const second = await help("workers.createDurableObject");

    expect(first).toBe(descriptions.get("rpc"));
    expect(second).toBe(descriptions.get("workers.createDurableObject"));
    expect(emitted).toEqual([
      JSON.stringify(descriptions.get("rpc"), null, 2),
      JSON.stringify(descriptions.get("workers.createDurableObject"), null, 2),
    ]);
  });

  it("documents immutable worker keys and awaited cleanup on the ergonomic surface", () => {
    const out = describeEvalBindingSurface("workers", ["create", "destroy"], {});
    const createDesc = (out!.methods["create"] as { description: string }).description;
    expect(createDesc).toContain("immutable instance identity");
    expect(createDesc).toContain("fresh key");
    expect(createDesc).toContain("handle.targetId");
    expect(createDesc).toContain("finally");
    const destroyDesc = (out!.methods["destroy"] as { description: string }).description;
    expect(destroyDesc).toContain("Await");
    expect(destroyDesc).toContain("stable key");
  });

  it("falls back to a generic introspect note for a live method with no schema or override", () => {
    const out = describeEvalBindingSurface("widget", ["frobnicate"], {});
    expect((out!.methods["frobnicate"] as { description: string }).description).toContain(
      "introspect the return value"
    );
  });

  it("sorts methods and tags the surface as injected-runtime", () => {
    const out = describeEvalBindingSurface("fs", ["readFile", "open", "mktemp"], fsService);
    expect(Object.keys(out!.methods)).toEqual(["mktemp", "open", "readFile"]);
    expect(out!.surface).toBe("injected-runtime");
    expect(out!.note).toContain('rpc.call("main", mainRpcMethods["fs.<method>"]');
    expect(out!.note).toContain("`services.fs`");
  });

  it("returns null when there are no live methods (caller falls back to the service schema)", () => {
    expect(describeEvalBindingSurface("vcs", [], { applyEdits: {} })).toBeNull();
  });

  it("keeps binding discovery compact and points to exact per-method help", () => {
    const detailed = describeEvalBindingSurface("vcs", ["status", "edit"], {
      status: {
        description: "Read the current frontier.",
        argsSchema: { deliberately: "large" },
      },
      edit: {
        description: "Author an exact semantic edit.",
        argsSchema: { deliberately: "large" },
      },
    })!;
    expect(describeEvalBindingIndex(detailed)).toEqual({
      name: "vcs",
      surface: "injected-runtime-index",
      description: portableExports["vcs"]?.description,
      note: detailed.note,
      methods: [
        { name: "edit", description: "Author an exact semantic edit." },
        { name: "status", description: "Read the current frontier." },
      ],
      next: 'Call help("vcs.<method>") for that method\'s exact arguments, return schema, and typed errors.',
    });
  });

  it("preserves the canonical rpc binding contract in its live index", () => {
    const described = describeEvalBindingSurface("rpc", ["call"], {})!;
    const index = describeEvalBindingIndex(described);

    expect(index.description).toBe(portableExports["rpc"]?.description);
    expect(index.description).toContain("method argument is never a method-name string");
    expect(index.methods.map(({ name }) => name)).toEqual(["call"]);
  });
});

describe("describeEvalMethod", () => {
  it("preserves numeric argument validation in compact help", () => {
    const method = describeEvalMethod("inventory.list", {
      argsSchema: {
        type: "array",
        items: [
          {
            type: "object",
            properties: {
              limit: { type: "integer", minimum: 1, maximum: 50 },
              ratio: { type: "number", minimum: 10, exclusiveMinimum: 2 },
            },
          },
        ],
      },
    });
    expect(method.parameters?.[0]?.type).toContain("limit?: integer (>= 1, <= 50)");
    expect(method.parameters?.[0]?.type).toContain("ratio?: number (>= 10, > 2)");
  });
  it("distinguishes closed object schemas from open dictionary schemas", () => {
    const closed = describeEvalMethod("svc.closed", {
      argsSchema: {
        type: "array",
        items: [
          {
            type: "object",
            properties: { known: { type: "string" } },
            additionalProperties: false,
          },
        ],
      },
    });
    expect(closed.parameters?.[0]?.type).toBe("{ known?: string }");

    const unknownDictionary = describeEvalMethod("svc.dictionary", {
      argsSchema: {
        type: "array",
        items: [{ type: "object", additionalProperties: true }],
      },
    });
    expect(unknownDictionary.parameters?.[0]?.type).toBe("Record<string, unknown>");

    const stringDictionary = describeEvalMethod("svc.environment", {
      argsSchema: {
        type: "array",
        items: [{ type: "object", additionalProperties: { type: "string" } }],
      },
    });
    expect(stringDictionary.parameters?.[0]?.type).toBe("Record<string, string>");
  });
  it("renders the real Git positional overloads without turning the argument list into an argument", () => {
    const method = describeEvalMethod("git.upstreamStatus", gitRuntimeCatalog.upstreamStatus);
    expect(method.call).toBe("await git.upstreamStatus()");
    expect(method.parameters).toEqual([]);
    expect(method.overloads).toEqual([
      "git.upstreamStatus()",
      "git.upstreamStatus((string)[])",
      "git.upstreamStatus((string)[], { remote?: string; branch?: string; credentialIdOverride?: string | null })",
    ]);
    expect(method.examples?.map((example) => example.call)).toEqual([
      "await git.upstreamStatus()",
      'await git.upstreamStatus(["projects/bgkit"])',
    ]);
  });
  it("renders nested discriminated unions completely without returning a deep raw schema", () => {
    const result = describeEvalMethod("vcs.edit", {
      description: "Author exact edits.",
      access: { sensitivity: "write" },
      authority: { kind: "every-origin" },
      errors: [{ code: "RevisionChanged", description: "The basis advanced." }],
      seeAlso: ["vcs.revert"],
      argsSchema: {
        type: "array",
        items: [
          {
            type: "object",
            properties: {
              commandId: { type: "string" },
              changes: {
                type: "array",
                items: {
                  anyOf: [
                    {
                      type: "object",
                      properties: {
                        kind: { type: "string", enum: ["text-edit"] },
                        edits: {
                          type: "array",
                          items: {
                            type: "object",
                            properties: {
                              start: { type: "integer" },
                              end: { type: "integer" },
                              text: { type: "string" },
                            },
                            required: ["start", "end", "text"],
                          },
                        },
                      },
                      required: ["kind", "edits"],
                    },
                    {
                      type: "object",
                      properties: {
                        kind: { type: "string", enum: ["file-delete"] },
                        fileId: { type: "string" },
                      },
                      required: ["kind", "fileId"],
                    },
                  ],
                },
              },
            },
            required: ["commandId", "changes"],
          },
        ],
      },
      returnsSchema: {
        type: "object",
        properties: { applicationId: { type: "string" } },
        required: ["applicationId"],
      },
    });

    expect(result).toEqual({
      name: "vcs.edit",
      surface: "injected-runtime-method",
      description: "Author exact edits.",
      call: "await vcs.edit(input)",
      parameters: [
        {
          name: "input",
          type: '{ commandId: string; changes: ({ kind: "text-edit"; edits: ({ start: integer; end: integer; text: string })[] } | { kind: "file-delete"; fileId: string })[] }',
        },
      ],
      returns: "{ applicationId: string }",
      access: { sensitivity: "write" },
      authority: { kind: "every-origin" },
      errors: [{ code: "RevisionChanged", description: "The basis advanced." }],
      seeAlso: ["vcs.revert"],
      note: "Compact exact types for the injected call. Use the docs service only when machine-readable JSON Schema is needed.",
    });
    expect(JSON.stringify(result)).not.toContain("Max depth exceeded");
    expect(result).not.toHaveProperty("argsSchema");
    expect(result).not.toHaveProperty("returnsSchema");
  });

  it("names parameters from argumentNames and renders examples as exact executable calls", () => {
    const result = describeEvalMethod("docs.search", {
      description: "Search the capability catalog.",
      argumentNames: ["query", "options"],
      examples: [
        { args: ["store a blob and get a digest", { limit: 5 }] },
        { args: ["panel tree"], note: "Options may be omitted." },
      ],
      argsSchema: {
        type: "array",
        items: [{ type: "string" }, { type: "object", properties: { limit: { type: "integer" } } }],
      },
    });

    expect(result.call).toBe("await docs.search(query, options)");
    expect(result.parameters).toEqual([
      { name: "query", type: "string" },
      { name: "options", type: "{ limit?: integer }" },
    ]);
    expect(result.examples).toEqual([
      { call: 'await docs.search("store a blob and get a digest", {"limit":5})' },
      { call: 'await docs.search("panel tree")', note: "Options may be omitted." },
    ]);
  });

  it("keeps the input/arg fallback and omits examples when the schema declares neither", () => {
    const twoArgs = describeEvalMethod("svc.op", {
      argsSchema: { type: "array", items: [{ type: "string" }, { type: "number" }] },
    });
    expect(twoArgs.call).toBe("await svc.op(arg0, arg1)");
    expect(twoArgs.parameters!.map((parameter) => parameter.name)).toEqual(["arg0", "arg1"]);
    expect(twoArgs).not.toHaveProperty("examples");
  });

  it("bounds rendered examples after skipping malformed entries", () => {
    const result = describeEvalMethod("svc.op", {
      argsSchema: { type: "array", items: [{ type: "string" }] },
      examples: [
        { args: ["a"] },
        { note: "malformed, no args" },
        { args: ["b"] },
        { args: ["c"] },
        { args: ["dropped by the bound"] },
      ],
    });
    expect(result.examples).toEqual([
      { call: 'await svc.op("a")' },
      { call: 'await svc.op("b")' },
      { call: 'await svc.op("c")' },
    ]);
  });

  it("never shifts malformed argument-name metadata onto a later position", () => {
    const result = describeEvalMethod("svc.op", {
      argsSchema: {
        type: "array",
        items: [{ type: "string" }, { type: "number" }, { type: "boolean" }],
      },
      argumentNames: ["query", null, "enabled"],
    });
    expect(result.call).toBe("await svc.op(query, arg1, enabled)");
    expect(result.parameters!.map((parameter) => parameter.name)).toEqual([
      "query",
      "arg1",
      "enabled",
    ]);
  });

  it("omits a non-JSON example without failing live help", () => {
    const result = describeEvalMethod("svc.op", {
      argsSchema: { type: "array", items: [{ type: "unknown" }] },
      examples: [{ args: [1n] }, { args: ["usable"] }],
    });
    expect(result.examples).toEqual([{ call: 'await svc.op("usable")' }]);
  });
});

describe("invalidHelpArgumentResponse", () => {
  it("turns help(workers) into a useful non-throwing diagnostic", () => {
    expect(
      invalidHelpArgumentResponse({ create: () => undefined, destroy: () => undefined })
    ).toEqual({
      error: "help() expects a string service or runtime binding name.",
      received: "create, destroy",
      example: 'await help("workers")',
      note:
        "Pass the binding name as a string. For a live object's enumerable methods, " +
        "Object.keys(workers) also works.",
    });
  });
});

describe("runtime methods without argument schemas", () => {
  it("does not invent a zero-argument invocation from missing metadata", () => {
    const described = describeEvalMethod("browserData.openTabsAsPanels", {
      signature:
        "browserData.openTabsAsPanels(request: OpenTabsAsPanelsRequest): Promise<OpenTabsAsPanelsResult>",
    });
    expect(described).not.toHaveProperty("call");
    expect(described).not.toHaveProperty("parameters");
    expect(described.signature).toContain("request: OpenTabsAsPanelsRequest");
    expect(described.note).toContain("missing metadata");
  });
  it("retains a genuinely zero-argument schema", () => {
    expect(
      describeEvalMethod("service.list", { argsSchema: { type: "array", items: [] } })
    ).toMatchObject({
      call: "await service.list()",
      parameters: [],
    });
  });
});

describe("canonical injected runtime help", () => {
  it("preserves canonical signatures and descriptions for top-level runtime functions", async () => {
    const d = {
      bindings: { openPanel: async () => ({ id: "panel-1" }) },
      runtimeModuleName: "@workspace/runtime",
      describeBinding: vi.fn(async () => null as unknown),
      docs: {
        describe: vi.fn(async () => null as unknown),
        describeService: vi.fn(async () => null as unknown),
      },
    };
    const canonical = portableExports["openPanel"];
    const help = (await describeEvalHelpName("openPanel", d)) as Record<string, unknown>;
    expect(canonical?.kind).toBe("value");
    if (canonical?.kind !== "value") throw new Error("openPanel must have a value contract");
    expect(help).toMatchObject({
      name: "openPanel",
      surface: "injected-runtime",
      kind: "function",
      signature: canonical.signature,
      description: canonical.description,
    });
  });

  it("projects declared option fields from canonical runtime method metadata", () => {
    const navigate = describeEvalMethod("panelTree.navigate", PANEL_TREE_METHOD_CATALOG.navigate);
    expect(navigate.parameters?.[2]?.type).toContain("contextId?: string");
    expect(navigate.parameters?.[2]?.type).toContain("env?: Record<string, string>");
    expect(navigate.parameters?.[2]?.type).toContain("stateArgs?: Record<string, unknown>");
    expect(navigate.parameters?.[2]?.type).toContain("signal?: object");

    const history = describeEvalMethod(
      "panelTree.navigateHistory",
      PANEL_TREE_METHOD_CATALOG.navigateHistory
    );
    expect(history.parameters?.[2]?.type).toContain("signal?: object");
  });

  it("describes webhook helpers from their public client rather than wire-object arguments", () => {
    const surface = describeEvalBindingSurface(
      "webhooks",
      ["rotateSecret", "revokeSubscription", "createSubscription"],
      {
        rotateSecret: {
          argsSchema: {
            type: "array",
            items: [{ type: "object", properties: { subscriptionId: { type: "string" } } }],
          },
        },
      }
    )!;
    const rotate = describeEvalMethod("webhooks.rotateSecret", surface.methods["rotateSecret"]);
    expect(rotate.signature).toContain("rotateSecret(subscriptionId: string, secret?: string)");
    expect(rotate.description).toContain("subscription: WebhookIngressSubscriptionSummary");
    expect(rotate).not.toHaveProperty("parameters");
    const revoke = describeEvalMethod(
      "webhooks.revokeSubscription",
      surface.methods["revokeSubscription"]
    );
    expect(revoke.signature).toContain("revokeSubscription(subscriptionId: string)");
    const create = describeEvalMethod(
      "webhooks.createSubscription",
      surface.methods["createSubscription"]
    );
    expect(create.description).toContain("target: WebhookTarget");
    expect(create.description).toContain("(await agent.describe()).identity");
    expect(create.access).toMatchObject({ capability: "webhooks.manage", sensitivity: "write" });
  });

  it("retains owned DO creation and shared-resolution contracts despite a nonempty raw workers catalog", () => {
    const surface = describeEvalBindingSurface(
      "workers",
      ["createDurableObject", "resolveDurableObject", "destroy"],
      {
        resolveDurableObject: { description: "Raw relay resolver" },
        destroy: { description: "Raw deletion" },
      }
    )!;
    const create = describeEvalMethod(
      "workers.createDurableObject",
      surface.methods["createDurableObject"]
    );
    expect(create.signature).toContain("DurableObjectEntityHandle");
    expect(create.description).toContain("owned by the caller");
    expect(create.parameters).toHaveLength(3);
    expect(create.parameters![2]!.type).toContain("stateArgs");
    const resolve = describeEvalMethod(
      "workers.resolveDurableObject",
      surface.methods["resolveDurableObject"]
    );
    expect(resolve.description).toContain("never lifecycle ownership");
    expect(resolve.parameters).toHaveLength(3);
    const destroy = describeEvalMethod("workers.destroy", surface.methods["destroy"]);
    expect(destroy.description).toContain(
      "Resolving an object or service does not transfer lifecycle ownership"
    );
    expect(destroy.description).toContain("finally");
  });
});

describe("named live help lookup", () => {
  it("discovers grouped live methods and resolves their namespace and exact contract", async () => {
    const binding = { createEntity() {}, supervision: { logs() {}, health() {} } };
    expect(evalBindingMethodNames(binding)).toEqual([
      "createEntity",
      "supervision.health",
      "supervision.logs",
    ]);
    const d = deps();
    d.bindings["runtime"] = binding;
    d.describeBinding.mockResolvedValue({
      methods: {
        createEntity: {},
        "supervision.logs": {
          description: "Exact incarnation logs",
          argsSchema: { type: "array", items: [{ type: "string" }] },
        },
        "supervision.health": { description: "Exact incarnation health" },
      },
    });
    expect(await describeEvalHelpName("runtime.supervision", d)).toMatchObject({
      name: "runtime.supervision",
      methods: [
        { name: "logs", description: "Exact incarnation logs" },
        { name: "health", description: "Exact incarnation health" },
      ],
    });
    expect(await describeEvalHelpName("runtime.supervision.logs", d)).toMatchObject({
      name: "runtime.supervision.logs",
      call: "await runtime.supervision.logs(input)",
      parameters: [{ name: "input", type: "string" }],
    });
    expect(d.docs.describe).not.toHaveBeenCalled();
  });
  function deps() {
    return {
      bindings: {} as Record<string, unknown>,
      runtimeModuleName: "@workspace/runtime",
      describeBinding: vi.fn(async () => null as unknown),
      docs: {
        describe: vi.fn(async () => null as unknown),
        describeService: vi.fn(async () => null as unknown),
      },
    };
  }
  it("resolves qualified plain service methods through their exact canonical catalog entry", async () => {
    const d = deps();
    const entry = {
      id: "service:authority.preflight",
      qualifiedName: "authority.preflight",
      parent: "service:authority",
      argsSchema: {
        type: "array",
        items: [
          {
            type: "object",
            properties: {
              service: { type: "string" },
              method: { type: "string" },
              args: { type: "array", items: {} },
            },
            required: ["service", "method", "args"],
          },
        ],
      },
    };
    d.docs.describe.mockResolvedValue(entry);
    expect(await describeEvalHelpName("authority.preflight", d)).toMatchObject({
      name: "services.authority.preflight",
      call: "await services.authority.preflight(input)",
      parameters: [
        { name: "input", type: "{ service: string; method: string; args: (unknown)[] }" },
      ],
    });
    expect(d.docs.describe).toHaveBeenCalledWith("service:authority.preflight");
    expect(d.docs.describeService).not.toHaveBeenCalled();
  });
  it("keeps hidden raw methods out of an injected ergonomic binding", async () => {
    const d = deps();
    d.bindings["fs"] = { open() {} };
    d.describeBinding.mockResolvedValue({ methods: { open: { description: "FileHandle" } } });
    expect(await describeEvalHelpName("fs.handleClose", d)).toMatchObject({
      error: "Unknown method handleClose on fs",
      knownMethods: ["open"],
    });
    expect(d.docs.describe).not.toHaveBeenCalled();
  });
  it("preserves normal service indexes and truthful unknown methods", async () => {
    const d = deps();
    const service = { name: "authority", methods: { preflight: {} } };
    d.docs.describeService.mockResolvedValue(service);
    expect(await describeEvalHelpName("authority", d)).toBe(service);
    expect(await describeEvalHelpName("authority.invented", d)).toMatchObject({
      name: "authority.invented",
      error: expect.stringContaining("No injected"),
    });
  });
});
