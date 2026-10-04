import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { prepareNativeRuntime } from "@vibestudio/shared/nativeRuntimeResources";
import { getNativeExecutionInstallation } from "@vibestudio/shared/runtimePaths";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createNodeProcessAdapter,
  WorkspaceRuntime,
  type ProcessAdapter,
} from "@vibestudio/process-adapter";
import {
  envelopeFromMessage,
  type RpcEnvelope,
  type RpcMessage,
  type RpcRequest,
  type RpcResponse,
} from "@vibestudio/rpc";
import { RPC_CONTRACT_VERSION } from "@vibestudio/rpc/protocol/contractVersion";
import type {
  WsClientMessage,
  WsServerMessage,
  WsRpcResponseMessage,
} from "@vibestudio/shared/ws/protocol";

function tempDir(): string {
  return fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-extension-runtime-"))
  );
}

function waitForMessage<T>(
  subscribe: (resolve: (value: T) => void, reject: (err: Error) => void) => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    subscribe(resolve, reject);
  });
}

function makeEnvelope(
  from: string,
  target: string,
  callerKind: RpcEnvelope["delivery"]["caller"]["callerKind"],
  message: RpcMessage
): RpcEnvelope {
  return envelopeFromMessage({
    selfId: from,
    from,
    target,
    callerKind,
    message,
  });
}

