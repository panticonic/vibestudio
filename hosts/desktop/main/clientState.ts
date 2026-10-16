import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

/** What a client keeps: one JSON object, persisted per client on this device. */
export type ClientStateValue = { [key: string]: unknown };

/** A client's state is small preferences and ids, not a database. */
export const CLIENT_STATE_MAX_BYTES = 64 * 1024;

function isRecord(value: unknown): value is ClientStateValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Client-scoped persisted state for `web-host-1` (`__vibestudioClient.state`),
 * the desktop counterpart of the terminal host's `host.state`. One file per
 * client under the host's state root; every write is atomic and bounded.
 */
export class ClientStateStore {
  constructor(private readonly root: string) {}

  private file(clientId: string): string {
    return path.join(this.root, encodeURIComponent(clientId), "state.json");
  }

  get(clientId: string): ClientStateValue {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file(clientId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) throw new Error(`The state of ${clientId} is malformed`);
    return parsed;
  }

  set(clientId: string, value: unknown): void {
    if (!isRecord(value)) throw new Error("Client state must be a JSON object");
    const text = JSON.stringify(value);
    if (text === undefined) throw new Error("Client state must be JSON");
    if (Buffer.byteLength(text) > CLIENT_STATE_MAX_BYTES) {
      throw new Error(`Client state is limited to ${CLIENT_STATE_MAX_BYTES} bytes`);
    }
    const file = this.file(clientId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const scratch = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(scratch, text, { mode: 0o600 });
      fs.renameSync(scratch, file);
    } catch (error) {
      fs.rmSync(scratch, { force: true });
      throw error;
    }
  }
}
