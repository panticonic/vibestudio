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
import { splitRepoPath } from "@vibestudio/shared/runtime/entitySpec";
import type { VcsProvenanceForFileResult } from "@vibestudio/service-schemas/vcs";
import type { RuntimeFs } from "./runtime-fs.js";
import type { RpcCaller } from "@vibestudio/rpc";
import { createExtensionProxy } from "@vibestudio/extension";
import { resolveReadPath } from "./path-utils.js";
import { toVcsPath } from "./tool-vcs.js";
import { renderProvenanceBlock } from "./provenance-format.js";
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
  // Optional (§7.1): the agent's context budget for this read. Choose from what
  // you are doing right now (merely using code / executing a set plan / planning
  // a change) crossed with how provenance has been behaving on this codebase
  // lately (insightful vs redundant) — not a fixed lookup.
  //  · none     — file content only, no attachment.
  //  · moderate — blame + FTS recall + 1-hop density re-rank (cheap, ~5 items).
  //  · deep     — moderate + 2-hop density + claim-relation walk (~10 items).
  provenance: Type.Optional(
    Type.Union([Type.Literal("none"), Type.Literal("moderate"), Type.Literal("deep")], {
      description:
        "Optional context budget for this read. Omit to read content only. 'none' = content only; 'moderate' = blame + recall + 1-hop density (~5 items); 'deep' = + 2-hop density + claim relations (~10 items). Choose from your situation and how useful provenance has been lately, not a constant.",
    })
  ),
  offset: Type.Optional(
    Type.Number({ description: "Line number to start reading from (1-indexed)" })
  ),
  limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
  recallKeywords: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Optional keywords to steer the provenance recall leg beyond the file's own text (e.g. a concept you're chasing). Used sporadically; the file + session anchors carry recall on their own.",
    })
  ),
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
  engine?: "node-file" | "runtime-fs";
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
const FILE_TOOLS_EXTENSION = "@workspace-extensions/file-tools";
const DEFAULT_FILE_TOOLS_READ_TIMEOUT_MS = 3000;

/** The §6/§7 read-time attachment client + session identity threaded into the
 *  read tool. When absent (agent classes without a gad-store DO), the read tool
 *  accepts and ignores the `provenance` arg — the schema stays uniform so every
 *  agent's model still makes the tier choice, but no attachment is computed. */
export interface ReadProvenanceDeps {
  /** One gad-store DO call: provenance ∪ recall, density-ranked, §7.5-rendered.
   *  Never moves file content onto the DO (§7.2) — bytes are read in parallel. */
  provenanceForFile(input: {
    repoPath: string;
    path: string;
    head: string;
    tier: "none" | "moderate" | "deep";
    sessionLogId: string;
    sessionHead: string;
    invocationId?: string | null;
    recallKeywords?: string[] | null;
  }): Promise<VcsProvenanceForFileResult>;
  /** The vcs head where reads resolve (`ctx:<contextId>`), resolved lazily — the
   *  context subscription may not exist while the tool surface is merely built. */
  head: string | (() => string);
  /** The agent's own trajectory branch (logId === head for the loop). Touches,
   *  touch_version, and session-recency are keyed here, NOT on the vcs head. */
  sessionLogId: string;
  sessionHead: string;
}

export interface ReadToolDeps {
  /** RPC caller — needed for image resize. */
  rpc?: RpcCaller;
  fileToolsReadTimeoutMs?: number;
  /** §7.1 read-time provenance attachment. Omit for agent classes with no
   *  gad-store DO — the `provenance` arg is then accepted and ignored. */
  provenance?: ReadProvenanceDeps;
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
  const provenanceDeps = deps?.provenance ?? null;

