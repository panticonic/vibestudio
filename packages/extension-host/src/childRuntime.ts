import { createCredentialClient } from "@vibestudio/service-schemas/clients/credentialClient";
import { createMainRpcCaller, mainRpcMethods, type MainRpcMethods } from "@vibestudio/service-schemas/mainRpc";
import {
  schemaRpcClient,
  createInternalRpcClient,
  type RpcWireClient,
} from "@vibestudio/rpc/internal";
import * as nodeFs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  decodeRpcJson,
  encodeRpcJson,
  envelopeFromMessage,
  rpcDiagnosticIdOf,
  rpcErrorDataOf,
  rpcErrorKindOf,
  type EnvelopeRpcTransport,
  type RpcEnvelope,
  type StreamingMethodFrame,
} from "@vibestudio/rpc";
import type { WsClientMessage, WsServerMessage } from "@vibestudio/shared/ws/protocol";
import {
  createExtensionProxy,
  type ExtensionsClient,
} from "@vibestudio/extension";

import { gitInteropMethods } from "@vibestudio/service-schemas/gitInterop";
import { workspaceMethods } from "@vibestudio/service-schemas/workspace";
import { webhookIngressMethods } from "@vibestudio/service-schemas/webhookIngress";
import { notificationMethods } from "@vibestudio/service-schemas/notification";
import { EventsClient } from "@vibestudio/service-schemas/clients/eventsClient";
import {
  createTypedServiceClient,
  type ServiceMethodSchemas,
  type TypedServiceClient,
} from "@vibestudio/shared/typedServiceClient";
import { RPC_CONTRACT_VERSION } from "@vibestudio/rpc/protocol/contractVersion";
import { isAuthenticatedServerCaller } from "@vibestudio/rpc/protocol/remoteSession";

import type { ExtensionInvocation } from "./types.js";
import { isStreamEnvelope, type BodyEnvelope, type StreamChunkEnvelope } from "./wireEnvelopes.js";
import { replaceExtensionStorageFile } from "./atomicStorage.js";

import { ExtensionRuntimeLifecycle } from "./runtimeLifecycle.js";
import {
  shutdownError,
  type ExtensionShutdownRequest,
  type ExtensionShutdownResult,
} from "./shutdownProtocol.js";

const lifecycle = new ExtensionRuntimeLifecycle();
const pendingShutdowns: ExtensionShutdownRequest[] = [];
let shutdownHandler: ((message: ExtensionShutdownRequest) => Promise<void>) | undefined;
let lifetimeCleanup: () => Promise<void> = () => Promise.resolve();

function runOwnedLifecycle<T>(
  owner: string,
  signal: AbortSignal,
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const extension = process.env["VIBESTUDIO_EXTENSION_NAME"] ?? "unknown";
  const flight = lifecycle.run(signal, async (ownedSignal) => {
    console.info("[ExtensionRuntime] invocation started", {
      extension,
      owner,
    });
    return operation(ownedSignal);
  });
  return flight.then(
    (value) => {
      console.info("[ExtensionRuntime] invocation completed", {
        extension,
        owner,
      });
      return value;
    },
    (error) => {
      console.warn("[ExtensionRuntime] invocation failed", {
        extension,
        owner,
        message: error instanceof Error ? error.message : String(error),
        code: error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined,
        diagnosticId: rpcDiagnosticIdOf(error),
      });
      throw error;
    }
  );
}
process.on("message", (message: unknown) => {
  if (
    message &&
    typeof message === "object" &&
    "type" in message &&
    message.type === "shutdown" &&
    "requestId" in message &&
    typeof message.requestId === "string"
  ) {
    const request: ExtensionShutdownRequest = { type: "shutdown", requestId: message.requestId };
    if (shutdownHandler)
      void shutdownHandler(request).catch((error) =>
        console.error("[ExtensionRuntime] Shutdown control delivery failed:", error)
      );
    else pendingShutdowns.push(request);
  }
});

interface HealthDetail {
  summary: string;
  reasons?: string[];
  retryAt?: number;
}

type ExtensionRuntimePhase = "runtime-import" | "activate" | "invoke" | "fetch";

interface FetchResponseBodyStream {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  pending: Uint8Array | null;
  offset: number;
}

interface SerializedFileStats {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  size: number;
  mtime: string;
  ctime: string;
  mode: number;
}

interface ExtensionInvocationScope {
  invocation: ExtensionInvocation;
  signal: AbortSignal;
}

const invocationStore = new AsyncLocalStorage<ExtensionInvocationScope>();
const fetchResponseBodies = new Map<string, FetchResponseBodyStream>();
const STREAM_CHUNK_BYTES = 64 * 1024;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function likelyCauseForExtensionError(error: unknown): string | null {
  const message = errorMessage(error);
  if (message.includes("require is not defined")) {
    return "Code crossed an ESM/CommonJS boundary without an explicit require. Check the stack to identify whether this came from generated extension code, a bundled dependency, or a host/runtime module. For native or WASM CommonJS packages, prefer dependencyMode auto/external and default imports.";
  }
  if (message.includes("Cannot find module") || message.includes("ERR_MODULE_NOT_FOUND")) {
    return "A runtime dependency was not installed or was externalized without being available in the extension runtime node_modules.";
  }
  if (message.includes("Named export") && message.includes("not found")) {
    return "Generated ESM code used a named import from an external CommonJS package. Use a default import and destructure from it.";
  }
  if (
    message.includes(".node") ||
    message.includes("invalid ELF") ||
    message.includes("NODE_MODULE_VERSION")
  ) {
    return "A native dependency could not load for this Node/Electron runtime. Reinstall or rebuild the dependency for the active runtime.";
  }
  return null;
}

