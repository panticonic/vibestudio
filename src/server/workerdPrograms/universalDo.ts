import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { serializeRpcFailure } from "@vibestudio/rpc";
import {
  DO_EXECUTABLE_VERSION_HEADER,
  DO_INCARNATION_VERSION_HEADER,
  type DoExecutableAdmission,
  type HostedCodeAdmission,
  type HostedCodeGrants,
} from "./executableVersion.js";
import {
  classSecretName,
  gatewayFetch,
  loadedNetworkPolicy,
  UNIVERSAL_DO_LOADER_SECRET,
  type CelldFacetOptions,
  type CelldWorkerCode,
  type HostProgramEnv,
} from "./celldRuntime.js";

interface UniversalDoEnv extends HostProgramEnv {
  LOADER: WorkerLoader;
  UNIVERSAL_DO: DurableObjectNamespace;
  /** UniversalDO's own loader and lifecycle secret (a class secret). */
  readonly DO_LOADER_SECRET__UniversalDO: string;
}

const LOADER_SECRET_BINDING = classSecretName(UNIVERSAL_DO_LOADER_SECRET, "UniversalDO");

/** The class's secret; `ExecutablePreparation` (an entrypoint, not the class)
 * has none and never fetches code itself. */
function loaderSecret(env: HostProgramEnv): string {
  const secret = (env as unknown as Record<string, unknown>)[LOADER_SECRET_BINDING];
  if (typeof secret !== "string")
    throw new Error("UniversalDO loader secret is not available to this caller");
  return secret;
}

interface DurableObjectCodePayload extends WorkerLoaderWorkerCode {
  version: string;
  egressIdentity: string | null;
}

interface LoadedFacetClass {
  executableVersion: string;
  incarnationVersion: string;
  class: DurableObjectClass;
}

async function fetchLoader(
  env: HostProgramEnv,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  try {
    return await gatewayFetch(env, path, {
      ...init,
      headers: { "X-Vibestudio-Loader-Secret": loaderSecret(env) },
    });
  } catch (error) {
    console.error(
      "Durable Object loader request failed",
      path,
      error instanceof Error ? (error.stack ?? error.message) : error
    );
    throw error;
  }
}

function decodeKey(encoded: string): { source: string; className: string; userKey: string } {
  const parts = encoded.split("|");
  return {
    source: decodeURIComponent(parts[0] ?? ""),
    className: decodeURIComponent(parts[1] ?? ""),
    userKey: decodeURIComponent(parts[2] ?? ""),
  };
}

function executableUnitKey(
  source: string,
  className: string,
  version: string,
  hosted?: HostedCodeGrants
): string {
  const base = `do-code:${encodeURIComponent(source)}:${encodeURIComponent(className)}:${encodeURIComponent(version)}`;
  // A hosted class's grants are part of its unit: the same code loaded with
  // another grant is another isolate, never a reuse of this one.
  return hosted ? `${base}:hosted:${encodeURIComponent(JSON.stringify(hosted))}` : base;
}

