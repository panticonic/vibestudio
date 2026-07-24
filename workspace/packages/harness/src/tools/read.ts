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
import type { RpcCaller } from "@vibestudio/rpc";
import { createExtensionProxy } from "@vibestudio/extension";
import { resolveToCwd } from "./path-utils.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type TruncationResult,
} from "./truncate.js";
const readLocationSchema = Type.Union([
  Type.Object({
    path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
  }),
  Type.Object({
    target: Type.String({
      description:
        "File resource reference to read, normally a file:<path> value returned by another tool.",
    }),
    kind: Type.Optional(Type.Literal("file")),
  }),
]);

const readOptionsSchema = Type.Object({
  offset: Type.Optional(
    Type.Number({ description: "Line number to start reading from (1-indexed)" })
  ),
  limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});
const readSchema = Type.Intersect([readLocationSchema, readOptionsSchema]);
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
  engine?: "runtime-fs";
  directory?: boolean;
  extensionFallback?: string;
  missing?: boolean;
  suggestions?: string[];
}
interface ImageResizeResult {
  /** Base64 payload: extension RPC return values are JSON, never typed-array objects. */
  data: string;
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
interface ImageServiceApi {
  detectMimeType(bytes: Uint8Array): Promise<string | null>;
  resize(
    bytes: Uint8Array,
    mimeType: string,
    opts: { maxWidth: number; maxHeight: number }
  ): Promise<ImageResizeResult>;
}
const IMAGE_SERVICE_EXTENSION = "@workspace-extensions/image-service";

export interface ReadToolDeps {
  /** RPC caller — needed for image resize. */
  rpc?: RpcCaller;
}
export function createReadTool(
  cwd: string,
  fs: RuntimeFs,
  deps?: ReadToolDeps
): AgentTool<typeof readSchema, ReadToolDetails> {
  const runtimeRpc = deps?.rpc ?? null;
  const imageService = deps?.rpc
    ? createExtensionProxy<ImageServiceApi>(deps.rpc, IMAGE_SERVICE_EXTENSION, () => false)
    : null;

  const resolveWorkspaceSkillAlias = async (requestedPath: string): Promise<ReadResult | null> => {
    if (!runtimeRpc) return null;
    const normalized = requestedPath.replace(/^\/+/, "");
    const match = /^(?:skills\/)?([^/]+)\/SKILL\.md$/iu.exec(normalized);
    if (!match?.[1]) return null;
    try {
      const entries = await runtimeRpc.call<
        Array<{ name: string; dirPath: string; skillPath: string }>
      >("main", "workspace.listSkills", []);
      const matches = entries.filter((entry) => entry.name === match[1]);
      if (matches.length !== 1) return null;
      const entry = matches[0]!;
      const content = await runtimeRpc.call<string>("main", "workspace.readSkill", [
        entry.dirPath,
      ]);
      return {
        content: [{ type: "text", text: content }],
        details: {
          path: entry.skillPath,
          engine: "runtime-fs",
          extensionFallback: `workspace-skill-alias:${requestedPath}`,
        },
      };
    } catch {
      return null;
    }
  };

  const missingResult = async (
    requestedPath: string,
    absolutePath: string
  ): Promise<ReadResult> => {
    const skillAlias = await resolveWorkspaceSkillAlias(requestedPath);
    if (skillAlias) return skillAlias;
    const slash = absolutePath.lastIndexOf("/");
    const parent = slash <= 0 ? "/" : absolutePath.slice(0, slash);
    const wanted = absolutePath.slice(slash + 1).toLowerCase();
    let suggestions: string[] = [];
    try {
      suggestions = (await fs.readdir(parent))
        .map(String)
        .sort((a, b) => {
          const aScore = similarityScore(a.toLowerCase(), wanted);
          const bScore = similarityScore(b.toLowerCase(), wanted);
          return bScore - aScore || a.localeCompare(b);
        })
        .slice(0, 12);
    } catch {
      // A missing parent has no useful siblings; the diagnostic still remains
      // a successful discovery result rather than poisoning the turn.
    }
    const hint =
      suggestions.length > 0
        ? ` Nearby entries: ${suggestions.join(", ")}.`
        : " The parent directory is also unavailable or empty.";
    return {
      content: [
        {
          type: "text",
          text: `File not found: ${requestedPath}.${hint} Use ls/find before choosing another path.`,
        },
      ],
      details: { path: requestedPath, missing: true, suggestions },
    };
  };

  return {
    name: "read",
    label: "read",
    executionMode: "parallel",
    description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
    parameters: readSchema,
    execute: async (_toolCallId, input, signal, _onUpdate) => {
      const path = normalizeReadLocation(input);
      if (!path) {
        return {
          content: [
            {
              type: "text",
              text: "No file reference was supplied. Call read with path, or with a file:<path> target returned by a discovery tool.",
            },
          ],
          details: { missing: true, suggestions: [] },
        };
      }
      const { offset, limit } = input;
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }
      const absolutePath = resolveToCwd(path, cwd);
      // A file-or-directory probe is a reasonable discovery action. Return a
      // bounded listing here so callers do not need to recover from EISDIR and
      // repeat the same request through another tool.
      try {
        const stats = await retryTransientRuntimeFs(() => fs.stat(absolutePath), signal);
        if (stats.isDirectory()) {
          const entries = (
            await retryTransientRuntimeFs(() => fs.readdir(absolutePath), signal)
          )
            .map(String)
            .sort();
          const shown = entries.slice(0, 200);
          const rendered = await Promise.all(
            shown.map(async (name) => {
              try {
                const child = await retryTransientRuntimeFs(
                  () => fs.stat(`${absolutePath.replace(/\/$/, "")}/${name}`),
                  signal
                );
                return child.isDirectory() ? `${name}/` : name;
              } catch {
                return name;
              }
            })
          );
          const omitted = entries.length - shown.length;
          return {
            content: [
              {
                type: "text",
                text:
                  rendered.join("\n") +
                  (omitted > 0 ? `\n... ${omitted} more entries omitted` : ""),
              },
            ],
            details: { path, engine: "runtime-fs", directory: true },
          };
        }
      } catch {
        // stat failures fall through — the read below reports them naturally.
      }
      // Check that the file exists / is readable; preserve ENOENT semantics.
      try {
        await retryTransientRuntimeFs(
          () => fs.access(absolutePath, fs.constants.R_OK),
          signal
        );
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return missingResult(path, absolutePath);
        }
        throw err;
      }
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }
      // --- Image/text read ---------------------------------------------------------------
      // Text is the overwhelmingly common path and should remain a single
      // compact UTF-8 RPC response. Binary envelopes add base64 expansion and
      // unnecessary control-frame pressure, which is especially costly when
      // the model reads several skills in parallel. Only likely image paths
      // need raw bytes for detection and resize.
      const likelyImage = isLikelyImagePath(path);
      let raw: string | Buffer;
      try {
        raw = await retryTransientRuntimeFs(
          () => fs.readFile(absolutePath, likelyImage ? undefined : "utf8"),
          signal
        );
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return missingResult(path, absolutePath);
        }
        throw err;
      }
      if (raw instanceof Uint8Array && imageService && likelyImage) {
        const mimeType = await imageService.detectMimeType(raw);
        if (mimeType?.startsWith("image/")) {
          const resized = await imageService.resize(raw, mimeType, {
            maxWidth: 2000,
            maxHeight: 2000,
          });
          const content: (TextContent | ImageContent)[] = [
            { type: "image", mimeType: resized.mimeType, data: resized.data },
          ];
          if (resized.dimensionNote) {
            content.unshift({ type: "text", text: resized.dimensionNote });
          }
          return {
            content,
            details: {
              path: absolutePath,
              mimeType: resized.mimeType,
              size: Buffer.byteLength(resized.data, "base64"),
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
      return formatTextResult(textContent, path, offset, limit);
    },
  };
}

function normalizeReadLocation(input: { path?: unknown; target?: unknown }): string | null {
  const raw = typeof input.path === "string" ? input.path : input.target;
  if (typeof raw !== "string" || raw.length === 0) return null;
  // Discovery and provenance tools return stable `file:<path>` references.
  // Accept them directly so the agent does not have to manually translate a
  // resource descriptor back into the read tool's path spelling.
  return raw.replace(/^file:(?:\/\/)?/iu, "");
}

function similarityScore(candidate: string, wanted: string): number {
  if (candidate === wanted) return 100;
  let score = 0;
  if (candidate.split(".").pop() === wanted.split(".").pop()) score += 10;
  const max = Math.min(candidate.length, wanted.length);
  for (let i = 0; i < max && candidate[i] === wanted[i]; i += 1) score += 2;
  for (const token of wanted.split(/[^a-z0-9]+/u)) {
    if (token && candidate.includes(token)) score += token.length;
  }
  return score;
}

function isLikelyImagePath(filePath: string): boolean {
  return /\.(?:png|jpe?g|gif|webp)$/iu.test(filePath);
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
    return {
      content: [
        {
          type: "text",
          text:
            `[Offset ${offset} is beyond end of file (${allLines.length} lines total). ` +
            `The last valid offset is ${allLines.length}.]`,
        },
      ],
      details: { path: displayPath, engine: "runtime-fs", extensionFallback },
    };
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
const TRANSIENT_RUNTIME_FS_FAILURE =
  /(?:DO dispatch fetch|fetch failed|other side closed|socket hang up|UND_ERR_SOCKET|ECONNRESET|ECONNREFUSED|ETIMEDOUT|\btransport\b)/iu;
const TRANSIENT_RUNTIME_FS_ATTEMPTS = 4;

async function retryTransientRuntimeFs<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= TRANSIENT_RUNTIME_FS_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) throw new Error("Operation aborted");
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === TRANSIENT_RUNTIME_FS_ATTEMPTS || !TRANSIENT_RUNTIME_FS_FAILURE.test(message)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 100));
    }
  }
  throw lastError;
}