function extensionRuntimeError(
  phase: ExtensionRuntimePhase,
  error: unknown,
  fields: Record<string, unknown>
): Error {
  const likelyCause = likelyCauseForExtensionError(error);
  const detail = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  const message = [
    `[ExtensionRuntime:${phase}] ${detail ? `${detail} ` : ""}${errorMessage(error)}`,
    likelyCause ? `Likely cause: ${likelyCause}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  const wrapped = new Error(message);
  if (error instanceof Error) {
    (wrapped as Error & { cause?: unknown }).cause = error;
  }
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  if (typeof code === "string") {
    (wrapped as NodeJS.ErrnoException).code = code;
  }
  if (error !== null && typeof error === "object" && "errorKind" in error) {
    (wrapped as Error & { errorKind?: unknown }).errorKind = rpcErrorKindOf(error);
  }
  const errorData = rpcErrorDataOf(error);
  if (errorData !== undefined) {
    (wrapped as Error & { errorData?: unknown }).errorData = errorData;
  }
  if (error instanceof Error && error.stack) {
    wrapped.stack = `${wrapped.message}\nCaused by: ${error.stack}`;
  }
  return wrapped;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required extension environment variable: ${name}`);
  return value;
}

function runtimeSchemaCaller(): import("@vibestudio/rpc").RpcCaller {
  return {
    call: (...args) => schemaRpcClient(getRuntimeBridge()).call(...args),
    stream: (...args) => schemaRpcClient(getRuntimeBridge()).stream(...args),
  };
}

const mainRpc = createMainRpcCaller(runtimeSchemaCaller());

function createMainServiceClient<M extends ServiceMethodSchemas>(
  service: string,
  methods: M,
): TypedServiceClient<M> {
  return createTypedServiceClient(service, methods, (serviceName, method, args) => {
    const methodName = `${serviceName}.${method}` as keyof MainRpcMethods & string;
    return runtimeSchemaCaller().call("main", mainRpcMethods[methodName], args);
  });
}

function createGitInteropClient() {
  return createMainServiceClient("gitInterop", gitInteropMethods);
}

function createExtensionsClient(): ExtensionsClient {
  const proxyRpc = {
    ...runtimeSchemaCaller(),
    on: (eventName: string, listener: (event: import("@vibestudio/rpc").RpcEventContext) => void) =>
      getRuntimeBridge().on(eventName, listener, {
        kind: "closed",
        reason: "This listener consumes host or implementation lifecycle events.",
      }),
  };
  const events = new EventsClient(proxyRpc);
  const eventRefcounts = new Map<string, number>();
  const streamingCache = new Map<string, Promise<Set<string>>>();
  const declaredStreaming = (name: string): Promise<Set<string>> => {
    let cached = streamingCache.get(name);
    if (!cached) {
      cached = mainRpc("extensions.streamingMethods", [name])
        .then((methods) => new Set(methods))
        .catch((error) => {
          // Don't pin a transient failure as "no streaming methods" for the
          // client's lifetime — drop the entry so the next call re-fetches.
          streamingCache.delete(name);
          throw error;
        });
      streamingCache.set(name, cached);
    }
    return cached;
  };
  const client: ExtensionsClient = {
    use(name, options) {
      const override = options?.streamingMethods ? new Set(options.streamingMethods) : null;
      return createExtensionProxy(
        proxyRpc,
        name,
        override
          ? (method) => override.has(method)
          : (method) => declaredStreaming(name).then((s) => s.has(method))
      ) as never;
    },
    on(targetName: string, event: string, cb: (payload: unknown) => void) {
      const eventName = `extensions:${targetName}::${event}` as const;
      const stopListening = events.on(eventName, cb);
      const previous = eventRefcounts.get(eventName) ?? 0;
      eventRefcounts.set(eventName, previous + 1);
      if (previous === 0) {
        void events
          .subscribe(eventName)
          .catch((error: unknown) =>
            console.warn(`[extension-host] watch ${eventName} failed:`, error)
          );
      }
      let disposed = false;
      return {
        dispose() {
          if (disposed) return;
          disposed = true;
          stopListening();
          const remaining = (eventRefcounts.get(eventName) ?? 1) - 1;
          if (remaining > 0) {
            eventRefcounts.set(eventName, remaining);
          } else {
            eventRefcounts.delete(eventName);
            void events.unsubscribe(eventName).catch(() => {});
          }
        },
      };
    },
    invoke: (name, method, args) => mainRpc("extensions.invoke", [name, method, args]),
    invokeProvider: (provider, method, args) =>
      mainRpc("extensions.invokeProvider", [provider, method, args]),
    status: (name) => mainRpc("extensions.status", [name]),
    update: (name) => mainRpc("extensions.update", [name]),
  };
  return client;
}

