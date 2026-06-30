/**
 * Read tool — workerd port of pi-coding-agent's `dist/core/tools/read.js`.
 *
 * Differences from upstream:
 * - File I/O goes through `RuntimeFs` (no `fs/promises`).
 * - Image handling is delegated to the image service extension; detection
 *   uses magic-byte sniffing rather than the filename-extension table that
 *   pi-coding-agent ships.
 */
import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool } from "@workspace/pi-core";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";
import { Buffer } from "node:buffer";
import type { RuntimeFs } from "./runtime-fs.js";
import type { RpcCaller } from "@vibez1/rpc";
import { createExtensionProxy } from "@vibez1/extension";
import { resolveReadPath } from "./path-utils.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type TruncationResult,
} from "./truncate.js";
const readSchema = Type.Object({
  path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
  offset: Type.Optional(
    Type.Number({ description: "Line number to start reading from (1-indexed)" })
  ),
  limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});
export type ReadToolInput = Static<typeof readSchema>;
export interface ReadToolDetails {
  truncation?: TruncationResult;
  path?: string;
  mimeType?: string;
  size?: number;
  originalSize?: number;
  originalDimensions?: {
    width: number;
    height: number;
  };
  dimensions?: {
    width: number;
    height: number;
  };
  wasResized?: boolean;
  engine?: "node-file" | "runtime-fs";
  extensionFallback?: string;
}
interface ImageResizeResult {
  data: Uint8Array;
  mimeType: string;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  wasResized: boolean;
  dimensionNote?: string;
}
interface ReadResult {
  content: (TextContent | ImageContent)[];
  details: ReadToolDetails;
}
interface FileToolsApi {
  read(request: {
    path: string;
    cwd: string;
    offset?: number;
    limit?: number;
  }): Promise<ReadResult>;
}
interface ImageServiceApi {
  detectMimeType(bytes: Uint8Array): Promise<string | null>;
  resize(
    bytes: Uint8Array,
    mimeType: string,
    opts: { maxWidth: number; maxHeight: number }
  ): Promise<ImageResizeResult>;
}
const IMAGE_SERVICE_EXTENSION = "@workspace-extensions/image-service";
const FILE_TOOLS_EXTENSION = "@workspace-extensions/file-tools";
const DEFAULT_FILE_TOOLS_READ_TIMEOUT_MS = 3000;
export interface ReadToolDeps {
  /** RPC caller — needed for image resize. */
  rpc?: RpcCaller;
  fileToolsReadTimeoutMs?: number;
}
export function createReadTool(
  cwd: string,
  fs: RuntimeFs,
  deps?: ReadToolDeps
): AgentTool<typeof readSchema, ReadToolDetails> {
  const fileToolsRpc = deps?.rpc ?? null;
  const fileToolsReadTimeoutMs = deps?.fileToolsReadTimeoutMs ?? DEFAULT_FILE_TOOLS_READ_TIMEOUT_MS;
  const imageService = deps?.rpc
    ? createExtensionProxy<ImageServiceApi>(deps.rpc, IMAGE_SERVICE_EXTENSION, () => false)
    : null;
  return {
    name: "read",
    label: "read",
    description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
    parameters: readSchema,
    execute: async (_toolCallId, input, signal, onUpdate) => {
      const { path, offset, limit } = input;
      if (typeof path !== "string") {
        throw new Error("read requires path");
      }
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }
      const absolutePath = resolveReadPath(path, cwd);
      // Directories are a common model mistake — answer with guidance
      // instead of a raw EISDIR from the fs layer.
      try {
        const stats = await fs.stat(absolutePath);
        if (stats.isDirectory()) {
          throw new Error(`Path is a directory, not a file: ${path} — use the ls tool to list it.`);
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes("is a directory, not a file")) throw err;
        // stat failures fall through — the read below reports them naturally.
      }
      let fileToolsFallbackReason: string | undefined;
      let skipImageExtensionDetection = false;
      if (fileToolsRpc && !isLikelyImagePath(path)) {
        try {
          return await callFileToolsRead(
            fileToolsRpc,
            { path, cwd, offset, limit },
            fileToolsReadTimeoutMs,
            signal
          );
        } catch (err) {
          if (isFileToolsReadAbort(err)) throw err;
          if (!isFileToolsExtensionFallback(err) && !isFileToolsReadTimeout(err)) throw err;
          fileToolsFallbackReason = describeFileToolsFallback(err, fileToolsReadTimeoutMs);
          if (isFileToolsReadTimeout(err)) {
            skipImageExtensionDetection = true;
            console.warn(`[read] ${fileToolsFallbackReason}; falling back to RuntimeFs`);
            (onUpdate as ((update: unknown) => void) | undefined)?.({
              content: [],
              details: {
                type: "console",
                content: `${fileToolsFallbackReason}; falling back to RuntimeFs read`,
              },
            });
          }
        }
      }
      // Check that the file exists / is readable; preserve ENOENT semantics.
      try {
        await fs.access(absolutePath, fs.constants.R_OK);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`File not found: ${path}`);
        }
        throw err;
      }
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }
      // --- Image branch ------------------------------------------------------------------
      // Read raw bytes once; if the magic bytes look like an image we hand off
      // to the image service, otherwise we fall through to the text path with
      // the same bytes (so we never re-read the file).
      let raw: string | Buffer;
      try {
        raw = await fs.readFile(absolutePath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`File not found: ${path}`);
        }
        throw err;
      }
      if (raw instanceof Uint8Array && imageService && !skipImageExtensionDetection) {
        const mimeType = await imageService.detectMimeType(raw);
        if (mimeType?.startsWith("image/")) {
          const resized = await imageService.resize(raw, mimeType, {
            maxWidth: 2000,
            maxHeight: 2000,
          });
          const base64 = Buffer.from(resized.data).toString("base64");
          const content: (TextContent | ImageContent)[] = [
            { type: "image", mimeType: resized.mimeType, data: base64 },
          ];
          if (resized.dimensionNote) {
            content.unshift({ type: "text", text: resized.dimensionNote });
          }
          return {
            content,
            details: {
              path: absolutePath,
              mimeType: resized.mimeType,
              size: resized.data.byteLength,
              originalSize: raw.byteLength,
              originalDimensions: { width: resized.originalWidth, height: resized.originalHeight },
              dimensions: { width: resized.width, height: resized.height },
              wasResized: resized.wasResized,
            },
          };
        }
      }
      // --- Text branch -------------------------------------------------------------------
      const textContent = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf-8");
      return formatTextResult(textContent, path, offset, limit, fileToolsFallbackReason);
    },
  };
}

