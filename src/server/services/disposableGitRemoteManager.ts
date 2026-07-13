import { randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { stateLayout } from "../stateLayout.js";
import type { GitHttpTransportResponse } from "./gitHttpRpc.js";

const DISPOSABLE_GIT_HOST = "vibestudio.local";
const DISPOSABLE_GIT_PREFIX = "/_disposable-git/";
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

export interface DisposableGitRemote {
  id: string;
  name: string;
  url: string;
  branch: string;
  expiresAt: number;
}

export interface DisposableGitRemoteInspection {
  id: string;
  url: string;
  branch: string;
  commitCount: number;
  headCommit: string | null;
  expiresAt: number;
}

interface RemoteLocation {
  id: string;
  name: string;
  repoDir: string;
  metadataPath: string;
  remainder: string;
  url: URL;
}

interface RemoteMetadata {
  version: 1;
  id: string;
  name: string;
  branch: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * Host-managed, credential-free Git HTTP remotes for development, examples,
 * and automated tests. URLs are deliberately synthetic: credentialed Git HTTP
 * dispatch recognizes the exact host and handles the smart-HTTP request
 * in-process, so no loopback/private-network exception is added to egress.
 */
export class DisposableGitRemoteManager {
  private readonly root: string;

  constructor(statePath: string) {
    this.root = stateLayout(statePath).disposableGitRemotesDir;
  }

  async create(options?: {
    name?: string;
    branch?: string;
    ttlMs?: number;
  }): Promise<DisposableGitRemote> {
    await this.cleanupExpired();
    const name = normalizeName(options?.name ?? "workspace-test");
    const branch = normalizeBranch(options?.branch ?? "main");
    const ttlMs = Math.min(MAX_TTL_MS, Math.max(1_000, options?.ttlMs ?? DEFAULT_TTL_MS));
    const id = randomBytes(24).toString("hex");
    const containerDir = path.join(this.root, id);
    const repoDir = path.join(containerDir, `${name}.git`);
    const metadata: RemoteMetadata = {
      version: 1,
      id,
      name,
      branch,
      createdAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
    };
    await fs.mkdir(containerDir, { recursive: true, mode: 0o700 });
    await runGit(["init", "--bare", `--initial-branch=${branch}`, repoDir]);
    await runGit(["--git-dir", repoDir, "config", "http.receivepack", "true"]);
    await fs.writeFile(
      path.join(containerDir, "metadata.json"),
      `${JSON.stringify(metadata, null, 2)}\n`,
      { mode: 0o600 }
    );
    return {
      id,
      name,
      url: this.urlFor(metadata),
      branch,
      expiresAt: metadata.expiresAt,
    };
  }

  matches(rawUrl: string): boolean {
    try {
      const url = new URL(rawUrl);
      return (
        url.protocol === "http:" &&
        url.hostname === DISPOSABLE_GIT_HOST &&
        url.pathname.startsWith(DISPOSABLE_GIT_PREFIX)
      );
    } catch {
      return false;
    }
  }

  async handle(input: {
    url: string;
    method: string;
    headers?: Record<string, string>;
    body?: Uint8Array;
  }): Promise<GitHttpTransportResponse> {
    const location = await this.resolve(input.url);
    const metadata = await this.readMetadata(location);
    this.assertNotExpired(metadata);
    const body = input.body ?? new Uint8Array();
    const result = await runGitHttpBackend({
      projectRoot: this.root,
      pathInfo: `/${location.id}/${location.name}.git${location.remainder}`,
      query: location.url.searchParams.toString(),
      method: input.method.toUpperCase(),
      contentType: header(input.headers, "content-type"),
      body,
    });
    return {
      url: input.url,
      method: input.method,
      ...result,
    };
  }

  async inspect(rawUrl: string): Promise<DisposableGitRemoteInspection> {
    const location = await this.resolve(rawUrl, true);
    const metadata = await this.readMetadata(location);
    this.assertNotExpired(metadata);
    const headCommit = await gitOutput([
      "--git-dir",
      location.repoDir,
      "rev-parse",
      "--verify",
      `refs/heads/${metadata.branch}`,
    ]).catch(() => "");
    const countText = await gitOutput([
      "--git-dir",
      location.repoDir,
      "rev-list",
      "--count",
      "--all",
    ]).catch(() => "0");
    return {
      id: metadata.id,
      url: this.urlFor(metadata),
      branch: metadata.branch,
      commitCount: Number.parseInt(countText, 10) || 0,
      headCommit: headCommit || null,
      expiresAt: metadata.expiresAt,
    };
  }

  async remove(rawUrl: string): Promise<{ removed: boolean }> {
    const location = await this.resolve(rawUrl, true);
    await fs.rm(path.dirname(location.repoDir), { recursive: true, force: true });
    return { removed: true };
  }

  async cleanupExpired(now = Date.now()): Promise<void> {
    let ids: string[];
    try {
      ids = await fs.readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await Promise.all(
      ids.map(async (id) => {
        if (!/^[a-f0-9]{48}$/.test(id)) return;
        const dir = path.join(this.root, id);
        try {
          const raw = await fs.readFile(path.join(dir, "metadata.json"), "utf8");
          const metadata = JSON.parse(raw) as Partial<RemoteMetadata>;
          if (typeof metadata.expiresAt === "number" && metadata.expiresAt > now) return;
        } catch {
          // Invalid/incomplete disposable state is safe to collect.
        }
        await fs.rm(dir, { recursive: true, force: true });
      })
    );
  }

  private async resolve(rawUrl: string, allowRootOnly = false): Promise<RemoteLocation> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new Error("Disposable Git remote URL is invalid");
    }
    if (url.protocol !== "http:" || url.hostname !== DISPOSABLE_GIT_HOST) {
      throw new Error("URL is not a host-managed disposable Git remote");
    }
    const match = url.pathname.match(
      /^\/_disposable-git\/([a-f0-9]{48})\/([A-Za-z0-9._-]+)\.git(\/.*)?$/
    );
    if (!match) {
      throw new Error("Disposable Git remote path is invalid");
    }
    const [, id, rawName, remainder = ""] = match;
    if (!id || !rawName || (!allowRootOnly && !remainder && !url.searchParams.has("service"))) {
      throw new Error("Disposable Git remote path is invalid");
    }
    const name = normalizeName(rawName);
    const containerDir = path.join(this.root, id);
    const repoDir = path.join(containerDir, `${name}.git`);
    return {
      id,
      name,
      repoDir,
      metadataPath: path.join(containerDir, "metadata.json"),
      remainder,
      url,
    };
  }

  private async readMetadata(location: RemoteLocation): Promise<RemoteMetadata> {
    let raw: string;
    try {
      raw = await fs.readFile(location.metadataPath, "utf8");
    } catch {
      throw new Error("Disposable Git remote does not exist or has expired");
    }
    const value = JSON.parse(raw) as Partial<RemoteMetadata>;
    if (
      value.version !== 1 ||
      value.id !== location.id ||
      value.name !== location.name ||
      typeof value.branch !== "string" ||
      typeof value.expiresAt !== "number"
    ) {
      throw new Error("Disposable Git remote metadata is invalid");
    }
    return value as RemoteMetadata;
  }

  private assertNotExpired(metadata: RemoteMetadata): void {
    if (metadata.expiresAt <= Date.now()) {
      throw new Error("Disposable Git remote has expired");
    }
  }

  private urlFor(metadata: Pick<RemoteMetadata, "id" | "name">): string {
    return `http://${DISPOSABLE_GIT_HOST}${DISPOSABLE_GIT_PREFIX}${metadata.id}/${metadata.name}.git`;
  }
}

function normalizeName(value: string): string {
  const name = value.trim().replace(/\.git$/i, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new Error("Disposable Git remote name must be 1-64 safe filename characters");
  }
  return name;
}

function normalizeBranch(value: string): string {
  const branch = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(branch) || branch.includes("..")) {
    throw new Error("Disposable Git remote branch is invalid");
  }
  return branch;
}