async function requestBodyFromEnvelope(
  body: BodyEnvelope | undefined
): Promise<BodyInit | undefined> {
  if (!body) return undefined;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (!isStreamEnvelope(body)) return undefined;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await mainRpc("extensions.fetchRequestBodyChunk", [body.id]);
      if (next.done) {
        controller.close();
        return;
      }
      if (next.chunk) controller.enqueue(next.chunk);
    },
    async cancel() {
      await mainRpc("extensions.fetchRequestBodyClose", [body.id]).catch(() => {});
    },
  });
}

function toStats(value: SerializedFileStats) {
  return {
    ...value,
    mtime: new Date(value.mtime),
    ctime: new Date(value.ctime),
    isFile: () => value.isFile,
    isDirectory: () => value.isDirectory,
    isSymbolicLink: () => value.isSymbolicLink,
  };
}

function createFsClient() {
  return {
    constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 },
    async readFile(filePath: string, encoding?: BufferEncoding) {
      const result = await mainRpc("fs.readFile", [filePath, encoding]);
      return result instanceof Uint8Array ? Buffer.from(result) : result;
    },
    async writeFile(filePath: string, data: string | Uint8Array) {
      await mainRpc("fs.writeFile", [filePath, data]);
    },
    async appendFile(filePath: string, data: string | Uint8Array) {
      await mainRpc("fs.appendFile", [filePath, data]);
    },
    async readdir(
      filePath: string,
      options?: { withFileTypes?: boolean; recursive?: boolean },
    ) {
      return mainRpc("fs.readdir", [filePath, options]);
    },
    async mkdir(filePath: string, options?: { recursive?: boolean }) {
      return mainRpc("fs.mkdir", [filePath, options]);
    },
    async rmdir(filePath: string) {
      return mainRpc("fs.rmdir", [filePath]);
    },
    async rm(filePath: string, options?: { recursive?: boolean; force?: boolean }) {
      return mainRpc("fs.rm", [filePath, options]);
    },
    async stat(filePath: string) {
      return toStats(await mainRpc("fs.stat", [filePath]));
    },
    async lstat(filePath: string) {
      return toStats(await mainRpc("fs.lstat", [filePath]));
    },
    async access(filePath: string, mode?: number) {
      await mainRpc("fs.access", [filePath, mode]);
    },
    async exists(filePath: string) {
      return mainRpc("fs.exists", [filePath]);
    },
    async unlink(filePath: string) {
      await mainRpc("fs.unlink", [filePath]);
    },
    async copyFile(src: string, dest: string) {
      await mainRpc("fs.copyFile", [src, dest]);
    },
    async rename(oldPath: string, newPath: string) {
      await mainRpc("fs.rename", [oldPath, newPath]);
    },
    async nativeRoots() {
      return mainRpc("fs.nativeRoots", []);
    },
    async realpath(filePath: string) {
      return mainRpc("fs.realpath", [filePath]);
    },
    async ensureMaterialized(scope: string | string[] | "all") {
      return mainRpc("fs.ensureMaterialized", [scope]);
    },
    async open(filePath: string, flags?: string, mode?: number) {
      const { handleId } = await mainRpc("fs.open", [filePath, flags, mode]);
      return {
        fd: handleId,
        async read(buffer: Uint8Array, offset: number, length: number, position: number | null) {
          const result = await mainRpc("fs.handleRead", [
            handleId,
            length,
            position,
          ]);
          buffer.set(result.buffer, offset);
          return { bytesRead: result.bytesRead, buffer };
        },
        async write(
          buffer: Uint8Array,
          offset = 0,
          length = buffer.length,
          position: number | null = null
        ) {
          const slice = buffer.subarray(offset, offset + length);
          const result = await mainRpc("fs.handleWrite", [
            handleId,
            slice,
            position,
          ]);
          return { bytesWritten: result.bytesWritten, buffer };
        },
        async close() {
          await mainRpc("fs.handleClose", [handleId]);
        },
        async stat() {
          return toStats(await mainRpc("fs.handleStat", [handleId]));
        },
      };
    },
    async truncate(filePath: string, len?: number) {
      await mainRpc("fs.truncate", [filePath, len]);
    },
    async readlink(filePath: string) {
      return mainRpc("fs.readlink", [filePath]);
    },
    async symlink(target: string, filePath: string, type?: "file" | "dir" | "junction") {
      await mainRpc("fs.symlink", [target, filePath, type]);
    },
    async chmod(filePath: string, mode: number) {
      await mainRpc("fs.chmod", [filePath, mode]);
    },
    async utimes(filePath: string, atime: number | Date, mtime: number | Date) {
      await mainRpc("fs.utimes", [
        filePath,
        atime instanceof Date ? atime.getTime() / 1000 : atime,
        mtime instanceof Date ? mtime.getTime() / 1000 : mtime,
      ]);
    },
  };
}

