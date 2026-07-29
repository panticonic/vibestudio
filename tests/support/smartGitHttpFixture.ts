/** Test-owned smart-HTTP fixture. It is intentionally outside host runtime
 * code: production only ever receives an ordinary external Git URL. */
import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_BYTES = 64 * 1024 * 1024;

export class SmartGitHttpFixture {
  private readonly repositories = new Map<
    string,
    { dir: string; branch: string; authorization?: string }
  >();
  private server: Server | null = null;
  private origin: string | null = null;

  constructor(private readonly root: string) {}

  async start(): Promise<void> {
    if (this.server) return;
    this.server = createServer((request, response) => {
      void this.handle(request)
        .then((result) => {
          response.writeHead(result.statusCode, result.statusMessage, result.headers);
          response.end(result.body);
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          response.end(message);
        });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", resolve);
    });
    const address = this.server.address();
    if (!address || typeof address === "string")
      throw new Error("Fixture Git server has no TCP address");
    this.origin = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) =>
      this.server!.close((error) => (error ? reject(error) : resolve()))
    );
    this.server = null;
    this.origin = null;
  }

  async create(name: string, branch = "main"): Promise<{ url: string; branch: string }> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name))
      throw new Error("Invalid fixture Git name");
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(branch) || branch.includes("..")) {
      throw new Error("Invalid fixture Git branch");
    }
    const dir = path.join(this.root, `${name}.git`);
    await execFileAsync("git", ["init", "--bare", `--initial-branch=${branch}`, dir]);
    await execFileAsync("git", ["--git-dir", dir, "config", "http.receivepack", "true"]);
    this.repositories.set(name, { dir, branch });
    return { url: `${this.requireOrigin()}/${name}.git`, branch };
  }

  async inspect(
    name: string
  ): Promise<{ branch: string; headCommit: string | null; commitCount: number }> {
    const repository = this.repositories.get(name);
    if (!repository) throw new Error(`Unknown fixture Git repository ${name}`);
    const headCommit = await gitOutput([
      "--git-dir",
      repository.dir,
      "rev-parse",
      "--verify",
      `refs/heads/${repository.branch}`,
    ]).catch(() => "");
    const count = await gitOutput([
      "--git-dir",
      repository.dir,
      "rev-list",
      "--count",
      "--all",
    ]).catch(() => "0");
    return {
      branch: repository.branch,
      headCommit: headCommit || null,
      commitCount: Number.parseInt(count, 10) || 0,
    };
  }

  protect(name: string, username: string, password: string): void {
    const repository = this.repositories.get(name);
    if (!repository) throw new Error(`Unknown fixture Git repository ${name}`);
    repository.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  }

  private async handle(
    request: IncomingMessage
  ): Promise<{
    statusCode: number;
    statusMessage: string;
    headers: Record<string, string>;
    body: Buffer;
  }> {
    const url = new URL(request.url ?? "/", this.requireOrigin());
    const match = url.pathname.match(/^\/([A-Za-z0-9._-]+)\.git(\/.*)?$/);
    if (!match) throw new Error("Unknown fixture Git path");
    const repository = this.repositories.get(match[1]!);
    if (!repository) throw new Error("Unknown fixture Git path");
    if (
      repository.authorization &&
      request.headers.authorization !== repository.authorization
    ) {
      return {
        statusCode: 401,
        statusMessage: "Unauthorized",
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "www-authenticate": 'Basic realm="Vibestudio Git E2E"',
        },
        body: Buffer.from("Authentication required"),
      };
    }
    const body = await readBody(request);
    return runGitHttpBackend({
      projectRoot: this.root,
      pathInfo: `/${match[1]}.git${match[2] ?? ""}`,
      query: url.searchParams.toString(),
      method: request.method ?? "GET",
      contentType:
        typeof request.headers["content-type"] === "string"
          ? request.headers["content-type"]
          : undefined,
      body,
    });
  }

  private requireOrigin(): string {
    if (!this.origin) throw new Error("Fixture Git HTTP server is not running");
    return this.origin;
  }
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_BYTES) throw new Error("Fixture Git request exceeded 64 MiB");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

async function gitOutput(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args);
  return stdout.trim();
}

async function runGitHttpBackend(input: {
  projectRoot: string;
  pathInfo: string;
  query: string;
  method: string;
  contentType?: string;
  body: Buffer;
}): Promise<{
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string>;
  body: Buffer;
}> {
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
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks))
        : reject(new Error(`git http-backend failed: ${Buffer.concat(errors).toString("utf8")}`))
    );
    child.stdin.end(input.body);
  });
  const headerEnd = output.indexOf("\r\n\r\n");
  if (headerEnd < 0) throw new Error("Fixture Git backend returned malformed CGI output");
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let statusMessage = "OK";
  for (const line of output.subarray(0, headerEnd).toString("utf8").split("\r\n")) {
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
    } else headers[name.toLowerCase()] = value;
  }
  return { statusCode, statusMessage, headers, body: output.subarray(headerEnd + 4) };
}
