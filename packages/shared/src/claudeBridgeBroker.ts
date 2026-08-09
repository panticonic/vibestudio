import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { z } from "zod";

export const CLAUDE_BRIDGE_BROKER_PROTOCOL = "vibestudio.claude-bridge-broker.v1" as const;
export const CLAUDE_BRIDGE_MAX_FRAME_BYTES = 1024 * 1024;

const shortString = z.string().min(1).max(1024);
const text = z.string().max(256 * 1024);
const requestId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

export type ClaudeBridgeJson =
  | null
  | boolean
  | number
  | string
  | ClaudeBridgeJson[]
  | { [key: string]: ClaudeBridgeJson };

const jsonValue: z.ZodType<ClaudeBridgeJson> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValue),
    z.record(jsonValue),
  ])
);

const hookEvent = z.discriminatedUnion("hook", [
  z
    .object({
      hook: z.literal("SessionStart"),
      model: shortString.optional(),
      cwd: text.optional(),
    })
    .strict(),
  z
    .object({ hook: z.literal("UserPromptSubmit"), promptText: text, turnKey: shortString })
    .strict(),
  z
    .object({
      hook: z.literal("PreToolUse"),
      toolName: shortString,
      toolUseId: shortString,
      request: jsonValue.optional(),
    })
    .strict(),
  z
    .object({
      hook: z.literal("PostToolUse"),
      toolUseId: shortString,
      toolName: shortString.optional(),
      ok: z.boolean(),
      outputSummary: text.optional(),
    })
    .strict(),
  z
    .object({
      hook: z.literal("PostToolUseFailure"),
      toolUseId: shortString,
      toolName: shortString.optional(),
      error: text,
    })
    .strict(),
  z.object({ hook: z.literal("Stop"), finalText: text.optional(), turnKey: shortString }).strict(),
  z
    .object({
      hook: z.literal("StopFailure"),
      error: shortString,
      errorDetails: text.optional(),
      turnKey: shortString,
    })
    .strict(),
  z.object({ hook: z.literal("SessionEnd") }).strict(),
]);

const operations = {
  openBridge: z
    .object({
      bridgeSessionId: shortString,
      sessionInfo: z
        .object({
          bridge: shortString,
          mode: z.literal("launched"),
          pid: z.number().int().positive(),
          agentKind: z.literal("claude-code"),
          channelReadiness: z
            .object({
              mcpTransport: z.literal("initialized"),
              channelRegistration: z.literal("unconfirmed"),
              reason: z.literal("claude-protocol-has-no-registration-ack"),
            })
            .strict(),
        })
        .strict(),
    })
    .strict(),
  say: z
    .object({
      text,
      mentions: z.array(shortString).max(64).optional(),
      idempotencyKey: shortString,
    })
    .strict(),
  complete: z.object({ report: text, outcome: z.enum(["success", "failed"]) }).strict(),
  requestPermission: z
    .object({
      requestId: z.string().regex(/^[a-km-z]{5}$/),
      toolName: shortString,
      description: z.string().max(4096),
      inputPreview: z.string().max(64 * 1024),
    })
    .strict(),
  acceptDelivery: z
    .object({
      bridgeSessionId: shortString,
      attachmentGeneration: shortString,
      deliveryId: shortString,
      batchId: shortString,
    })
    .strict(),
  ingestHookEvent: z
    .object({
      bridgeSessionId: shortString,
      seq: z.number().int().positive(),
      batchId: shortString.optional(),
      interruptedBatchId: shortString.optional(),
      event: hookEvent,
    })
    .strict(),
  listSkills: z.object({}).strict(),
  readSkill: z.object({ name: shortString }).strict(),
  linkedStatus: z.object({}).strict(),
} as const;

export type ClaudeBridgeOperation = keyof typeof operations;
export type ClaudeBridgeOperationInput<K extends ClaudeBridgeOperation> = z.infer<
  (typeof operations)[K]
>;

const bridgePayload = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.enum(["message", "prompt"]),
      seq: z.number().int().nonnegative(),
      deliveryId: shortString,
      bridgeSessionId: shortString,
      attachmentGeneration: shortString,
      channelId: shortString.optional(),
      content: text,
      triggerMessageId: shortString.optional(),
      meta: z.record(jsonValue),
    })
    .strict(),
  z
    .object({
      kind: z.literal("permission"),
      requestId: shortString,
      behavior: z.enum(["allow", "deny"]),
      reason: shortString.optional(),
    })
    .strict(),
  z.object({ kind: z.literal("interrupt") }).strict(),
]);