  const resolveWorkspaceSkillAlias = async (requestedPath: string): Promise<ReadResult | null> => {
    if (!fileToolsRpc) return null;
    const normalized = requestedPath.replace(/^\/+/, "");
    const match = /^(?:skills\/)?([^/]+)\/SKILL\.md$/iu.exec(normalized);
    if (!match?.[1]) return null;
    try {
      const entries = await fileToolsRpc.call<
        Array<{ name: string; dirPath: string; skillPath: string }>
      >("main", "workspace.listSkills", []);
      const matches = entries.filter((entry) => entry.name === match[1]);
      if (matches.length !== 1) return null;
      const entry = matches[0]!;
      const content = await fileToolsRpc.call<string>("main", "workspace.readSkill", [
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

  const missingResult = async (requestedPath: string, absolutePath: string): Promise<ReadResult> => {
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

  /** Fire the §7.2 provenance attachment for a read, or return `null` to skip it
   *  silently (no client, tier `none`, or the path is outside any tracked repo —
   *  `skills/` docs, absolute non-repo paths). Best-effort: a rejection resolves
   *  to `null` so the attachment can never fail the read. Resolves with the
   *  workspace-relative `label` so the caller renders the header + drill handle. */
  const startProvenance = (
    toolCallId: string,
    input: { path?: string; provenance?: "none" | "moderate" | "deep"; recallKeywords?: string[] }
  ): Promise<{ label: string; result: VcsProvenanceForFileResult } | null> | null => {
    if (!provenanceDeps) return null;
    const tier = input.provenance;
    // Call at EVERY tier (§7.4: every read leaves one coalesced `observed` touch);
    // tier `none` writes the touch DO-side and returns empty items (no block).
    if (tier !== "none" && tier !== "moderate" && tier !== "deep") return null;
    if (typeof input.path !== "string") return null;
    let vcsPath: string;
    try {
      vcsPath = toVcsPath(input.path, cwd);
    } catch {
      return null; // path escapes the workspace root
    }
    const repo = splitRepoPath(vcsPath);
    if (!repo) return null; // outside any repo
    // skills/ resolves to a repo by section taxonomy, but it is a documentation
    // overlay agents READ, not code they vcs-edit; skip it (C8) so skill reads
    // never write touches or spend a DO round-trip.
    if (repo.repoPath.split("/")[0] === "skills") return null;
    const head =
      typeof provenanceDeps.head === "function" ? provenanceDeps.head() : provenanceDeps.head;
    if (!head || head.endsWith(":") || head.includes("undefined")) return null;
    const recallKeywords = Array.isArray(input.recallKeywords) ? input.recallKeywords : null;
    return provenanceDeps
      .provenanceForFile({
        repoPath: repo.repoPath,
        path: vcsPath,
        head,
        tier,
        sessionLogId: provenanceDeps.sessionLogId,
        sessionHead: provenanceDeps.sessionHead,
        invocationId: toolCallId || null,
        recallKeywords,
      })
      .then((result) => ({ label: vcsPath, result }))
      .catch((err: unknown) => {
        console.warn(`[read] provenance attachment failed for ${vcsPath}: ${String(err)}`);
        return null;
      });
  };

  return {
    name: "read",
    label: "read",
    description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
    parameters: readSchema,
    execute: async (toolCallId, input, signal, onUpdate) => {
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
      // Resolve semantic skill names before probing the sparse context
      // filesystem. Extension-owned skills intentionally do not live at
      // `skills/<name>`, so a filesystem-first lookup creates misleading
      // materialization/ENOENT warnings even though the canonical skill is
      // available through workspace.listSkills/readSkill.
      const skillAlias = await resolveWorkspaceSkillAlias(path);
      if (skillAlias) return skillAlias;
      const absolutePath = resolveReadPath(path, cwd);
      // A file-or-directory probe is a reasonable discovery action. Return a
      // bounded listing here so callers do not need to recover from EISDIR and
      // repeat the same request through another tool.
      try {
        const stats = await fs.stat(absolutePath);
        if (stats.isDirectory()) {
          const entries = (await fs.readdir(absolutePath)).map(String).sort();
          const shown = entries.slice(0, 200);
          const rendered = await Promise.all(
            shown.map(async (name) => {
              try {
                const child = await fs.stat(`${absolutePath.replace(/\/$/, "")}/${name}`);
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
      // §7.2: content NEVER moves onto the DO. Start provenance only after the
      // read has succeeded so failed reads do not record false observed touches.
      // `attach` appends the §7.5 block AFTER the file content, on text results
      // only, unless the block is suppressed/empty.
      const attach = async (result: ReadResult): Promise<ReadResult> => {
        const provenancePromise = startProvenance(toolCallId, input);
        if (!provenancePromise) return result;
        const prov = await provenancePromise;
        if (!prov || prov.result.suppressed) return result;
        if (result.content.some((item) => item.type === "image")) return result;
        const block = renderProvenanceBlock({
          label: prov.label,
          items: prov.result.items,
          shown: prov.result.shown,
          total: prov.result.total,
          nextCursor: prov.result.nextCursor,
        });
        if (!block) return result;
        return { ...result, content: [...result.content, { type: "text", text: block }] };
      };
      let fileToolsFallbackReason: string | undefined;
      let skipImageExtensionDetection = false;
      if (fileToolsRpc && !isLikelyImagePath(path)) {
        try {
          return await attach(
            await callFileToolsRead(
              fileToolsRpc,
              { path, cwd, offset, limit },
              fileToolsReadTimeoutMs,
              signal
            )
          );
        } catch (err) {
          if (isFileToolsReadAbort(err)) throw err;
          if (isMissingReadError(err)) return missingResult(path, absolutePath);
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
          return missingResult(path, absolutePath);
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
          return missingResult(path, absolutePath);
        }
        throw err;
      }
      if (
        raw instanceof Uint8Array &&
        imageService &&
        !skipImageExtensionDetection &&
        (isLikelyImagePath(path) || hasLikelyImageMagic(raw))
      ) {
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
          return await attach({
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
          });
        }
      }
      // --- Text branch -------------------------------------------------------------------
      const textContent = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf-8");
      return await attach(
        formatTextResult(textContent, path, offset, limit, fileToolsFallbackReason)
      );
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

function isMissingReadError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return code === "ENOENT" || /\b(?:ENOENT|file not found|path not found|no such file)\b/i.test(message);
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
function hasLikelyImageMagic(bytes: Uint8Array): boolean {
  const ascii = (start: number, end: number): string =>
    String.fromCharCode(...bytes.subarray(start, end));
  return (
    (bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      ascii(1, 4) === "PNG" &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a) ||
    (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
    (bytes.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) ||
    (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP")
  );
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