function header(headers: Record<string, string> | undefined, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

async function runGit(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile("git", args, { maxBuffer: 4 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(`git ${args[0] ?? "command"} failed: ${stderr.trim() || error.message}`));
      } else {
        resolve();
      }
    });
  });
}

async function gitOutput(args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile("git", args, { maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout.trim());
    });
  });
}

async function runGitHttpBackend(input: {
  projectRoot: string;
  pathInfo: string;
  query: string;
  method: string;
  contentType?: string;
  body: Uint8Array;
}): Promise<Pick<GitHttpTransportResponse, "statusCode" | "statusMessage" | "headers" | "body">> {
  const output = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: input.projectRoot,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: input.pathInfo,
        QUERY_STRING: input.query,
        REQUEST_METHOD: input.method,
        CONTENT_TYPE: input.contentType ?? "",
        CONTENT_LENGTH: String(input.body.byteLength),
        SERVER_PROTOCOL: "HTTP/1.1",
        REMOTE_ADDR: "127.0.0.1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let total = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        child.kill();
        reject(new Error("Disposable Git HTTP response exceeded 64 MiB"));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `git http-backend failed (${code ?? "unknown"}): ${Buffer.concat(errors).toString("utf8").trim()}`
          )
        );
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
    child.stdin.end(Buffer.from(input.body));
  });
  const separator = output.indexOf("\r\n\r\n");
  const alternateSeparator = separator < 0 ? output.indexOf("\n\n") : -1;
  const headerEnd = separator >= 0 ? separator : alternateSeparator;
  const separatorBytes = separator >= 0 ? 4 : 2;
  if (headerEnd < 0) throw new Error("git http-backend returned malformed CGI output");
  const lines = output.subarray(0, headerEnd).toString("utf8").split(/\r?\n/);
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let statusMessage = "OK";
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (name.toLowerCase() === "status") {
      const match = value.match(/^(\d{3})(?:\s+(.*))?$/);
      if (match) {
        statusCode = Number(match[1]);
        statusMessage = match[2] || statusMessage;
      }
    } else {
      headers[name.toLowerCase()] = value;
    }
  }
  return {
    statusCode,
    statusMessage,
    headers,
    body: output.subarray(headerEnd + separatorBytes),
  };
}