export type ClaudeBridgePayload = z.infer<typeof bridgePayload>;
export type ClaudeBridgeStreamRecord =
  | {
      kind: "subscribed";
      result: {
        ok: true;
        bridgeSessionId: string;
        attachmentGeneration: string;
        pendingCount: number;
        primaryChannelId: string | null;
        contextId: string | null;
        channelIds: string[];
      };
    }
  | { kind: "event"; payload: ClaudeBridgePayload };

const streamRecord = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("subscribed"),
      result: z
        .object({
          ok: z.literal(true),
          bridgeSessionId: shortString,
          attachmentGeneration: shortString,
          pendingCount: z.number().int().nonnegative(),
          primaryChannelId: shortString.nullable(),
          contextId: shortString.nullable(),
          channelIds: z.array(shortString),
        })
        .strict(),
    })
    .strict(),
  z.object({ kind: z.literal("event"), payload: bridgePayload }).strict(),
]);

const requestFrame = z
  .object({
    type: z.literal("request"),
    id: requestId,
    operation: z.enum(
      Object.keys(operations) as [ClaudeBridgeOperation, ...ClaudeBridgeOperation[]]
    ),
    payload: jsonValue,
  })
  .strict();
const cancelFrame = z.object({ type: z.literal("cancel"), id: requestId }).strict();
const helloFrame = z
  .object({
    type: z.literal("hello"),
    protocol: z.literal(CLAUDE_BRIDGE_BROKER_PROTOCOL),
    generation: shortString,
  })
  .strict();
const clientFrame = z.discriminatedUnion("type", [helloFrame, requestFrame, cancelFrame]);

const serverFrame = z.union([
  z
    .object({
      type: z.literal("ready"),
      protocol: z.literal(CLAUDE_BRIDGE_BROKER_PROTOCOL),
      generation: shortString,
    })
    .strict(),
  z
    .object({ type: z.literal("response"), id: requestId, ok: z.literal(true), result: jsonValue })
    .strict(),
  z
    .object({
      type: z.literal("response"),
      id: requestId,
      ok: z.literal(false),
      error: z.string().min(1).max(4096),
    })
    .strict(),
  z.object({ type: z.literal("streamStart"), id: requestId }).strict(),
  z.object({ type: z.literal("streamRecord"), id: requestId, record: streamRecord }).strict(),
  z
    .object({
      type: z.literal("streamEnd"),
      id: requestId,
      ok: z.boolean(),
      error: z.string().min(1).max(4096).optional(),
    })
    .strict(),
  z.object({ type: z.literal("recovery") }).strict(),
]);

export interface ClaudeBridgeAuthority {
  openBridge(
    input: ClaudeBridgeOperationInput<"openBridge">,
    signal: AbortSignal
  ): AsyncIterable<ClaudeBridgeStreamRecord>;
  say(input: ClaudeBridgeOperationInput<"say">): Promise<ClaudeBridgeJson>;
  complete(input: ClaudeBridgeOperationInput<"complete">): Promise<ClaudeBridgeJson>;
  requestPermission(
    input: ClaudeBridgeOperationInput<"requestPermission">
  ): Promise<ClaudeBridgeJson>;
  acceptDelivery(input: ClaudeBridgeOperationInput<"acceptDelivery">): Promise<ClaudeBridgeJson>;
  ingestHookEvent(input: ClaudeBridgeOperationInput<"ingestHookEvent">): Promise<ClaudeBridgeJson>;
  listSkills(): Promise<ClaudeBridgeJson>;
  readSkill(input: ClaudeBridgeOperationInput<"readSkill">): Promise<ClaudeBridgeJson>;
  linkedStatus(): Promise<ClaudeBridgeJson>;
  onRecovery(handler: () => void | Promise<void>): Promise<() => void>;
  close(): Promise<void>;
}