function loadExecutable(
  env: UniversalDoEnv,
  ctx: DurableObjectState,
  args: {
    source: string;
    className: string;
    version: string;
    userKey?: string;
    /** Set when the class is hosted by another entity: its grants, and no code-host binding. */
    hosted?: HostedCodeGrants;
  }
): WorkerStub {
  // The loader owns one immutable executable unit per code and authority snapshot.
  // Objects still own separate facets, SQLite storage, and lifecycle; a live
  // update selects another unit without replacing a sibling's assigned code.
  const unitKey = executableUnitKey(args.source, args.className, args.version, args.hosted);
  return env.LOADER.get(unitKey, async (): Promise<CelldWorkerCode> => {
    const startedAt = performance.now();
    const identity = `${args.source}:${args.className}`;
    const codeResponse = await fetchLoader(
      env,
      `/_docode/${encodeURIComponent(args.source)}/${encodeURIComponent(args.className)}` +
        `?version=${encodeURIComponent(args.version)}` +
        (args.userKey ? `&objectKey=${encodeURIComponent(args.userKey)}` : "")
    );
    if (!codeResponse.ok) {
      throw new Error(
        `universal-do: code fetch failed for ${identity}/${args.userKey}@${args.version} ` +
          `(${codeResponse.status})`
      );
    }
    const fetchedAt = performance.now();
    const code = (await codeResponse.json()) as DurableObjectCodePayload;
    if (code.version !== args.version) {
      throw new Error(
        `universal-do: executable changed before loading ${identity}/${args.userKey}`
      );
    }
    console.info(
      "Durable Object executable loaded",
      JSON.stringify({
        source: args.source,
        className: args.className,
        objectKey: args.userKey,
        version: args.version,
        fetchMs: fetchedAt - startedAt,
        decodeMs: performance.now() - fetchedAt,
      })
    );
    const network = loadedNetworkPolicy(code.egressIdentity);
    return {
      compatibilityDate: code.compatibilityDate,
      compatibilityFlags: code.compatibilityFlags,
      mainModule: code.mainModule,
      modules: code.modules,
      // An entity's code reaches its own root through `CODE_HOST`; the binding
      // names no entity (the proof in the facet's props does), so one unit
      // serves every object of the class. Hosted code hosts nothing itself.
      env: args.hosted
        ? code.env
        : {
            ...code.env,
            CODE_HOST: (
              ctx as unknown as { exports: { CodeHost(options: object): Fetcher } }
            ).exports.CodeHost({ props: {} }),
          },
      ...(args.hosted
        ? {
            ...network,
            celld: {
              ...(network.celld ?? {}),
              ...(args.hosted.codegen ? { codegen: true } : {}),
              ...(args.hosted.residency ? { residency: true } : {}),
            },
            ...(args.hosted.cpuMs !== null ? { limits: { cpuMs: args.hosted.cpuMs } } : {}),
          }
        : network),
    };
  });
}