async function callFileToolsRead(
  rpc: RpcCaller,
  request: {
    path: string;
    cwd: string;
    offset?: number;
    limit?: number;
  },
  timeoutMs: number,
  signal?: AbortSignal
): Promise<ReadResult> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;

  const abortPromise = signal
    ? new Promise<never>((_, reject) => {
        abortListener = () => {
          const err = createAbortError(signal);
          controller.abort(err);
          reject(err);
        };
        if (signal.aborted) {
          abortListener();
        } else {
          signal.addEventListener("abort", abortListener, { once: true });
        }
      })
    : null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      const err = new FileToolsReadTimeoutError(timeoutMs);
      controller.abort(err);
      reject(err);
    }, timeoutMs);
  });

  const invokePromise = rpc.call<ReadResult>(
    "main",
    "extensions.invoke",
    [FILE_TOOLS_EXTENSION, "read", [request]],
    { signal: controller.signal }
  );
  invokePromise.catch(() => {});

  try {
    return await Promise.race(
      abortPromise ? [invokePromise, timeoutPromise, abortPromise] : [invokePromise, timeoutPromise]
    );
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (signal && abortListener) signal.removeEventListener("abort", abortListener);
  }
}

class FileToolsReadTimeoutError extends Error {
  code = "ETIMEOUT";

  constructor(timeoutMs: number) {
    super(`file-tools read timed out after ${timeoutMs}ms`);
    this.name = "FileToolsReadTimeoutError";
  }
}

function createAbortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error(typeof reason === "string" ? reason : "Operation aborted");
  err.name = "AbortError";
  return err;
}
function isLikelyImagePath(filePath: string): boolean {
  return /\.(?:png|jpe?g|gif|webp)$/iu.test(filePath);
}
function isFileToolsExtensionFallback(err: unknown): boolean {
  const code =
    typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  // ENOTREADY = declared but not yet running; treat like ENOEXT and fall back.
  if (code === "ENOEXT" || code === "ENOTREADY" || code === "EIMAGE") return true;
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("Image reads are handled by the image service path")) return true;
  return /Extension @workspace-extensions\/file-tools(?:\.\w+)? invocation failed: Extension is not installed|Extension is not running/.test(
    message
  );
}

function isFileToolsReadTimeout(err: unknown): boolean {
  return (
    err instanceof FileToolsReadTimeoutError ||
    (typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ETIMEOUT")
  );
}

function isFileToolsReadAbort(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === "AbortError" && !isFileToolsReadTimeout(err);
}

function describeFileToolsFallback(err: unknown, timeoutMs: number): string {
  if (isFileToolsReadTimeout(err)) return `file-tools read timed out after ${timeoutMs}ms`;
  const code =
    typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  if (code === "ENOTREADY") return "file-tools extension or context not ready";
  return "file-tools extension unavailable";
}

function formatTextResult(
  textContent: string,
  displayPath: string,
  offset: number | undefined,
  limit: number | undefined,
  extensionFallback?: string
): {
  content: (TextContent | ImageContent)[];
  details: ReadToolDetails;
} {
  const allLines = textContent.split("\n");
  const totalFileLines = allLines.length;
  const startLine = offset ? Math.max(0, offset - 1) : 0;
  const startLineDisplay = startLine + 1;
  if (startLine >= allLines.length) {
    throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
  }
  let selectedContent: string;
  let userLimitedLines: number | undefined;
  if (limit !== undefined) {
    const endLine = Math.min(startLine + limit, allLines.length);
    selectedContent = allLines.slice(startLine, endLine).join("\n");
    userLimitedLines = endLine - startLine;
  } else {
    selectedContent = allLines.slice(startLine).join("\n");
  }
  const truncation = truncateHead(selectedContent);
  let outputText: string;
  let details: ReadToolDetails = {};
  if (truncation.firstLineExceedsLimit) {
    const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine] ?? "", "utf-8"));
    outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use offset=${startLineDisplay + 1} to skip past it.]`;
    details = { truncation };
  } else if (truncation.truncated) {
    const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
    const nextOffset = endLineDisplay + 1;
    outputText = truncation.content;
    if (truncation.truncatedBy === "lines") {
      outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
    } else {
      outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
    }
    details = { truncation };
  } else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
    const remaining = allLines.length - (startLine + userLimitedLines);
    const nextOffset = startLine + userLimitedLines + 1;
    outputText = truncation.content;
    outputText += `\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
  } else {
    outputText = truncation.content;
  }
  return {
    content: [{ type: "text", text: outputText }],
    details: { ...details, path: displayPath, engine: "runtime-fs", extensionFallback },
  };
}