function boundedLineReader(
  socket: net.Socket,
  onFrame: (value: unknown) => void,
  onError: (error: Error) => void
): void {
  let buffered = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    for (;;) {
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) {
        if (buffered.byteLength > CLAUDE_BRIDGE_MAX_FRAME_BYTES) {
          onError(new Error("Claude bridge broker frame exceeds byte limit"));
        }
        return;
      }
      if (newline + 1 > CLAUDE_BRIDGE_MAX_FRAME_BYTES) {
        onError(new Error("Claude bridge broker frame exceeds byte limit"));
        return;
      }
      const line = buffered.subarray(0, newline);
      buffered = buffered.subarray(newline + 1);
      if (line.byteLength === 0) continue;
      try {
        onFrame(JSON.parse(line.toString("utf8")));
      } catch {
        onError(new Error("Claude bridge broker received malformed JSON"));
        return;
      }
    }
  });
}

function writeFrame(socket: net.Socket, frame: unknown): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(frame)}\n`, "utf8");
  if (bytes.byteLength > CLAUDE_BRIDGE_MAX_FRAME_BYTES) {
    return Promise.reject(new Error("Claude bridge broker response exceeds byte limit"));
  }
  return new Promise((resolve, reject) => {
    socket.write(bytes, (error) => (error ? reject(error) : resolve()));
  });
}

export interface ClaudeBridgeBroker {
  socketPath: string;
  generation: string;
  close(): Promise<void>;
}

export async function startClaudeBridgeBroker(input: {
  socketPath: string;
  generation: string;
  authority: ClaudeBridgeAuthority;
}): Promise<ClaudeBridgeBroker> {
  const socketPath = path.resolve(input.socketPath);
  const generation = shortString.parse(input.generation);
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(socketPath), 0o700);
  fs.rmSync(socketPath, { force: true });
  const sockets = new Set<net.Socket>();
  const streamControllers = new Set<AbortController>();
  const streamTasks = new Set<Promise<void>>();
  const requestTasks = new Set<Promise<void>>();
  const recoveryTasks = new Set<Promise<void>>();
  let activeBridgeController: AbortController | null = null;
  let closed = false;
  let removeRecovery: (() => void) | undefined;
  let authorityClosed: Promise<void> | null = null;
  const closeAuthority = (): Promise<void> => {
    authorityClosed ??= input.authority.close();
    return authorityClosed;
  };
  const server = net.createServer((socket) => {
    if (closed) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    const streams = new Map<string, AbortController>();
    let authenticated = false;
    let chain = Promise.resolve();
    const fail = (error: Error): void => {
      socket.destroy(error);
    };
    const handle = async (raw: unknown): Promise<void> => {
      if (closed || socket.destroyed) throw new Error("Claude bridge broker connection is closed");
      const frame = clientFrame.parse(raw);
      if (!authenticated) {
        if (frame.type !== "hello" || frame.generation !== generation)
          throw new Error("Claude bridge broker generation mismatch");
        authenticated = true;
        await writeFrame(socket, {
          type: "ready",
          protocol: CLAUDE_BRIDGE_BROKER_PROTOCOL,
          generation,
        });
        return;
      }
      if (frame.type === "hello") throw new Error("Claude bridge broker received duplicate hello");
      if (frame.type === "cancel") {
        streams.get(frame.id)?.abort();
        return;
      }
      const schema = operations[frame.operation];
      const payload = schema.parse(frame.payload) as never;
      if (frame.operation === "openBridge") {
        if (activeBridgeController)
          throw new Error("Claude bridge broker permits one openBridge stream");
        const controller = new AbortController();
        activeBridgeController = controller;
        streams.set(frame.id, controller);
        streamControllers.add(controller);
        await writeFrame(socket, { type: "streamStart", id: frame.id });
        const task = (async () => {
          try {
            for await (const record of input.authority.openBridge(payload, controller.signal)) {
              const exact = streamRecord.parse(record);
              await writeFrame(socket, { type: "streamRecord", id: frame.id, record: exact });
            }
            await writeFrame(socket, { type: "streamEnd", id: frame.id, ok: true });
          } catch (error) {
            if (!closed && !socket.destroyed) {
              await writeFrame(socket, {
                type: "streamEnd",
                id: frame.id,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              }).catch(() => undefined);
            }
          } finally {
            streams.delete(frame.id);
            streamControllers.delete(controller);
            if (activeBridgeController === controller) activeBridgeController = null;
          }
        })();
        streamTasks.add(task);
        void task.finally(() => streamTasks.delete(task));
        return;
      }
      try {
        let result: ClaudeBridgeJson;
        switch (frame.operation) {
          case "say":
            result = await input.authority.say(payload);
            break;
          case "complete":
            result = await input.authority.complete(payload);
            break;
          case "requestPermission":
            result = await input.authority.requestPermission(payload);
            break;
          case "acceptDelivery":
            result = await input.authority.acceptDelivery(payload);
            break;
          case "ingestHookEvent":
            result = await input.authority.ingestHookEvent(payload);
            break;
          case "listSkills":
            result = await input.authority.listSkills();
            break;
          case "readSkill":
            result = await input.authority.readSkill(payload);
            break;
          case "linkedStatus":
            result = await input.authority.linkedStatus();
            break;
        }
        await writeFrame(socket, {
          type: "response",
          id: frame.id,
          ok: true,
          result: jsonValue.parse(result),
        });
      } catch (error) {
        await writeFrame(socket, {
          type: "response",
          id: frame.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    boundedLineReader(
      socket,
      (raw) => {
        const task = chain.then(() => handle(raw)).catch(fail);
        chain = task;
        requestTasks.add(task);
        void task.finally(() => requestTasks.delete(task));
      },
      fail
    );
    socket.on("close", () => {
      sockets.delete(socket);
      for (const controller of streams.values()) controller.abort();
      streams.clear();
    });
    socket.on("error", () => undefined);
  });
  const closeServer = async (): Promise<void> => {
    if (!server.listening) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        try {
          fs.chmodSync(socketPath, 0o600);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    removeRecovery = await input.authority.onRecovery(async () => {
      const task = Promise.all(
        [...sockets].map(async (socket) => {
          await writeFrame(socket, { type: "recovery" }).catch(() => socket.destroy());
        })
      ).then(() => undefined);
      recoveryTasks.add(task);
      try {
        await task;
      } finally {
        recoveryTasks.delete(task);
      }
    });
  } catch (error) {
    closed = true;
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await closeServer();
    fs.rmSync(socketPath, { force: true });
    await closeAuthority().catch(() => undefined);
    throw error;
  }
  return {
    socketPath,
    generation,
    close: async () => {
      if (closed) return;
      closed = true;
      let closeError: unknown;
      try {
        removeRecovery?.();
      } catch (error) {
        closeError = error;
      }
      for (const controller of streamControllers) controller.abort();
      streamControllers.clear();
      activeBridgeController = null;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      try {
        await closeAuthority();
      } catch (error) {
        closeError ??= error;
      }
      await Promise.allSettled([...requestTasks, ...streamTasks, ...recoveryTasks]);
      await closeServer();
      fs.rmSync(socketPath, { force: true });
      if (closeError) throw closeError;
    },
  };
}

interface PendingRequest {
  resolve(value: ClaudeBridgeJson): void;
  reject(error: Error): void;
}
interface PendingStream {
  queue: ClaudeBridgeStreamRecord[];
  waiters: Array<() => void>;
  ended: boolean;
  error?: Error;
}

export class ClaudeBridgeBrokerClient {
  private readonly socket: net.Socket;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly streams = new Map<string, PendingStream>();
  private readonly recoveryHandlers = new Set<() => void | Promise<void>>();
  private nextId = 0;
  private ready: Promise<void>;
  private rejectReady!: (error: Error) => void;
  private readySettled = false;
  private closed = false;

  constructor(
    readonly socketPath: string,
    readonly generation: string
  ) {
    this.socket = net.connect(socketPath);
    this.ready = new Promise<void>((resolve, reject) => {
      this.rejectReady = reject;
      const fail = (error: Error): void => reject(error);
      this.socket.once("error", fail);
      boundedLineReader(
        this.socket,
        (raw) => {
          try {
            const frame = serverFrame.parse(raw);
            if (frame.type === "ready") {
              if (frame.generation !== generation)
                throw new Error("Claude bridge broker acknowledged another generation");
              this.socket.off("error", fail);
              this.readySettled = true;
              resolve();
              return;
            }
            this.handle(frame);
          } catch (error) {
            this.fail(error instanceof Error ? error : new Error(String(error)));
          }
        },
        (error) => this.fail(error)
      );
      this.socket.once(
        "connect",
        () =>
          void writeFrame(this.socket, {
            type: "hello",
            protocol: CLAUDE_BRIDGE_BROKER_PROTOCOL,
            generation,
          }).catch((error) => this.fail(error))
      );
    });
    this.socket.on("close", () => this.fail(new Error("Claude bridge broker closed")));
    this.socket.on("error", () => undefined);
  }

  private handle(frame: z.infer<typeof serverFrame>): void {
    if (frame.type === "recovery") {
      for (const handler of this.recoveryHandlers) {
        void Promise.resolve()
          .then(() => handler())
          .catch((error) => this.fail(error instanceof Error ? error : new Error(String(error))));
      }
      return;
    }
    if (frame.type === "response") {
      const pending = this.pending.get(frame.id);
      if (!pending) throw new Error(`Claude bridge broker returned unknown request ${frame.id}`);
      this.pending.delete(frame.id);
      frame.ok ? pending.resolve(frame.result) : pending.reject(new Error(frame.error));
      return;
    }
    if (frame.type === "streamStart") {
      if (!this.streams.has(frame.id)) {
        throw new Error(`Claude bridge broker returned unknown stream ${frame.id}`);
      }
      return;
    }
    if (frame.type === "streamRecord") {
      const stream = this.streams.get(frame.id);
      if (!stream) throw new Error(`Claude bridge broker returned unknown stream ${frame.id}`);
      stream.queue.push(frame.record);
      stream.waiters.splice(0).forEach((wake) => wake());
      return;
    }
    if (frame.type === "streamEnd") {
      const stream = this.streams.get(frame.id);
      if (!stream) return;
      stream.ended = true;
      if (!frame.ok) stream.error = new Error(frame.error ?? "Claude bridge stream failed");
      stream.waiters.splice(0).forEach((wake) => wake());
    }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    if (!this.readySettled) {
      this.readySettled = true;
      this.rejectReady(error);
    }
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const stream of this.streams.values()) {
      stream.error = error;
      stream.ended = true;
      stream.waiters.splice(0).forEach((wake) => wake());
    }
    this.socket.destroy();
  }

  private id(): string {
    return `r${++this.nextId}`;
  }

  async call<K extends Exclude<ClaudeBridgeOperation, "openBridge">>(
    operation: K,
    payload: ClaudeBridgeOperationInput<K>
  ): Promise<ClaudeBridgeJson> {
    const exactPayload = operations[operation].parse(payload);
    await this.ready;
    if (this.closed) throw new Error("Claude bridge broker client is closed");
    const id = this.id();
    const result = new Promise<ClaudeBridgeJson>((resolve, reject) =>
      this.pending.set(id, { resolve, reject })
    );
    try {
      await writeFrame(this.socket, { type: "request", id, operation, payload: exactPayload });
    } catch (error) {
      this.pending.delete(id);
      throw error;
    }
    return await result;
  }

  async *openBridge(
    payload: ClaudeBridgeOperationInput<"openBridge">,
    signal: AbortSignal
  ): AsyncIterable<ClaudeBridgeStreamRecord> {
    const exactPayload = operations.openBridge.parse(payload);
    await this.ready;
    if (this.closed) throw new Error("Claude bridge broker client is closed");
    if (signal.aborted) return;
    const id = this.id();
    const stream: PendingStream = { queue: [], waiters: [], ended: false };
    this.streams.set(id, stream);
    const abort = (): void => {
      void writeFrame(this.socket, { type: "cancel", id }).catch(() => undefined);
      stream.queue.length = 0;
      stream.ended = true;
      stream.waiters.splice(0).forEach((wake) => wake());
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      await writeFrame(this.socket, {
        type: "request",
        id,
        operation: "openBridge",
        payload: exactPayload,
      });
      for (;;) {
        if (stream.queue.length) {
          yield stream.queue.shift()!;
          continue;
        }
        if (stream.ended) {
          if (stream.error) throw stream.error;
          return;
        }
        await new Promise<void>((resolve) => stream.waiters.push(resolve));
      }
    } finally {
      signal.removeEventListener("abort", abort);
      this.streams.delete(id);
      if (!stream.ended) abort();
    }
  }

  async onRecovery(handler: () => void | Promise<void>): Promise<() => void> {
    await this.ready;
    this.recoveryHandlers.add(handler);
    return () => this.recoveryHandlers.delete(handler);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    const readySettled = this.ready.catch(() => undefined);
    this.fail(new Error("Claude bridge broker client closed"));
    await readySettled;
  }
}