function createContext() {
  const name = requiredEnv("VIBESTUDIO_EXTENSION_NAME");
  const version = requiredEnv("VIBESTUDIO_EXTENSION_VERSION");
  const storageRoot = requiredEnv("VIBESTUDIO_EXTENSION_STORAGE_DIR");
  const normalizedRoot = path.resolve(storageRoot);
  const rootWithSep = normalizedRoot.endsWith(path.sep)
    ? normalizedRoot
    : normalizedRoot + path.sep;
  const storagePath = (p: string) => {
    const resolved = path.resolve(normalizedRoot, p);
    // Boundary check: resolved must be the root itself or strictly inside it.
    // Using a prefix check on the normalized form is robust to ".." segments,
    // absolute inputs, and accidental sibling-dir prefixes (e.g. /storage-extra).
    if (resolved !== normalizedRoot && !resolved.startsWith(rootWithSep)) {
      const err = new Error(
        `Storage path escapes extension storage: ${p}`
      ) as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    }
    return resolved;
  };

  const ctx = {
    name,
    version,
    storage: {
      root: normalizedRoot,
      mkdir: (p: string, opts?: { recursive?: boolean }) =>
        nodeFs.mkdir(storagePath(p), { recursive: opts?.recursive ?? true }),
      readFile: (p: string, encoding?: BufferEncoding) => nodeFs.readFile(storagePath(p), encoding),
      writeFile: (p: string, data: string | Uint8Array) => nodeFs.writeFile(storagePath(p), data),
      replaceFile: (p: string, data: string | Uint8Array) =>
        replaceExtensionStorageFile(normalizedRoot, p, data),
      rm: (p: string, opts?: { recursive?: boolean; force?: boolean }) =>
        nodeFs.rm(storagePath(p), opts),
      readdir: (p = ".") => nodeFs.readdir(storagePath(p)),
    },
    fs: createFsClient(),
    git: createGitInteropClient(),
    workspace: createMainServiceClient("workspace", workspaceMethods),
    rpc: {
      ...runtimeSchemaCaller(),
      on: (eventName: string, cb: (event: { payload: unknown }) => void) =>
        getRuntimeBridge().on(eventName, cb, {
          kind: "closed",
          reason: "This listener consumes host or implementation lifecycle events.",
        }),
    },
    workers: {
      listServices: () => mainRpc("workers.listServices", []),
      resolveService: (query: string, objectKey?: string | null) =>
        mainRpc("workers.resolveService", [query, objectKey ?? null]),
      resolveDurableObject: (source: string, className: string, objectKey: string) =>
        mainRpc("workers.resolveDurableObject", [source, className, objectKey]),
    },
    credentials: createCredentialClient(schemaRpcClient(getRuntimeBridge())),
    webhooks: createMainServiceClient("webhookIngress", webhookIngressMethods),
    notifications: createMainServiceClient("notification", notificationMethods),
    extensions: createExtensionsClient(),
    invocation: {
      current: () => invocationStore.getStore()?.invocation ?? null,
      signal: () => invocationStore.getStore()?.signal ?? null,
    },
    subscriptions: [] as Array<{ dispose(): void | Promise<void> }>,
    log: {
      debug: (message: string, fields?: Record<string, unknown>) => {
        void writeExtensionLog("debug", message, fields).catch((err) => {
          console.error("[ExtensionRuntime] Failed to write debug log:", err);
        });
      },
      info: (message: string, fields?: Record<string, unknown>) => {
        void writeExtensionLog("info", message, fields).catch((err) => {
          console.error("[ExtensionRuntime] Failed to write info log:", err);
        });
      },
      warn: (message: string, fields?: Record<string, unknown>) => {
        void writeExtensionLog("warn", message, fields).catch((err) => {
          console.error("[ExtensionRuntime] Failed to write warn log:", err);
        });
      },
      error: (message: string, fields?: Record<string, unknown>) => {
        void writeExtensionLog("error", message, fields).catch((err) => {
          console.error("[ExtensionRuntime] Failed to write error log:", err);
        });
      },
    },
    health: {
      report: (state: "healthy" | "degraded" | "unhealthy", detail?: HealthDetail) => {
        void mainRpc("runtime.supervision.reportHealth", [{ state, detail }]).catch((err) => {
          console.error("[ExtensionRuntime] Failed to report health:", err);
        });
      },
      healthy: (detail?: HealthDetail) => {
        void mainRpc("runtime.supervision.reportHealth", [{ state: "healthy", detail }]).catch(
          (err) => {
            console.error("[ExtensionRuntime] Failed to report health:", err);
          }
        );
      },
      degraded: (detail: HealthDetail) => {
        void mainRpc("runtime.supervision.reportHealth", [{ state: "degraded", detail }]).catch(
          (err) => {
            console.error("[ExtensionRuntime] Failed to report health:", err);
          }
        );
      },
      unhealthy: (detail: HealthDetail) => {
        void mainRpc("runtime.supervision.reportHealth", [{ state: "unhealthy", detail }]).catch(
          (err) => {
            console.error("[ExtensionRuntime] Failed to report health:", err);
          }
        );
      },
    },
    emit: (event: string, payload: unknown) => {
      void mainRpc("extensions.emit", [event, payload]).catch((err) => {
        console.error(`[ExtensionRuntime] Failed to emit ${event}:`, err);
      });
    },
  };
  return ctx;
}

let runtimeBridge: RpcWireClient | null = null;

function getRuntimeBridge(): RpcWireClient {
  if (!runtimeBridge) throw new Error("Extension process RPC is not connected");
  return runtimeBridge;
}

