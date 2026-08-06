import { base64ToBytes } from "@vibestudio/rpc";

const RECEIVE_CAP_BYTES = 8 * 1024 * 1024;
const MAX_OPEN_UPLOADS = 128;

type Entry = {
  stream: ReadableStream<Uint8Array>;
  controller: ReadableStreamDefaultController<Uint8Array>;
  nextSeq: number;
  taken: boolean;
  terminal: boolean;
  drain: { resolve: () => void; reject: (error: Error) => void } | null;
};

/** Connection-scoped request-body streams for the ordered loopback WS wire. */
export class WsUploadBodies {
  private readonly entries = new Map<string, Entry>();

  open(requestId: string): void {
    if (this.entries.has(requestId)) {
      throw new Error(`Upload request id ${requestId} was reused`);
    }
    if (this.entries.size >= MAX_OPEN_UPLOADS) {
      throw new Error(`Too many open WebSocket uploads (limit ${MAX_OPEN_UPLOADS})`);
    }
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const entry = {} as Entry;
    const stream = new ReadableStream<Uint8Array>(
      {
        start(next) {
          controller = next;
        },
        pull() {
          const drain = entry.drain;
          entry.drain = null;
          drain?.resolve();
        },
        cancel: () => {
          entry.terminal = true;
          const drain = entry.drain;
          entry.drain = null;
          drain?.reject(new Error(`Upload request ${requestId} body consumer cancelled`));
          this.maybeDelete(requestId, entry);
        },
      },
      {
        highWaterMark: RECEIVE_CAP_BYTES,
        size: (chunk) => chunk.byteLength,
      }
    );
    Object.assign(entry, {
      stream,
      controller,
      nextSeq: 0,
      taken: false,
      terminal: false,
      drain: null,
    } satisfies Entry);
    this.entries.set(requestId, entry);
  }

  take(requestId: string): ReadableStream<Uint8Array> | undefined {
    const entry = this.entries.get(requestId);
    if (!entry || entry.taken) return undefined;
    entry.taken = true;
    this.maybeDelete(requestId, entry);
    return entry.stream;
  }

  async push(input: {
    requestId: string;
    seq: number;
    payload?: string;
    done?: boolean;
    error?: string;
  }): Promise<void> {
    const entry = this.entries.get(input.requestId);
    if (!entry) throw new Error(`Unknown upload request ${input.requestId}`);
    if (entry.terminal) throw new Error(`Upload request ${input.requestId} is already closed`);
    if (input.seq !== entry.nextSeq) {
      throw new Error(
        `Upload request ${input.requestId} expected chunk ${entry.nextSeq}, got ${input.seq}`
      );
    }
    entry.nextSeq += 1;
    if (input.error) {
      this.fail(input.requestId, new Error(input.error));
      return;
    }
    if (input.done) {
      entry.terminal = true;
      entry.controller.close();
      this.maybeDelete(input.requestId, entry);
      return;
    }
    if (typeof input.payload !== "string") {
      throw new Error(`Upload request ${input.requestId} chunk ${input.seq} has no payload`);
    }
    entry.controller.enqueue(base64ToBytes(input.payload));
    if ((entry.controller.desiredSize ?? 1) <= 0) {
      await new Promise<void>((resolve, reject) => {
        entry.drain = { resolve, reject };
      });
    }
  }

  fail(requestId: string, error: Error): void {
    const entry = this.entries.get(requestId);
    if (!entry) return;
    entry.terminal = true;
    this.entries.delete(requestId);
    const drain = entry.drain;
    entry.drain = null;
    drain?.reject(error);
    try {
      entry.controller.error(error);
    } catch {
      // already closed/cancelled
    }
  }

  closeAll(error: Error): void {
    for (const requestId of [...this.entries.keys()]) this.fail(requestId, error);
  }

  private maybeDelete(requestId: string, entry: Entry): void {
    if (entry.taken && entry.terminal && this.entries.get(requestId) === entry) {
      this.entries.delete(requestId);
    }
  }
}