const modes = ["node", "native-workspace"] as const;
describe.each(modes)("extension child runtime (%s)", (mode) => {
  let childRuntimeBundle = "";
  let root: string | null = null;
  let proc: ProcessAdapter | null = null;
  let sandbox: WorkspaceRuntime | null = null;

  beforeAll(async () => {
    childRuntimeBundle = fs.readFileSync(
      fileURLToPath(new URL("../dist/childRuntime.js", import.meta.url)),
      "utf8"
    );
  });

  afterEach(async () => {
    if (proc) {
      const child = proc;
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Extension fixture did not stop")),
          5_000
        );
        child.on("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
        child.kill();
      });
    }
    proc = null;
    if (sandbox) {
      expect((await sandbox.stop()).launcherExited).toBe(true);
      sandbox = null;
    }
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it("authenticates over process IPC, reports ready, and handles invoke without a network listener", async () => {
    root = tempDir();
    const childRuntimePath = path.join(root, "childRuntime.mjs");
    fs.writeFileSync(childRuntimePath, childRuntimeBundle);
    const extensionDir = path.join(root, "extension");
    fs.mkdirSync(extensionDir, { recursive: true });
    fs.writeFileSync(path.join(extensionDir, "package.json"), '{"type":"module"}');
    const bundlePath = path.join(extensionDir, "bundle.js");
    const hostDatabase = path.join(root, "host-forbidden.sqlite");
    const hostCanary = new DatabaseSync(hostDatabase);
    try {
      hostCanary.exec(
        "CREATE TABLE records (value TEXT, revision INTEGER); INSERT INTO records VALUES ('host-only', 1);"
      );
    } finally {
      hostCanary.close();
    }
    fs.writeFileSync(hostDatabase + ".fs", "host-only");
    fs.writeFileSync(
      bundlePath,
      [
        "import { DatabaseSync } from 'node:sqlite';",
        "import * as fs from 'node:fs';",
        "import * as path from 'node:path';",
        "export async function activate(ctx) {",
        "  ctx.log.info('activated');",
        "  let disposals = 0;",
        "  ctx.subscriptions.push({ async dispose() {",
        "    const attempt = ++disposals;",
        "    await ctx.rpc.call('main', 'releaseOwnedResource', attempt);",
        "    process.send({ type: 'fixture-dispose-started', attempt });",
        "    await new Promise(resolve => {",
        "      const release = message => { if (message?.type === 'fixture-release') { process.off('message', release); resolve(); } };",
        "      process.on('message', release);",
        "    });",
        "    if (attempt === 1) {",
        "      const original = new Error('Original provider release failed');",
        "      throw new AggregateError([original, new Error('Independent cleanup failed')], 'Owned release failed', { cause: original });",
        "    }",
        "  }});",
        "  return {",
        "    ping(value) { return `pong:${value}`; },",
        "    async replaceStorage(value) {",
        "      await ctx.storage.mkdir('atomic');",
        "      await ctx.storage.replaceFile('atomic/value.txt', value);",
        "      return ctx.storage.readFile('atomic/value.txt', 'utf8');",
        "    },",
        "    async sqliteStorage(hostPath, sourcePath) {",
        "      await ctx.storage.mkdir('.');",
        "      const ownPath = path.join(ctx.storage.root, 'records.sqlite');",
        "      let db = new DatabaseSync(ownPath);",
        "      let updated, stale;",
        "      try {",
        "        db.exec('PRAGMA journal_mode = WAL; CREATE TABLE records (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, value TEXT NOT NULL);');",
        "        db.prepare('INSERT INTO records VALUES (?, ?, ?)').run('model', 1, 'prepared');",
        "        const update = db.prepare('UPDATE records SET revision = ?, value = ? WHERE id = ? AND revision = ?');",
        "        updated = update.run(2, 'committed', 'model', 1).changes;",
        "        stale = update.run(3, 'stale', 'model', 1).changes;",
        "      } finally { db.close(); }",
        "      db = new DatabaseSync(ownPath);",
        "      try {",
        "        const row = db.prepare('SELECT id, revision, value FROM records').get();",
        "        const probe = operation => {",
        "          try { operation(); return { allowed: true }; }",
        "          catch (error) { return { allowed: false, code: error.code, message: error.message }; }",
        "        };",
        "        const create = file => {",
        "          const foreign = new DatabaseSync(file);",
        "          try { foreign.exec('CREATE TABLE forbidden (value TEXT);'); } finally { foreign.close(); }",
        "        };",
        "        const updateHost = () => {",
        "          const foreign = new DatabaseSync(hostPath);",
        "          try {",
        "            const original = foreign.prepare('SELECT value FROM records').get();",
        "            if (original?.value !== 'host-only') throw new Error('Original host database is unavailable');",
        "            foreign.exec('UPDATE records SET revision = revision + 1');",
        "          } finally { foreign.close(); }",
        "        };",
        "        return { updated, stale, row,",
        "          host: probe(updateHost),",
        "          source: probe(() => create(sourcePath)),",
        "          attach: probe(() => { db.prepare('ATTACH DATABASE ? AS forbidden').run(hostPath); db.exec('UPDATE forbidden.records SET revision = revision + 1; DETACH DATABASE forbidden;'); }),",
        "          hostFs: probe(() => { const file = fs.openSync(hostPath + '.fs', 'r+'); try { fs.writeSync(file, 'forbidden'); } finally { fs.closeSync(file); } }),",
        "          sourceFs: probe(() => fs.writeFileSync(sourcePath + '.fs', 'forbidden'))",
        "        };",
        "      } finally { db.close(); }",
        "    },",
        "    callerContext() {",
        "      const invocation = ctx.invocation.current();",
        "      return invocation?.chainCaller?.contextId ?? invocation?.caller.contextId ?? null;",
        "    },",
        "    targetEcho(targetId, method, value) {",
        "      return ctx.rpc.call(targetId, method, value);",
        "    },",
        "    structuredFailure() {",
        "      const error = new Error('approval required');",
        "      error.code = 'EACQUIRE';",
        "      error.errorKind = 'access';",
        "      error.errorData = { acquisition: { id: 'acq-child', ownerRuntimeId: 'panel-1' } };",
        "      throw error;",
        "    },",
        "    providerContracts: {",
        "      gitInterop: {",
        "        providerPing(value) { return `provider-pong:${value}`; },",
        "      },",
        "    },",
        "  };",
        "}",
        "",
      ].join("\n")
    );

    const commandEnv = {
      VIBESTUDIO_EXTENSION_NAME: "@workspace-extensions/process-test",
      VIBESTUDIO_EXTENSION_VERSION: "0.0.0",
      VIBESTUDIO_EXTENSION_BUNDLE_PATH: bundlePath,
      VIBESTUDIO_EXTENSION_STORAGE_DIR: path.join(root, "storage"),
      VIBESTUDIO_EXTENSION_RPC_TOKEN: "test-token",
    };
    if (mode === "native-workspace") {
      const appRoot = fs.realpathSync.native(fileURLToPath(new URL("../../../", import.meta.url)));
      const runtimeRoot = path.join(root, "runtime");
      fs.mkdirSync(runtimeRoot);
      const runtime = prepareNativeRuntime({ appRoot, runtimeRoot });
      const installedWorkspaceRuntime = fileURLToPath(
        new URL("../../process-adapter/dist/isolation", import.meta.url)
      );
      for (const file of ["workspaceChild.js", "control.js"])
        fs.copyFileSync(path.join(installedWorkspaceRuntime, file), path.join(runtimeRoot, file));
      fs.writeFileSync(path.join(runtimeRoot, "package.json"), '{"type":"module"}');
      const home = path.join(root, "storage");
      fs.mkdirSync(path.join(home, "tmp"), { recursive: true });
      sandbox = await WorkspaceRuntime.start(
        {
          version: 1,
          owner: {
            workspaceId: "extension-fixture",
            contextId: null,
            runtimeId: "native-workspace",
            incarnation: "fixture",
            executionDigest: "fixture",
          },
          privateRoot: root,
          executable: runtime.executable,
          args: [],
          cwd: home,
          home,
          environment: { PATH: path.dirname(runtime.executable), ...runtime.environment },
          read: [...runtime.readPaths, childRuntimePath, extensionDir],
          write: [home],
          sockets: [],
        },
        {
          ...getNativeExecutionInstallation(appRoot),
          workspaceEntry: path.join(runtimeRoot, "workspaceChild.js"),
        }
      );
      proc = sandbox.fork(childRuntimePath, commandEnv);
    } else {
      proc = createNodeProcessAdapter(childRuntimePath, commandEnv);
    }
    const channel = {
      on(event: "message", listener: (message: unknown) => void) {
        proc!.on(event, listener);
      },
      send(frame: string) {
        proc!.postMessage(frame);
      },
    };
    let protectedStoreAttempts = 0;
    const authorityWaits: unknown[][] = [];
    let extensionLogArgs: unknown[] | undefined;
    const readyPromise = waitForMessage<{ ws: typeof channel; message: RpcRequest }>(
      (resolve, reject) => {
        const ws = channel;
        ws.on("message", (raw) => {
          try {
            const message = JSON.parse(String(raw)) as WsClientMessage;
            if (message.type === "ws:auth") {
              expect(message.token).toBe("test-token");
              ws.send(
                JSON.stringify({
                  type: "ws:auth-result",
                  success: true,
                  contractVersion: RPC_CONTRACT_VERSION,
                } satisfies WsServerMessage)
              );
              return;
            }
            if (message.type === "ws:route") {
              const envelope = message.envelope as RpcEnvelope | undefined;
              const rpc = envelope?.message as RpcMessage | undefined;
              if (!envelope || rpc?.type !== "request") return;
              if (rpc.method === "upsertImportJob") {
                protectedStoreAttempts += 1;
                const response: RpcResponse =
                  protectedStoreAttempts === 1
                    ? {
                        type: "response",
                        requestId: rpc.requestId,
                        error: "upsertImportJob: authority acquisition required",
                        errorKind: "access",
                        errorCode: "EACQUIRE",
                        errorData: {
                          acquisition: {
                            acquisitionId: "acq:browser-import",
                            ownerRuntimeId: "@workspace-extensions/process-test",
                          },
                        },
                      }
                    : {
                        type: "response",
                        requestId: rpc.requestId,
                        result: { jobId: "import-1", phase: "queued" },
                      };
                ws.send(
                  JSON.stringify({
                    type: "ws:routed",
                    envelope: makeEnvelope(envelope.target, envelope.from, "do", response),
                  } satisfies WsServerMessage)
                );
                return;
              }
              const response: RpcResponse = {
                type: "response",
                requestId: rpc.requestId,
                result: {
                  targetId: envelope.target,
                  method: rpc.method,
                  args: rpc.args,
                  parentRequestId: rpc.parentRequestId,
                },
              };
              ws.send(
                JSON.stringify({
                  type: "ws:routed",
                  envelope: makeEnvelope(envelope.target, envelope.from, "do", response),
                } satisfies WsServerMessage)
              );
              return;
            }
            if (message.type !== "ws:rpc") return;
            const envelope = message.envelope as RpcEnvelope | undefined;
            const rpc = envelope?.message as RpcMessage | undefined;
            if (!envelope || rpc?.type !== "request") return;
            const response: RpcResponse = {
              type: "response",
              requestId: rpc.requestId,
              result:
                rpc.method === "authority.awaitDecision"
                  ? (authorityWaits.push(rpc.args), { state: "decided" })
                  : null,
            };
            ws.send(
              JSON.stringify({
                type: "ws:rpc",
                envelope: makeEnvelope("main", envelope.from, "server", response),
              } satisfies WsServerMessage)
            );
            if (rpc.method === "runtime.supervision.appendLog") {
              extensionLogArgs = rpc.args;
            }
            if (rpc.method === "runtime.supervision.reportReady") {
              resolve({ ws, message: rpc });
            }
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
      }
    );

    const ready = await readyPromise;
    expect(ready.message.args[0]).toEqual({
      methods: [
        "ping",
        "replaceStorage",
        "sqliteStorage",
        "callerContext",
        "targetEcho",
        "structuredFailure",
      ],
      providerMethods: { gitInterop: ["providerPing"] },
      hasFetch: false,
    });
    expect(extensionLogArgs).toEqual([{ level: "info", message: "activated" }]);

    const importRequestId = randomUUID();
    const importResponse = await waitForMessage<RpcResponse>((resolve, reject) => {
      const onImportResponse = (raw: unknown) => {
        try {
          const message = JSON.parse(String(raw)) as WsClientMessage;
          if (message.type !== "ws:rpc") return;
          const rpc = message.envelope?.message as RpcMessage | undefined;
          if (rpc?.type === "response" && rpc.requestId === importRequestId) {
            proc!.off("message", onImportResponse);
            resolve(rpc);
          }
        } catch (err) {
          proc!.off("message", onImportResponse);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      };
      ready.ws.on("message", onImportResponse);
      ready.ws.send(
        JSON.stringify({
          type: "ws:rpc",
          envelope: makeEnvelope("main", "@workspace-extensions/process-test", "server", {
            type: "request",
            requestId: importRequestId,
            fromId: "main",
            method: "extension.invoke",
            args: [
              "targetEcho",
              [
                "do:workers/browser-data:BrowserDataDO:browser:user-1",
                "upsertImportJob",
                { jobId: "import-1", phase: "queued" },
              ],
              {
                requestId: importRequestId,
                extensionName: "@workspace-extensions/process-test",
                method: "providers.browserData.startImport",
                caller: { callerId: "panel:nav-a", callerKind: "panel", userId: "user-1" },
              },
            ],
          } satisfies RpcRequest),
        } satisfies WsServerMessage)
      );
    });

    expect(importResponse).toMatchObject({
      type: "response",
      requestId: importRequestId,
      result: { jobId: "import-1", phase: "queued" },
    });
    expect(authorityWaits).toEqual([[{ acquisitionId: "acq:browser-import" }]]);
    expect(protectedStoreAttempts).toBe(2);

    const requestId = randomUUID();
    const response = await waitForMessage<RpcResponse>((resolve, reject) => {
      ready.ws.on("message", (raw) => {
        try {
          const message = JSON.parse(String(raw)) as WsClientMessage;
          if (message.type !== "ws:rpc") return;
          const rpc = message.envelope?.message as RpcMessage | undefined;
          if (rpc?.type === "response" && rpc.requestId === requestId) {
            resolve(rpc);
          }
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
      ready.ws.send(
        JSON.stringify({
          type: "ws:rpc",
          envelope: makeEnvelope("main", "@workspace-extensions/process-test", "server", {
            type: "request",
            requestId,
            fromId: "main",
            method: "extension.invoke",
            args: [
              "ping",
              ["ok"],
              {
                requestId,
                extensionName: "@workspace-extensions/process-test",
                method: "ping",
                caller: { callerId: "test", callerKind: "shell" },
              },
            ],
          } satisfies RpcRequest),
        } satisfies WsServerMessage)
      );
    });

    expect(response).toEqual({
      type: "response",
      requestId,
      result: "pong:ok",
    });

    const storageRequestId = randomUUID();
    const storageResponse = await waitForMessage<RpcResponse>((resolve, reject) => {
      ready.ws.on("message", (raw) => {
        try {
          const message = JSON.parse(String(raw)) as WsClientMessage;
          if (message.type !== "ws:rpc") return;
          const rpc = message.envelope?.message as RpcMessage | undefined;
          if (rpc?.type === "response" && rpc.requestId === storageRequestId) resolve(rpc);
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
      ready.ws.send(
        JSON.stringify({
          type: "ws:rpc",
          envelope: makeEnvelope("main", "@workspace-extensions/process-test", "server", {
            type: "request",
            requestId: storageRequestId,
            fromId: "main",
            method: "extension.invoke",
            args: [
              "replaceStorage",
              ["durable"],
              {
                requestId: storageRequestId,
                extensionName: "@workspace-extensions/process-test",
                method: "replaceStorage",
                caller: { callerId: "test", callerKind: "shell" },
              },
            ],
          } satisfies RpcRequest),
        } satisfies WsServerMessage)
      );
    });
    expect(storageResponse).toEqual({
      type: "response",
      requestId: storageRequestId,
      result: "durable",
    });
    const storagePath = path.join(root, "storage", "atomic", "value.txt");
    expect(fs.readFileSync(storagePath, "utf8")).toBe("durable");
    if (process.platform !== "win32") expect(fs.statSync(storagePath).mode & 0o777).toBe(0o600);
    else expect(fs.statSync(storagePath).mode & 0o200).toBe(0o200);

    // The imported module executes in the real extension child. Its own HOME/storage
    // is writable; neither SQLite nor its ATTACH path may bypass the native policy.
    const sourceDatabase = path.join(extensionDir, "source-forbidden.sqlite");
    const sqliteRequestId = randomUUID();
    const sqliteResponse = await waitForMessage<RpcResponse>((resolve, reject) => {
      const onResponse = (raw: unknown) => {
        try {
          const message = JSON.parse(String(raw)) as WsClientMessage;
          if (message.type !== "ws:rpc") return;
          const rpc = message.envelope?.message;
          if (rpc?.type !== "response" || rpc.requestId !== sqliteRequestId) return;
          proc!.off("message", onResponse);
          resolve(rpc);
        } catch (error) {
          proc!.off("message", onResponse);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };
      ready.ws.on("message", onResponse);
      ready.ws.send(
        JSON.stringify({
          type: "ws:rpc",
          envelope: makeEnvelope("main", "@workspace-extensions/process-test", "server", {
            type: "request",
            requestId: sqliteRequestId,
            fromId: "main",
            method: "extension.invoke",
            args: [
              "sqliteStorage",
              [hostDatabase, sourceDatabase],
              {
                requestId: sqliteRequestId,
                extensionName: "@workspace-extensions/process-test",
                method: "sqliteStorage",
                caller: { callerId: "test", callerKind: "shell" },
              },
            ],
          } satisfies RpcRequest),
        } satisfies WsServerMessage)
      );
    });
    expect(sqliteResponse).toMatchObject({
      type: "response",
      requestId: sqliteRequestId,
      result: { updated: 1, stale: 0, row: { id: "model", revision: 2, value: "committed" } },
    });
    const isolated = mode === "native-workspace" && process.platform !== "win32";
    expect(sqliteResponse).toMatchObject({
      result: {
        host: { allowed: !isolated },
        source: { allowed: !isolated },
        attach: { allowed: !isolated },
        hostFs: { allowed: !isolated },
        sourceFs: { allowed: !isolated },
      },
    });
    for (const file of [sourceDatabase, sourceDatabase + ".fs"])
      expect(fs.existsSync(file)).toBe(!isolated);
    const retainedHost = new DatabaseSync(hostDatabase);
    try {
      expect(retainedHost.prepare("SELECT value, revision FROM records").get()).toEqual({
        value: "host-only",
        revision: isolated ? 1 : 3,
      });
    } finally {
      retainedHost.close();
    }
    expect(fs.readFileSync(hostDatabase + ".fs", "utf8")).toBe(
      isolated ? "host-only" : "forbidden"
    );
    expect(fs.existsSync(path.join(root, "storage", "records.sqlite"))).toBe(true);

    const providerRequestId = randomUUID();
    const providerResponse = await waitForMessage<RpcResponse>((resolve, reject) => {
      ready.ws.on("message", (raw) => {
        try {
          const message = JSON.parse(String(raw)) as WsClientMessage;
          if (message.type !== "ws:rpc") return;
          const rpc = message.envelope?.message as RpcMessage | undefined;
          if (rpc?.type === "response" && rpc.requestId === providerRequestId) resolve(rpc);
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
      ready.ws.send(
        JSON.stringify({
          type: "ws:rpc",
          envelope: makeEnvelope("main", "@workspace-extensions/process-test", "server", {
            type: "request",
            requestId: providerRequestId,
            fromId: "main",
            method: "extension.invokeProvider",
            args: [
              "gitInterop",
              "providerPing",
              ["ok"],
              {
                requestId: providerRequestId,
                extensionName: "@workspace-extensions/process-test",
                method: "providers.gitInterop.providerPing",
                caller: { callerId: "server", callerKind: "server" },
              },
            ],
          } satisfies RpcRequest),
        } satisfies WsServerMessage)
      );
    });

    expect(providerResponse).toEqual({
      type: "response",
      requestId: providerRequestId,
      result: "provider-pong:ok",
    });

    const flatProviderRequestId = randomUUID();
    const flatProviderResponse = await waitForMessage<RpcResponse>((resolve, reject) => {
      ready.ws.on("message", (raw) => {
        try {
          const message = JSON.parse(String(raw)) as WsClientMessage;
          if (message.type !== "ws:rpc") return;
          const rpc = message.envelope?.message as RpcMessage | undefined;
          if (rpc?.type === "response" && rpc.requestId === flatProviderRequestId) resolve(rpc);
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
      ready.ws.send(
        JSON.stringify({
          type: "ws:rpc",
          envelope: makeEnvelope("main", "@workspace-extensions/process-test", "server", {
            type: "request",
            requestId: flatProviderRequestId,
            fromId: "main",
            method: "extension.invoke",
            args: [
              "providerPing",
              ["bypass"],
              {
                requestId: flatProviderRequestId,
                extensionName: "@workspace-extensions/process-test",
                method: "providerPing",
                caller: { callerId: "server", callerKind: "server" },
              },
            ],
          } satisfies RpcRequest),
        } satisfies WsServerMessage)
      );
    });

    expect(flatProviderResponse).toMatchObject({
      type: "response",
      requestId: flatProviderRequestId,
      errorCode: "ENOMETHOD",
    });

    const directRequestId = randomUUID();
    const directResponse = await waitForMessage<RpcResponse>((resolve, reject) => {
      ready.ws.on("message", (raw) => {
        try {
          const message = JSON.parse(String(raw)) as WsClientMessage;
          if (message.type !== "ws:rpc") return;
          const rpc = message.envelope?.message as RpcMessage | undefined;
          if (rpc?.type === "response" && rpc.requestId === directRequestId) {
            resolve(rpc);
          }
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
      ready.ws.send(
        JSON.stringify({
          type: "ws:rpc",
          envelope: {
            from: "main",
            target: "@workspace-extensions/process-test",
            delivery: { caller: { callerId: "panel-1", callerKind: "panel" } },
            provenance: [{ callerId: "panel-1", callerKind: "panel" }],
            message: {
              type: "request",
              requestId: directRequestId,
              fromId: "main",
              method: "extension.invoke",
              args: [
                "ping",
                ["bypass"],
                {
                  requestId: directRequestId,
                  extensionName: "@workspace-extensions/process-test",
                  method: "ping",
                  caller: { callerId: "panel-1", callerKind: "panel" },
                },
              ],
            } satisfies RpcRequest,
          } satisfies RpcEnvelope,
        } satisfies WsServerMessage)
      );
    });

    expect(directResponse).toMatchObject({
      type: "response",
      requestId: directRequestId,
      errorCode: "EACCES",
      error: expect.stringContaining("trusted host principal"),
    });

    const serverTargetRequestId = randomUUID();
    const serverTargetRequest: RpcRequest = {
      type: "request",
      requestId: serverTargetRequestId,
      fromId: "server",
      method: "extension.invoke",
      args: [
        "ping",
        ["server-ok"],
        {
          requestId: serverTargetRequestId,
          extensionName: "@workspace-extensions/process-test",
          method: "ping",
          caller: { callerId: "server", callerKind: "server" },
        },
      ],
    };
    const serverTargetEnvelope: RpcEnvelope = {
      from: "server",
      target: "@workspace-extensions/process-test",
      delivery: { caller: { callerId: "server", callerKind: "server" } },
      provenance: [{ callerId: "server", callerKind: "server" }],
      message: serverTargetRequest,
    };
    const serverTargetResponse = await waitForMessage<WsRpcResponseMessage>((resolve, reject) => {
      ready.ws.on("message", (raw) => {
        try {
          const message = JSON.parse(String(raw)) as WsRpcResponseMessage;
          const rpc = message.envelope?.message;
          if (rpc?.type === "response" && rpc.requestId === serverTargetRequestId) {
            resolve(message);
          }
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
      ready.ws.send(
        JSON.stringify({
          type: "ws:rpc",
          envelope: serverTargetEnvelope,
        } satisfies WsServerMessage)
      );
    });

    expect(serverTargetResponse).toMatchObject({
      type: "ws:rpc",
      envelope: {
        target: "server",
        message: {
          type: "response",
          requestId: serverTargetRequestId,
          result: "pong:server-ok",
        },
      },
    });

    const contextRequestId = randomUUID();
    const contextResponse = await waitForMessage<RpcResponse>((resolve, reject) => {
      ready.ws.on("message", (raw) => {
        try {
          const message = JSON.parse(String(raw)) as WsClientMessage;
          if (message.type !== "ws:rpc") return;
          const rpc = message.envelope?.message as RpcMessage | undefined;
          if (rpc?.type === "response" && rpc.requestId === contextRequestId) {
            resolve(rpc);
          }
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
      ready.ws.send(
        JSON.stringify({
          type: "ws:rpc",
          envelope: makeEnvelope("main", "@workspace-extensions/process-test", "server", {
            type: "request",
            requestId: contextRequestId,
            fromId: "main",
            method: "extension.invoke",
            args: [
              "callerContext",
              [],
              {
                requestId: contextRequestId,
                extensionName: "@workspace-extensions/process-test",
                method: "callerContext",
                caller: { callerId: "panel-1", callerKind: "panel", contextId: "ctx-panel" },
                chainCaller: {
                  callerId: "panel-1",
                  callerKind: "panel",
                  repoPath: "panels/test",
                  effectiveVersion: "ev-test",
                  contextId: "ctx-panel",
                },
              },
            ],
          } satisfies RpcRequest),
        } satisfies WsServerMessage)
      );
    });

    expect(contextResponse).toEqual({
      type: "response",
      requestId: contextRequestId,
      result: "ctx-panel",
    });

    const structuredFailureRequestId = randomUUID();
    const structuredFailureResponse = await waitForMessage<RpcResponse>((resolve, reject) => {
      ready.ws.on("message", (raw) => {
        try {
          const message = JSON.parse(String(raw)) as WsClientMessage;
          if (message.type !== "ws:rpc") return;
          const rpc = message.envelope?.message as RpcMessage | undefined;
          if (rpc?.type === "response" && rpc.requestId === structuredFailureRequestId) {
            resolve(rpc);
          }
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
      ready.ws.send(
        JSON.stringify({
          type: "ws:rpc",
          envelope: makeEnvelope("main", "@workspace-extensions/process-test", "server", {
            type: "request",
            requestId: structuredFailureRequestId,
            fromId: "main",
            method: "extension.invoke",
            args: [
              "structuredFailure",
              [],
              {
                requestId: structuredFailureRequestId,
                extensionName: "@workspace-extensions/process-test",
                method: "structuredFailure",
                caller: { callerId: "panel-1", callerKind: "panel" },
              },
            ],
          } satisfies RpcRequest),
        } satisfies WsServerMessage)
      );
    });

    expect(structuredFailureResponse).toMatchObject({
      type: "response",
      requestId: structuredFailureRequestId,
      errorCode: "EACQUIRE",
      errorKind: "access",
      errorData: { acquisition: { id: "acq-child", ownerRuntimeId: "panel-1" } },
    });

    const targetRequestId = randomUUID();
    const targetResponse = await waitForMessage<RpcResponse>((resolve, reject) => {
      ready.ws.on("message", (raw) => {
        try {
          const message = JSON.parse(String(raw)) as WsClientMessage;
          if (message.type !== "ws:rpc") return;
          const rpc = message.envelope?.message as RpcMessage | undefined;
          if (rpc?.type === "response" && rpc.requestId === targetRequestId) {
            resolve(rpc);
          }
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
      ready.ws.send(
        JSON.stringify({
          type: "ws:rpc",
          envelope: makeEnvelope("main", "@workspace-extensions/process-test", "server", {
            type: "request",
            requestId: targetRequestId,
            fromId: "main",
            method: "extension.invoke",
            args: [
              "targetEcho",
              ["do:workers/example:ExampleDO:object-1", "lookup", "value"],
              {
                requestId: targetRequestId,
                extensionName: "@workspace-extensions/process-test",
                method: "targetEcho",
                caller: { callerId: "test", callerKind: "shell" },
              },
            ],
          } satisfies RpcRequest),
        } satisfies WsServerMessage)
      );
    });

    expect(targetResponse).toEqual({
      type: "response",
      requestId: targetRequestId,
      result: {
        targetId: "do:workers/example:ExampleDO:object-1",
        method: "lookup",
        args: ["value"],
        parentRequestId: targetRequestId,
      },
    });

    const child = proc!;
    let exited = false;
    const exit = new Promise<void>((resolve) =>
      child.on("exit", () => {
        exited = true;
        resolve();
      })
    );
    const control = (type: string, requestId?: string) =>
      waitForMessage<Record<string, unknown>>((resolve) => {
        const receive = (raw: unknown) => {
          if (!raw || typeof raw !== "object" || !("type" in raw) || raw.type !== type) return;
          if (requestId && (!("requestId" in raw) || raw.requestId !== requestId)) return;
          child.off("message", receive);
          resolve(raw as Record<string, unknown>);
        };
        child.on("message", receive);
      });
    const firstId = randomUUID();
    let acknowledged = false;
    const firstResult = control("shutdown-result", firstId).then((result) => {
      acknowledged = true;
      return result;
    });
    const firstStarted = control("fixture-dispose-started");
    child.postMessage({ type: "shutdown", requestId: firstId });
    expect(await firstStarted).toMatchObject({ attempt: 1 });
    expect(acknowledged).toBe(false);
    expect(exited).toBe(false);
    child.postMessage({ type: "fixture-release" });
    expect(await firstResult).toMatchObject({
      ok: false,
      error: {
        message: "Owned release failed",
        cause: { message: "Original provider release failed" },
        errors: [
          { message: "Original provider release failed" },
          { message: "Independent cleanup failed" },
        ],
      },
    });
    expect(exited).toBe(false);
    const secondId = randomUUID();
    const secondResult = control("shutdown-result", secondId);
    const secondStarted = control("fixture-dispose-started");
    child.postMessage({ type: "shutdown", requestId: secondId });
    expect(await secondStarted).toMatchObject({ attempt: 2 });
    expect(exited).toBe(false);
    child.postMessage({ type: "fixture-release" });
    expect(await secondResult).toMatchObject({ ok: true });
    await exit;
    proc = null; // The test joined its exact child; afterEach owns only the sandbox now.
  });
});