async function connectRuntimeBridge(): Promise<RpcWireClient> {
  const token = requiredEnv("VIBESTUDIO_EXTENSION_RPC_TOKEN");
  const extensionName = requiredEnv("VIBESTUDIO_EXTENSION_NAME");
  if (!process.send || !process.connected)
    throw new Error("Extension requires its launcher's IPC channel");
  const listeners = new Set<(envelope: RpcEnvelope) => void>();
  let connected = true;
  const send = (message: WsClientMessage): Promise<void> =>
    new Promise((resolve, reject) => {
      if (!connected || !process.connected || !process.send) {
        reject(new Error("Extension process RPC is disconnected"));
        return;
      }
      process.send(encodeRpcJson(message), (error) => (error ? reject(error) : resolve()));
    });
  const transport: EnvelopeRpcTransport = {
    async send(envelope: RpcEnvelope): Promise<void> {
      const parentRequestId = invocationStore.getStore()?.invocation.requestId;
      const stampedMessage =
        parentRequestId &&
        (envelope.message.type === "request" || envelope.message.type === "stream-request")
          ? { ...envelope.message, parentRequestId }
          : envelope.message;
      const stampedEnvelope =
        stampedMessage === envelope.message ? envelope : { ...envelope, message: stampedMessage };
      await send(
        stampedEnvelope.target === "main" || stampedEnvelope.target === "server"
          ? { type: "ws:rpc", envelope: stampedEnvelope }
          : { type: "ws:route", envelope: stampedEnvelope }
      );
    },
    onMessage(handler) {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },
    status: () => (connected ? "connected" : "disconnected"),
    ready: () => Promise.resolve(),
    onStatusChange: () => () => {},
  };
  const bridge = createInternalRpcClient({
    selfId: extensionName,
    callerKind: "extension",
    transport,
    authorityAcquisition: "wait",
    invocationSignal: () => invocationStore.getStore()?.signal,
  });
  let accept!: () => void;
  let rejectAuth!: (error: Error) => void;
  const authenticated = new Promise<void>((resolve, reject) => {
    accept = resolve;
    rejectAuth = reject;
  });
  const timeout = setTimeout(
    () => rejectAuth(new Error("Extension process RPC auth timeout")),
    10_000
  );
  const receive = (raw: unknown) => {
    if (typeof raw !== "string") return; // Shutdown is a lifecycle object, not an RPC frame.
    let message: WsServerMessage;
    try {
      message = decodeRpcJson(raw) as WsServerMessage;
    } catch {
      return;
    }
    if (message.type === "ws:auth-result") {
      if (!message.success)
        rejectAuth(
          new Error(`Extension process RPC auth failed: ${message.error ?? "unknown error"}`)
        );
      else if (message.contractVersion !== RPC_CONTRACT_VERSION)
        rejectAuth(
          new Error(
            `Extension RPC contract mismatch: server ${String(message.contractVersion)} (want ${RPC_CONTRACT_VERSION})`
          )
        );
      else accept();
      return;
    }
    if (message.type === "ws:rpc" || message.type === "ws:routed") {
      const envelope = message.envelope;
      if (!envelope?.message) return;
      for (const listener of listeners) listener(envelope);
    } else if (message.type === "ws:routed-response-error") {
      // The server could not deliver our routed request. Synthesize a rejecting
      // response so the pending call settles instead of hanging (silent-drop class).
      console.warn(
        `[ExtensionRuntime] routed request to ${message.targetId} failed (requestId=${message.requestId}): ${message.error}`
      );
      const envelope = envelopeFromMessage({
        selfId: extensionName,
        from: message.targetId,
        target: extensionName,
        callerKind: "unknown",
        message: { type: "response", requestId: message.requestId, error: message.error },
      });
      for (const listener of listeners) listener(envelope);
    } else if (message.type === "ws:routed-event-error") {
      console.warn(
        `[ExtensionRuntime] routed event "${message.event}" to ${message.targetId} dropped: ${message.error}`
      );
    }
  };
  process.on("message", receive);
  process.once("disconnect", () => {
    connected = false;
    process.off("message", receive);
    rejectAuth(new Error("Extension process RPC disconnected"));
    void lifetimeCleanup().then(
      () => process.exit(1),
      (error) =>
        console.error("[ExtensionRuntime] Disconnected cleanup retains owned resources:", error)
    );
  });
  try {
    await send({
      type: "ws:auth",
      contractVersion: RPC_CONTRACT_VERSION,
      token,
      connectionId: `extension:${extensionName}`,
    });
    await authenticated;
  } finally {
    clearTimeout(timeout);
  }
  return bridge;
}

function responseBodyToEnvelope(response: Response): BodyEnvelope {
  if (!response.body) return new Uint8Array(0);
  const id = randomUUID();
  fetchResponseBodies.set(id, {
    reader: response.body.getReader(),
    pending: null,
    offset: 0,
  });
  return { __stream: true, id };
}

function writeExtensionLog(
  level: "debug" | "info" | "warn" | "error",
  message: string,
  fields?: Record<string, unknown>
): Promise<unknown> {
  return mainRpc("runtime.supervision.appendLog", [
    fields === undefined ? { level, message } : { level, message, fields },
  ]);
}