/** A per-call limit is a positive integer of the keys celld knows; anything else is refused at the call. */
function callLimits(limits: CodeHostInput["limits"]): CodeHostInput["limits"] | undefined {
  if (!limits) return undefined;
  const out: { cpuMs?: number; subRequests?: number } = {};
  for (const key of ["cpuMs", "subRequests"] as const) {
    const value = limits[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error(`code host: limits.${key} must be a positive integer`);
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Marks a call from `CodeHost`; the router strips `x-internal-*`, so no outside caller can set it. */
const CODE_HOST_HEADER = "x-internal-vibestudio-codehost";
const CODE_HOST_KEY = "__codehost";
const CODE_HOST_NAME_PATTERN = /^[A-Za-z0-9:_.-]{1,128}$/;

function base64Url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function codeHostKey(env: HostProgramEnv, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.RUNTIME_LOADER_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage]
  );
}

/** Proof that a request to `CodeHost` comes from the code of the named root. */
async function codeHostProof(env: HostProgramEnv, name: string): Promise<string> {
  const mac = await crypto.subtle.sign(
    "HMAC",
    await codeHostKey(env, "sign"),
    new TextEncoder().encode(`code-host:${name}`)
  );
  return base64Url(mac);
}

async function verifyCodeHostProof(
  env: HostProgramEnv,
  name: string,
  proof: string
): Promise<boolean> {
  const expected = await codeHostProof(env, name);
  if (expected.length !== proof.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index++)
    difference |= expected.charCodeAt(index) ^ proof.charCodeAt(index);
  return difference === 0;
}

/**
 * The entity's way to host code in its own cell (docs/dolt-redesign.md §7.2).
 * The service binding names no entity: the request carries the root's name and
 * a proof only that root's code was given (in its facet's props), and the
 * entrypoint hands the request to that root, which asks the host what the
 * entity's manifest permits. A loaded worker's env can carry service bindings
 * only, so this is the one capability an entity holds; it cannot load code or
 * grant itself `codegen` or `residency`.
 */
export class CodeHost extends WorkerEntrypoint<UniversalDoEnv> {
  async fetch(request: Request): Promise<Response> {
    try {
      const name = request.headers.get("X-Code-Host-Name") ?? "";
      const proof = request.headers.get("X-Code-Host-Proof") ?? "";
      if (!name || !proof || !(await verifyCodeHostProof(this.env, name, proof)))
        return new Response("Forbidden", { status: 403 });
      const namespace = this.env.UNIVERSAL_DO;
      return await namespace.get(namespace.idFromName(name)).fetch(
        new Request(`http://universal-do/${CODE_HOST_KEY}`, {
          method: "POST",
          headers: { [CODE_HOST_HEADER]: "1" },
          body: await request.text(),
        })
      );
    } catch (error) {
      return Response.json({ error: serializeRpcFailure(error) }, { status: 500 });
    }
  }
}

interface CodeHostInput {
  op: "host" | "call" | "release";
  /** Names the hosted instance inside the calling entity. */
  name: string;
  executable: { source: string; className: string };
  method?: string;
  args?: unknown[];
  /** A CPU limit for this one call, lower-wins against the class's own (celld's per-call limit). */
  limits?: { cpuMs?: number; subRequests?: number };
}

interface HostedInstance {
  executable: { source: string; className: string };
  admission: HostedCodeAdmission;
  class: DurableObjectClass;
  facetName: string;
  hold: ResidencyHandleLike | null;
}

interface ResidencyHandleLike {
  release(): void;
  onrevoked: ((event: { reason: string }) => void | Promise<void>) | null;
}

interface PreparationInput {
  source: string;
  className: string;
  version: string;
}

/** Marks a call from the script's own entrypoint; the router strips `x-internal-*`. */
const PREPARATION_HEADER = "x-internal-vibestudio-prepare";
const PREPARATION_KEY = "__prepare";

/** Prepares the same immutable unit used by normal object dispatch, without
 * constructing a user object or invoking its application request handler. The
 * code fetch needs UniversalDO's class secret, so the entrypoint hands the
 * request to a UniversalDO cell of its own. */
export class ExecutablePreparation extends WorkerEntrypoint<UniversalDoEnv> {
  async fetch(request: Request): Promise<Response> {
    try {
      const input = (await request.json()) as PreparationInput;
      if (!input.source || !input.className || !input.version)
        throw new Error("Executable preparation requires a complete immutable identity");
      const namespace = this.env.UNIVERSAL_DO;
      const stub = namespace.get(
        namespace.idFromName(`${PREPARATION_KEY}:${input.source}:${input.className}`)
      );
      return await stub.fetch(
        new Request(`http://universal-do/${PREPARATION_KEY}`, {
          method: "POST",
          headers: { [PREPARATION_HEADER]: "1" },
          body: JSON.stringify(input),
        })
      );
    } catch (error) {
      return Response.json({ error: serializeRpcFailure(error) }, { status: 500 });
    }
  }
}

interface FacetSelection {
  executableVersion: string;
  incarnationVersion: string;
  controller: AbortController;
  promise: Promise<LoadedFacetClass>;
}

export class UniversalDO extends DurableObject<UniversalDoEnv> {
  private loadedFacet: LoadedFacetClass | null = null;
  private facetSelection: FacetSelection | null = null;
  /** Code this entity hosts in its own cell, by the entity's own name for it. */
  private readonly hosted = new Map<string, HostedInstance>();
  private hostedNames: Set<string> | null = null;

  private hostedFacetName(name: string): string {
    return `code:${name}`;
  }

  /** The names this cell has ever hosted, so retirement can reclaim every facet. */
  private knownHostedNames(): Set<string> {
    if (this.hostedNames) return this.hostedNames;
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS codehost_names (name TEXT PRIMARY KEY)");
    this.hostedNames = new Set(
      sql
        .exec("SELECT name FROM codehost_names")
        .toArray()
        .map((row) => String(row["name"]))
    );
    return this.hostedNames;
  }

  private rememberHostedName(name: string): void {
    const names = this.knownHostedNames();
    if (names.has(name)) return;
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO codehost_names(name) VALUES (?)", name);
    names.add(name);
  }

  private endHosted(name: string, reason: Error, options: { deleteStorage?: boolean } = {}): void {
    const instance = this.hosted.get(name);
    this.hosted.delete(name);
    instance?.hold?.release();
    if (options.deleteStorage) this.ctx.facets.delete(this.hostedFacetName(name));
    else if (instance) this.ctx.facets.abort(this.hostedFacetName(name), reason);
  }

  private endAllHosted(reason: Error, options: { deleteStorage?: boolean } = {}): void {
    for (const name of [...this.hosted.keys()]) this.endHosted(name, reason, options);
    if (options.deleteStorage)
      for (const name of this.knownHostedNames())
        this.ctx.facets.delete(this.hostedFacetName(name));
  }

  /**
   * Admit, load and start a class this entity hosts, take its residency hold,
   * and relay a revocation to it. The facet's own `onrevoked` does not run (it
   * is in another isolate), so the root registers the handler and calls the
   * hosted class's `__hosted/__revoked` to persist its state.
   */
  private async ensureHosted(input: CodeHostInput): Promise<HostedInstance> {
    const { name, executable } = input;
    if (!CODE_HOST_NAME_PATTERN.test(name)) throw new Error(`code host: bad name ${name}`);
    const rootName = this.ctx.id.name;
    if (!rootName) throw new Error("code host: this cell has no name");
    const response = await fetchLoader(
      this.env,
      `/_dohost/${encodeURIComponent(executable.source)}/${encodeURIComponent(executable.className)}` +
        `?host=${encodeURIComponent(rootName)}`
    );
    if (!response.ok) {
      const body = await response.text();
      throw Object.assign(new Error(`code host: ${body} (${response.status})`), {
        code: response.status === 403 ? "EACCES" : response.status === 404 ? "ENOTFOUND" : "EHOST",
      });
    }
    const admission = (await response.json()) as HostedCodeAdmission;
    const existing = this.hosted.get(name);
    if (
      existing &&
      existing.executable.source === executable.source &&
      existing.executable.className === executable.className &&
      existing.admission.executableVersion === admission.executableVersion &&
      JSON.stringify(existing.admission.grants) === JSON.stringify(admission.grants)
    ) {
      existing.admission = admission;
      return existing;
    }
    if (existing) this.endHosted(name, new Error("Hosted code replaced by another version"));
    const worker = loadExecutable(this.env, this.ctx, {
      source: executable.source,
      className: executable.className,
      version: admission.executableVersion,
      hosted: admission.grants,
    });
    const instance: HostedInstance = {
      executable,
      admission,
      class: worker.getDurableObjectClass(executable.className, { props: admission.props }),
      facetName: this.hostedFacetName(name),
      hold: null,
    };
    this.hosted.set(name, instance);
    this.rememberHostedName(name);
    const residency = (
      this.ctx as unknown as {
        residency?: { enabled: boolean; hold(): Promise<ResidencyHandleLike> };
      }
    ).residency;
    if (admission.grants.residency && residency?.enabled) {
      try {
        const hold = await residency.hold();
        hold.onrevoked = async ({ reason }) => {
          // Persist what must survive; the node takes the object away next.
          await this.hostedFacet(name, instance)
            .fetch(this.hostedRequest(name, "__revoked", { reason }))
            .catch((error: unknown) =>
              console.error("hosted code could not persist on revocation", name, error)
            );
        };
        instance.hold = hold;
      } catch (error) {
        // The node's budget refused it: the code runs without a hold and its
        // heap may be lost at eviction. The class reports that; it is not silent.
        console.warn(
          `code host: residency hold refused for ${name}`,
          error instanceof Error ? error.message : error
        );
      }
    }
    return instance;
  }

  /**
   * The stub of a hosted facet. `limits` is a limit for each call made through
   * the stub this returns (celld's third argument of `ctx.facets.get`: the lower
   * of it and the unit's `cpuMs` applies, and it covers work the call leaves
   * running under `waitUntil`). A run's `timeoutMs` bounds its CPU this way
   * without restarting the facet, which would lose the kernel's heap.
   */
  private hostedFacet(
    name: string,
    instance: HostedInstance,
    limits?: CodeHostInput["limits"]
  ): Fetcher {
    const facetOptions: CelldFacetOptions | null =
      instance.admission.grants.storage === "dolt"
        ? {
            storage: "dolt",
            ...(instance.admission.grants.doltLocal.length > 0
              ? { doltLocal: instance.admission.grants.doltLocal }
              : {}),
          }
        : null;
    return (
      this.ctx.facets as unknown as {
        get(
          name: string,
          init: () => { class: DurableObjectClass; celld?: CelldFacetOptions },
          options?: { limits: { cpuMs?: number; subRequests?: number } }
        ): Fetcher;
      }
    ).get(
      instance.facetName,
      () => ({
        class: instance.class,
        ...(facetOptions ? { celld: facetOptions } : {}),
      }),
      ...(limits ? [{ limits }] : [])
    );
  }

  private hostedRequest(name: string, method: string, body: unknown): Request {
    return new Request(
      `http://hosted/${encodeURIComponent(name)}/__hosted/${encodeURIComponent(method)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }
    );
  }

  private async codeHostOp(input: CodeHostInput): Promise<Response> {
    if (input.op === "release") {
      const instance = this.hosted.get(input.name);
      instance?.hold?.release();
      if (instance) instance.hold = null;
      return Response.json({ released: Boolean(instance) });
    }
    const instance =
      input.op === "host"
        ? await this.ensureHosted(input)
        : (this.hosted.get(input.name) ?? (await this.ensureHosted(input)));
    if (input.op === "host") return Response.json({ hosted: true });
    if (typeof input.method !== "string" || input.method.length === 0)
      throw new Error("code host: a call names a method");
    return this.hostedFacet(input.name, instance, callLimits(input.limits)).fetch(
      this.hostedRequest(input.name, input.method, { args: input.args ?? [] })
    );
  }

  private async cancelFacetSelection(reason: Error): Promise<void> {
    const selection = this.facetSelection;
    if (!selection) return;
    selection.controller.abort(reason);
    try {
      await selection.promise;
    } catch (error) {
      if (error !== reason) throw error;
    }
  }

  private loadFacetClass(args: {
    source: string;
    className: string;
    userKey: string;
    version: string;
    incarnationVersion: string;
  }): Promise<LoadedFacetClass> {
    if (
      this.loadedFacet?.incarnationVersion === args.incarnationVersion &&
      this.loadedFacet.executableVersion === args.version
    )
      return Promise.resolve(this.loadedFacet);
    const previous = this.facetSelection;
    if (
      previous?.incarnationVersion === args.incarnationVersion &&
      previous.executableVersion === args.version
    )
      return previous.promise;
    const advanced = new Error("Runtime image advanced during object admission");
    previous?.controller.abort(advanced);
    const controller = new AbortController();
    const execute = async (): Promise<LoadedFacetClass> => {
      try {
        // Join the prior selection before acquiring a replacement. Cancellation
        // retires its actual fetch; it cannot publish a late class or properties.
        if (previous) {
          try {
            await previous.promise;
          } catch (error) {
            if (error !== advanced) throw error;
          }
        } else {
          // Reserve the selection record before asynchronous loader work starts.
          await Promise.resolve();
        }
        controller.signal.throwIfAborted();
        const response = await fetchLoader(
          this.env,
          `/_doadmission/${encodeURIComponent(args.source)}/${encodeURIComponent(args.className)}` +
            `?objectKey=${encodeURIComponent(args.userKey)}` +
            `&executableVersion=${encodeURIComponent(args.version)}` +
            `&incarnationVersion=${encodeURIComponent(args.incarnationVersion)}`,
          { signal: controller.signal }
        );
        controller.signal.throwIfAborted();
        if (!response.ok)
          throw new Error(`universal-do: ${await response.text()} (${response.status})`);
        const admission = (await response.json()) as DoExecutableAdmission;
        controller.signal.throwIfAborted();
        if (
          admission.executableVersion !== args.version ||
          admission.incarnationVersion !== args.incarnationVersion
        )
          throw new Error("universal-do: object admission changed while loading");
        if (this.facetSelection !== selection)
          throw new Error("Runtime image advanced during object admission");
        if (this.loadedFacet) {
          this.ctx.facets.abort("do", new Error("Runtime image advanced"));
          this.loadedFacet = null;
        }
        const worker = loadExecutable(this.env, this.ctx, args);
        const rootName = this.ctx.id.name;
        this.loadedFacet = {
          executableVersion: args.version,
          incarnationVersion: args.incarnationVersion,
          class: worker.getDurableObjectClass(args.className, {
            props: {
              ...admission.props,
              // What lets this entity's code ask its own root to host code, and
              // no other root (`CodeHost` verifies it).
              codeHost: rootName
                ? { name: rootName, proof: await codeHostProof(this.env, rootName) }
                : null,
            },
          }),
        };
        return this.loadedFacet;
      } catch (error) {
        // The transport may reconstruct an abort exception across its boundary.
        // Once this owned selection is cancelled, its authoritative terminal
        // reason settles the joined read, independent of that representation.
        controller.signal.throwIfAborted();
        throw error;
      } finally {
        if (this.facetSelection === selection) this.facetSelection = null;
      }
    };
    const selection: FacetSelection = {
      executableVersion: args.version,
      incarnationVersion: args.incarnationVersion,
      controller,
      promise: execute(),
    };
    this.facetSelection = selection;
    return selection.promise;
  }

  async fetch(request: Request): Promise<Response> {
    try {
      return await this.fetchImpl(request);
    } catch (error) {
      return Response.json({ error: serializeRpcFailure(error) }, { status: 500 });
    }
  }

  private async prepareExecutable(input: PreparationInput): Promise<Response> {
    const worker = loadExecutable(this.env, this.ctx, input);
    const receipt = await worker
      .getEntrypoint("VibestudioExecutable")
      .fetch(new Request(`http://executable/${encodeURIComponent(input.className)}`));
    if (!receipt.ok) throw new Error(await receipt.text());
    return new Response(null, { status: 204 });
  }

  private async fetchImpl(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === PREPARATION_KEY) {
      if (request.headers.get(PREPARATION_HEADER) !== "1") {
        return new Response("Forbidden", { status: 403 });
      }
      return this.prepareExecutable((await request.json()) as PreparationInput);
    }
    if (parts[0] === CODE_HOST_KEY) {
      if (request.headers.get(CODE_HOST_HEADER) !== "1") {
        return new Response("Forbidden", { status: 403 });
      }
      return this.codeHostOp((await request.json()) as CodeHostInput);
    }
    const encodedKey = parts[0] ? decodeURIComponent(parts[0]) : "";
    if (!encodedKey) {
      return new Response("universal-do: missing key", { status: 400 });
    }
    const { source, className, userKey } = decodeKey(encodedKey);
    if (!source || !className) {
      return new Response("universal-do: bad key", { status: 400 });
    }

    if (parts[1] === "__vibestudio_retire" || parts[1] === "__vibestudio_restart") {
      if (request.headers.get("X-Vibestudio-Lifecycle-Secret") !== loaderSecret(this.env)) {
        return new Response("Forbidden", { status: 403 });
      }
      await this.cancelFacetSelection(
        new Error(
          parts[1] === "__vibestudio_restart"
            ? "Runtime entity restarted"
            : "Runtime entity retired"
        )
      );
      const ended = new Error(
        parts[1] === "__vibestudio_restart" ? "Runtime entity restarted" : "Runtime entity retired"
      );
      this.ctx.facets.abort("do", ended);
      // Hosted code ends with its entity: holds released, instances aborted.
      this.endAllHosted(ended);
      this.loadedFacet = null;
      return new Response(null, { status: 204 });
    }

    if (parts[1] === "__vibestudio_destroy") {
      if (request.headers.get("X-Vibestudio-Lifecycle-Secret") !== loaderSecret(this.env)) {
        return new Response("Forbidden", { status: 403 });
      }
      // Storage reclamation of a retired object: the runtime stops the facet
      // and removes its database (and any nested facet's) in one operation.
      await this.cancelFacetSelection(new Error("Runtime entity storage destroyed"));
      this.ctx.facets.delete("do");
      this.endAllHosted(new Error("Runtime entity storage destroyed"), { deleteStorage: true });
      this.loadedFacet = null;
      await this.ctx.storage.deleteAll();
      return new Response(null, { status: 204 });
    }

    if (parts[1] === "__vibestudio_fault_abort") {
      if (request.headers.get("X-Vibestudio-Lifecycle-Secret") !== loaderSecret(this.env)) {
        return new Response("Forbidden", { status: 403 });
      }
      // Abort only the loaded userland object. Its SQLite storage and the
      // universal host stay live, so the next ordinary request constructs a
      // genuinely fresh vessel over the same durable state.
      await this.cancelFacetSelection(new Error("System-test injected vessel crash"));
      this.ctx.facets.abort("do", new Error("System-test injected vessel crash"));
      return new Response(null, { status: 204 });
    }

    const identity = `${source}:${className}`;
    const version = request.headers.get(DO_EXECUTABLE_VERSION_HEADER);
    if (!version) return new Response("universal-do: missing executable identity", { status: 400 });

    const incarnationVersion = request.headers.get(DO_INCARNATION_VERSION_HEADER);
    if (!incarnationVersion)
      return new Response("universal-do: missing object admission", { status: 400 });
    const activatesFacet =
      this.loadedFacet?.incarnationVersion !== incarnationVersion ||
      this.loadedFacet.executableVersion !== version;
    const activationStartedAt = performance.now();
    const loaded = await this.loadFacetClass({
      source,
      className,
      userKey,
      version,
      incarnationVersion,
    });

    // One logical DO per host object means one constant facet name. Keeping it
    // stable also makes clone/delete operations portable across host objects.
    const facet = this.ctx.facets.get("do", () => ({ class: loaded.class }));

    const innerRest = parts.slice(1);
    const innerUrl = new URL(
      `/${encodeURIComponent(userKey)}${innerRest.length ? `/${innerRest.join("/")}` : ""}`,
      url.origin
    );
    innerUrl.search = url.search;
    const dispatchStartedAt = performance.now();
    let completed = false;
    try {
      const response = await facet.fetch(new Request(innerUrl, request));
      completed = true;
      return response;
    } catch (error) {
      console.error(
        "Durable Object facet request failed",
        identity,
        userKey,
        innerRest.join("/"),
        error instanceof Error ? (error.stack ?? error.message) : error
      );
      throw error;
    } finally {
      if (activatesFacet) {
        console.info(
          "Durable Object first activation",
          JSON.stringify({
            source,
            className,
            objectKey: userKey,
            version,
            method: innerRest.join("/"),
            loadMs: dispatchStartedAt - activationStartedAt,
            firstFetchMs: performance.now() - dispatchStartedAt,
            completed,
          })
        );
      }
    }
  }
}

const universalDoHost: ExportedHandler = {
  fetch(): Response {
    return new Response("universal-do host");
  },
};

export default universalDoHost;
