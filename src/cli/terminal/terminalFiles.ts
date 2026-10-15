import { open, link, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { RpcClient } from "@vibestudio/rpc";
import { mainRpcMethods } from "@vibestudio/service-schemas/mainRpc";
import type { TerminalBrowserFiles } from "@vibestudio/shell-core/terminal/terminalBrowserHost";
import { runWithOwnedCleanup } from "../../../scripts/lib/owned-cleanup.mjs";

/** Upload uses the ordinary single-write fs API and the chat attachment budget. */
export const TERMINAL_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;
const READ_PAGE_BYTES = 51_200;

function checkSize(size: number): void {
  if (size > TERMINAL_UPLOAD_MAX_BYTES)
    throw new Error("Terminal uploads support files up to 8 MB.");
}

async function readLocal(localPath: string, signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted();
  const file = await open(path.resolve(localPath), "r");
  return runWithOwnedCleanup(
    async () => {
      const info = await file.stat();
      if (!info.isFile()) throw new Error("Choose a regular file to upload.");
      checkSize(info.size);
      const chunks: Buffer[] = [];
      let size = 0;
      for (;;) {
        signal.throwIfAborted();
        const chunk = Buffer.alloc(READ_PAGE_BYTES);
        const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        size += bytesRead;
        checkSize(size);
        chunks.push(chunk.subarray(0, bytesRead));
      }
      signal.throwIfAborted();
      return new Uint8Array(Buffer.concat(chunks, size));
    },
    () => file.close(),
    "Upload read and file cleanup failed"
  );
}

/** Publish only completed bytes, exclusively: a failed write never replaces a user's file. */
async function saveLocal(
  localPath: string,
  signal: AbortSignal,
  write: (file: FileHandle) => Promise<number>
) {
  signal.throwIfAborted();
  const destination = path.resolve(localPath);
  const temporary = path.join(path.dirname(destination), `.vibestudio-transfer-${randomUUID()}`);
  const file = await open(temporary, "wx", 0o600);
  let failure: unknown;
  let failed = false;
  let size = 0;
  try {
    size = await write(file);
    await file.sync();
    signal.throwIfAborted();
    await file.close();
    await link(temporary, destination);
  } catch (error) {
    failed = true;
    failure = error;
  }
  const outcomes = await Promise.allSettled([file.close(), unlink(temporary)]);
  const cleanup = outcomes.flatMap((outcome) =>
    outcome.status === "rejected" ? [outcome.reason] : []
  );
  const failures = [...(failed ? [failure] : []), ...cleanup];
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "File transfer and retirement failed", {
      cause: failures[0],
    });
  return { path: destination, size };
}

/** One file workflow: client bytes and workspace bytes use the ordinary scoped fs service. */
export function createTerminalFiles(
  rpc: Pick<RpcClient, "call">,
  lifetime: AbortSignal
): TerminalBrowserFiles {
  const signalFor = (signal?: AbortSignal) =>
    signal ? AbortSignal.any([lifetime, signal]) : lifetime;
  return {
    async upload(input, options) {
      const signal = signalFor(options?.signal);
      const bytes = await readLocal(input.localPath, signal);
      signal.throwIfAborted();
      await rpc.call(
        "main",
        mainRpcMethods["fs.writeFile"],
        [input.contextId, input.workspacePath, bytes],
        { signal }
      );
      return { path: input.workspacePath, size: bytes.byteLength };
    },
    async download(input, options) {
      const signal = signalFor(options?.signal);
      return saveLocal(input.localPath, signal, async (file) => {
        const digest = createHash("sha256");
        let offset = 0;
        let hash: string | undefined;
        let total: number | undefined;
        for (;;) {
          signal.throwIfAborted();
          const page = await rpc.call(
            "main",
            mainRpcMethods["fs.readBytes"],
            [input.contextId, input.workspacePath, { offset, limit: READ_PAGE_BYTES }],
            { signal }
          );
          if (hash !== undefined && (hash !== page.contentHash || total !== page.totalBytes))
            throw new Error(
              "The workspace file changed during download. No local file was written."
            );
          hash = page.contentHash;
          total = page.totalBytes;
          const bytes = Buffer.from(page.base64, "base64");
          if (
            page.start !== offset ||
            page.end !== offset + bytes.byteLength ||
            bytes.byteLength > READ_PAGE_BYTES ||
            page.end > page.totalBytes
          )
            throw new Error("The workspace returned an inconsistent file page.");
          await file.writeFile(bytes, { signal });
          digest.update(bytes);
          offset += bytes.byteLength;
          if (!page.truncated) break;
          if (page.nextOffset !== offset || bytes.byteLength === 0)
            throw new Error("The workspace file continuation did not advance.");
        }
        if (offset !== total || digest.digest("hex") !== hash)
          throw new Error(
            "The downloaded file did not match its content identity. No local file was written."
          );
        return offset;
      });
    },
    async saveText(input, options) {
      const signal = signalFor(options?.signal);
      return saveLocal(input.localPath, signal, async (file) => {
        await file.writeFile(input.text, { encoding: "utf8", signal });
        return Buffer.byteLength(input.text, "utf8");
      });
    },
  };
}