async function readNextResponseBodyChunk(id: string): Promise<StreamChunkEnvelope> {
  const stream = fetchResponseBodies.get(id);
  if (!stream) {
    const err = new Error(
      `Unknown extension fetch response body stream: ${id}`
    ) as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  }
  if (stream.pending && stream.offset < stream.pending.length) {
    const nextOffset = Math.min(stream.offset + STREAM_CHUNK_BYTES, stream.pending.length);
    const chunk = stream.pending.subarray(stream.offset, nextOffset);
    stream.offset = nextOffset;
    if (stream.offset >= stream.pending.length) {
      stream.pending = null;
      stream.offset = 0;
    }
    return { done: false, chunk };
  }
  const next = await stream.reader.read();
  if (next.done) {
    await closeResponseBodyStream(id);
    return { done: true };
  }
  if (next.value.length <= STREAM_CHUNK_BYTES) return { done: false, chunk: next.value };
  stream.pending = next.value;
  stream.offset = 0;
  return readNextResponseBodyChunk(id);
}

async function closeResponseBodyStream(id: string): Promise<void> {
  const stream = fetchResponseBodies.get(id);
  if (!stream) return;
  fetchResponseBodies.delete(id);
  try {
    await stream.reader.cancel();
  } finally {
    stream.reader.releaseLock();
  }
}

async function streamResponse(
  response: Response,
  sink: (frame: StreamingMethodFrame) => Promise<void> | void,
  abortSignal: AbortSignal
): Promise<void> {
  await sink({
    kind: "head",
    status: response.status,
    statusText: response.statusText,
    headerPairs: Array.from(response.headers.entries()),
    finalUrl: response.url,
  });
  let bytesIn = 0;
  if (response.body) {
    const reader = response.body.getReader();
    let cancellation: Promise<void> | undefined;
    const cancel = () => {
      cancellation ??= reader.cancel();
      void cancellation.catch(() => {});
    };
    abortSignal.addEventListener("abort", cancel, { once: true });
    let original: unknown;
    try {
      while (!abortSignal.aborted) {
        const next = await reader.read();
        if (next.done) break;
        bytesIn += next.value.byteLength;
        await sink({ kind: "chunk", bytes: next.value });
      }
    } catch (error) {
      original = error;
      throw error;
    } finally {
      abortSignal.removeEventListener("abort", cancel);
      try {
        await cancellation;
      } catch (cleanup) {
        if (original !== undefined)
          throw new AggregateError(
            [original, cleanup],
            "Extension stream and cancellation failed",
            { cause: original }
          );
        throw cleanup;
      } finally {
        reader.releaseLock();
      }
    }
  }
  await sink({ kind: "end", bytesIn });
}

function settleWaitUntil(waitUntil: Promise<unknown>[]): void {
  if (waitUntil.length === 0) return;
  void lifecycle.retain(
    Promise.allSettled(waitUntil).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") {
          console.error("[ExtensionRuntime] fetch waitUntil rejected:", result.reason);
        }
      }
    })
  );
}

function assertHostControlCaller(
  request: { caller: { callerId: string; callerKind: string } },
  method: string
): void {
  if (isAuthenticatedServerCaller(request.caller)) return;
  const error = new Error(
    `Extension control method ${method} accepts only the trusted host principal`
  ) as NodeJS.ErrnoException;
  error.code = "EACCES";
  throw error;
}

async function main(): Promise<void> {
  runtimeBridge = await connectRuntimeBridge();
  const bundlePath = requiredEnv("VIBESTUDIO_EXTENSION_BUNDLE_PATH");
  const extensionName = requiredEnv("VIBESTUDIO_EXTENSION_NAME");
  installCommonJsGlobals(bundlePath);
  let mod: Awaited<ReturnType<typeof importExtensionModule>>;
  console.info("[ExtensionRuntime] extension module import started", { extension: extensionName });
  try {
    mod = await importExtensionModule(bundlePath);
    console.info("[ExtensionRuntime] extension module import completed", {
      extension: extensionName,
    });
  } catch (err) {
    console.warn("[ExtensionRuntime] extension module import failed", {
      extension: extensionName,
      message: err instanceof Error ? err.message : String(err),
      code: err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined,
      diagnosticId: rpcDiagnosticIdOf(err),
    });
    throw extensionRuntimeError("runtime-import", err, { extension: extensionName, bundlePath });
  }
  const ctx = createContext();
  console.info("[ExtensionRuntime] extension activation started", { extension: extensionName });
  const activation = Promise.resolve().then(() =>
    typeof mod["activate"] === "function" ? mod["activate"](ctx) : undefined
  );
  lifetimeCleanup = async () => {
    await activation.catch(() => {});
    const deactivate = mod["deactivate"];
    await lifecycle.shutdown(
      ctx.subscriptions,
      typeof deactivate === "function" ? () => deactivate() : undefined
    );
  };
  ctx.subscriptions.push({
    dispose: async () => {
      const results = await Promise.allSettled(
        [...fetchResponseBodies.keys()].map(closeResponseBodyStream)
      );
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []
      );
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(failures, "Extension response body cleanup failed", {
          cause: failures[0],
        });
    },
  });
  let api: unknown;
  try {
    api = await activation;
    console.info("[ExtensionRuntime] extension activation completed", { extension: extensionName });
  } catch (err) {
    console.warn("[ExtensionRuntime] extension activation failed", {
      extension: extensionName,
      message: err instanceof Error ? err.message : String(err),
      code: err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined,
      diagnosticId: rpcDiagnosticIdOf(err),
    });
    throw extensionRuntimeError("activate", err, { extension: extensionName, bundlePath });
  }
  const apiObject = api && typeof api === "object" ? (api as Record<string, unknown>) : {};
  const methods = Object.keys(apiObject).filter((key) => typeof apiObject[key] === "function");
  const providerApiValue = apiObject["providerContracts"];
  if (
    providerApiValue !== undefined &&
    (!providerApiValue || typeof providerApiValue !== "object" || Array.isArray(providerApiValue))
  ) {
    throw new Error("activate().providerContracts must be an object keyed by provider slot");
  }
  const providerApis = (providerApiValue ?? {}) as Record<string, unknown>;
  const providerMethods: Record<string, string[]> = {};
  for (const [provider, providerApi] of Object.entries(providerApis)) {
    if (!providerApi || typeof providerApi !== "object" || Array.isArray(providerApi)) {
      throw new Error(`activate().providerContracts.${provider} must be a method object`);
    }
    const providerMethodObject = providerApi as Record<string, unknown>;
    const names = Object.keys(providerMethodObject);
    if (names.some((method) => typeof providerMethodObject[method] !== "function")) {
      throw new Error(`activate().providerContracts.${provider} may contain only provider methods`);
    }
    providerMethods[provider] = names;
  }
  const defaultExport = mod["default"] as { fetch?: unknown } | undefined;
  const fetchHandler =
    typeof defaultExport?.fetch === "function" ? defaultExport.fetch.bind(defaultExport) : null;

  runtimeBridge.expose(
    "extension.invoke",
    async (req) => {
      assertHostControlCaller(req, "extension.invoke");
      const [method, args, invocation] = req.args as [string, unknown[], ExtensionInvocation];
      return runOwnedLifecycle(`extension.invoke:${method}`, req.signal, (signal) =>
        invocationStore.run({ invocation, signal }, async () => {
          const fn = Object.prototype.hasOwnProperty.call(apiObject, method)
            ? apiObject[method]
            : undefined;
          if (typeof fn !== "function") {
            const err = new Error(`Extension method not found: ${method}`) as NodeJS.ErrnoException;
            err.code = "ENOMETHOD";
            throw err;
          }
          try {
            return await fn(...args);
          } catch (err) {
            throw extensionRuntimeError("invoke", err, {
              extension: extensionName,
              method,
              caller: invocation.caller.callerId,
            });
          }
        })
      );
    },
    {
      kind: "closed",
      reason: "This handler controls an internal execution or presentation surface.",
    }
  );

  runtimeBridge.expose(
    "extension.invokeProvider",
    async (req) => {
      assertHostControlCaller(req, "extension.invokeProvider");
      const [provider, method, args, invocation] = req.args as [
        string,
        string,
        unknown[],
        ExtensionInvocation,
      ];
      return runOwnedLifecycle(
        `extension.invokeProvider:${provider}.${method}`,
        req.signal,
        (signal) =>
          invocationStore.run({ invocation, signal }, async () => {
            const providerApi = Object.prototype.hasOwnProperty.call(providerApis, provider)
              ? providerApis[provider]
              : undefined;
            const fn =
              providerApi && typeof providerApi === "object"
                ? (providerApi as Record<string, unknown>)[method]
                : undefined;
            if (typeof fn !== "function") {
              const err = new Error(
                `Extension provider method not found: providers.${provider}.${method}`
              ) as NodeJS.ErrnoException;
              err.code = "ENOMETHOD";
              throw err;
            }
            try {
              return await fn(...args);
            } catch (err) {
              throw extensionRuntimeError("invoke", err, {
                extension: extensionName,
                method: `providers.${provider}.${method}`,
                caller: invocation.caller.callerId,
              });
            }
          })
      );
    },
    {
      kind: "closed",
      reason: "This handler controls an internal execution or presentation surface.",
    }
  );

  runtimeBridge.exposeStreaming(
    "extension.invokeStream",
    async (req, sink) => {
      assertHostControlCaller(req, "extension.invokeStream");
      const [method, methodArgs, invocation] = req.args as [string, unknown[], ExtensionInvocation];
      await runOwnedLifecycle(`extension.invokeStream:${method}`, req.signal, (signal) =>
        invocationStore.run({ invocation, signal }, async () => {
          const fn = Object.prototype.hasOwnProperty.call(apiObject, method)
            ? apiObject[method]
            : undefined;
          if (typeof fn !== "function") {
            const err = new Error(`Extension method not found: ${method}`) as NodeJS.ErrnoException;
            err.code = "ENOMETHOD";
            throw err;
          }
          const result = await fn(...methodArgs);
          if (result instanceof Response) {
            await streamResponse(result, sink, signal);
            return;
          }
          if (result instanceof ReadableStream) {
            await streamResponse(new Response(result), sink, signal);
            return;
          }
          throw new Error(`Extension method ${method} did not return a Response or ReadableStream`);
        })
      );
    },
    {
      kind: "closed",
      reason: "This handler controls an internal execution or presentation surface.",
    }
  );

  runtimeBridge.expose(
    "extension.fetchResponseBodyChunk",
    async (req) => {
      assertHostControlCaller(req, "extension.fetchResponseBodyChunk");
      const [streamId] = req.args as [string];
      return runOwnedLifecycle("extension.fetchResponseBodyChunk", req.signal, () =>
        readNextResponseBodyChunk(streamId)
      );
    },
    {
      kind: "closed",
      reason: "This handler controls an internal execution or presentation surface.",
    }
  );

  runtimeBridge.expose(
    "extension.fetchResponseBodyClose",
    async (req) => {
      assertHostControlCaller(req, "extension.fetchResponseBodyClose");
      const [streamId] = req.args as [string];
      return runOwnedLifecycle("extension.fetchResponseBodyClose", req.signal, async () => {
        await closeResponseBodyStream(streamId);
        return null;
      });
    },
    {
      kind: "closed",
      reason: "This handler controls an internal execution or presentation surface.",
    }
  );

  runtimeBridge.expose(
    "extension.fetch",
    async (req) => {
      assertHostControlCaller(req, "extension.fetch");
      const [requestEnvelope, invocation] = req.args as [
        { url: string; method: string; headers: Record<string, string>; body?: BodyEnvelope },
        ExtensionInvocation,
      ];
      if (!fetchHandler) {
        const err = new Error(
          `Extension has no fetch handler: ${ctx.name}`
        ) as NodeJS.ErrnoException;
        err.code = "ENOFETCH";
        throw err;
      }
      return runOwnedLifecycle(`extension.fetch:${requestEnvelope.method}`, req.signal, (signal) =>
        invocationStore.run({ invocation, signal }, async () => {
          const body = await requestBodyFromEnvelope(requestEnvelope.body);
          const request = new Request(requestEnvelope.url, {
            method: requestEnvelope.method,
            headers: requestEnvelope.headers,
            signal,
            ...(body ? { body, duplex: "half" } : {}),
          } as RequestInit & { duplex?: "half" });
          const waitUntil: Promise<unknown>[] = [];
          const fetchCtx = {
            ...ctx,
            waitUntil(promise: Promise<unknown>) {
              waitUntil.push(promise);
            },
          };
          try {
            let response: Response;
            try {
              response = await fetchHandler(request, fetchCtx);
            } catch (err) {
              throw extensionRuntimeError("fetch", err, {
                extension: extensionName,
                method: requestEnvelope.method,
                url: requestEnvelope.url,
              });
            }
            return {
              status: response.status,
              headers: Object.fromEntries(response.headers.entries()),
              body: responseBodyToEnvelope(response),
            };
          } finally {
            settleWaitUntil(waitUntil);
          }
        })
      );
    },
    {
      kind: "closed",
      reason: "This handler controls an internal execution or presentation surface.",
    }
  );

  const shutdown = async (message: ExtensionShutdownRequest): Promise<void> => {
    let result: ExtensionShutdownResult;
    try {
      await lifetimeCleanup();
      result = { type: "shutdown-result", requestId: message.requestId, ok: true };
    } catch (error) {
      result = {
        type: "shutdown-result",
        requestId: message.requestId,
        ok: false,
        error: shutdownError(error),
      };
    }
    await new Promise<void>((resolve, reject) => {
      if (!process.send || !process.connected) {
        reject(new Error("Extension shutdown control disconnected"));
        return;
      }
      process.send(result, (error) => (error ? reject(error) : resolve()));
    });
    // A failed release may still own a live child or lease. Keep this activation
    // sealed, retain the failed disposer, and allow an explicit shutdown retry.
    if (result.ok) process.exit(0);
  };
  shutdownHandler = shutdown;
  if (pendingShutdowns.length > 0) {
    await Promise.all(pendingShutdowns.splice(0).map(shutdown));
    return;
  }

  await mainRpc("runtime.supervision.reportHealth", [
    { state: "healthy", detail: { summary: "Activated" } },
  ]).catch((err) => {
    console.error("[ExtensionRuntime] Failed to report initial health:", err);
  });
  console.info("[ExtensionRuntime] readiness report started", { extension: extensionName });
  try {
    await mainRpc("runtime.supervision.reportReady", [
      { methods, providerMethods, hasFetch: !!fetchHandler },
    ]);
    console.info("[ExtensionRuntime] readiness report completed", { extension: extensionName });
  } catch (error) {
    console.warn("[ExtensionRuntime] readiness report failed", {
      extension: extensionName,
      message: error instanceof Error ? error.message : String(error),
      code: error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined,
      diagnosticId: rpcDiagnosticIdOf(error),
    });
    throw error;
  }
}

function importExtensionModule(bundlePath: string): Promise<Record<string, unknown>> {
  return import(pathToFileURL(bundlePath).href) as Promise<Record<string, unknown>>;
}

function installCommonJsGlobals(bundlePath: string): void {
  const globals = globalThis as typeof globalThis & {
    require?: NodeRequire;
    __filename?: string;
    __dirname?: string;
  };
  globals.require = createRequire(pathToFileURL(bundlePath).href);
  globals.__filename = bundlePath;
  globals.__dirname = path.dirname(bundlePath);
}

main().catch(async (original) => {
  console.error(original);
  try {
    await lifetimeCleanup();
    process.exit(1);
  } catch (cleanup) {
    console.error(
      new AggregateError([original, cleanup], "Extension initialization and cleanup failed", {
        cause: original,
      })
    );
  }
});
