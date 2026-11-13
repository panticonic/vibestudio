/**
 * One celld node per workspace: the process that runs the workspace's runtime
 * application (router, worker host, UniversalDO, product Durable Objects).
 *
 * This module owns only the process-level facts of the fork (design.md §5,
 * §8: one fork node per workspace):
 * - where the binary is staged for this platform;
 * - the node's storage: a `vibestore://` bucket over the workspace blob root
 *   (docs/fork/vibestore.md) plus the node's local working directory;
 * - the node's settings: `--no-implicit-deadlines`, the egress proxy and its
 *   secret, the inspector address;
 * - deployment (`celld deploy`), which a running node adopts on `POST /reload`
 *   without restarting, and the graceful same-node shutdown.
 *
 * Generation policy (when to deploy, reload, recover) belongs to the caller.
 * The child is spawned in the server's own process group (never detached), so
 * the ownership reaper retires it with its owner.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { getPhysicalPathForAsarPath } from "@vibestudio/shared/runtimePaths";

/** Environment that would let an inherited fleet setting override this node's
 * private topology (the same list `celld dev` removes for its child). */
const INHERITED_TOPOLOGY_ENV = [
  "AWS_DEFAULT_REGION",
  "AWS_REGION",
  "CELLD_ADDR",
  "CELLD_ADVERTISE",
  "CELLD_BUCKET",
  "CELLD_CLOUD",
  "CELLD_INTERNAL_ADDR",
  "CELLD_TEST_BUCKET",
  "CELLD_TRUST_FORWARDED_HEADERS",
  "CELLD_UNSAFE_PUBLIC_ADVERTISE",
  "CELLD_EGRESS_PROXY",
  "CELLD_EGRESS_SECRET",
  "CELLD_EGRESS_SECRET_FILE",
  "CELLD_INSPECTOR_ADDR",
  "CELLD_SECRETS_KEY",
  "CELLD_SECRETS_KEY_FILE",
  "S3_ENDPOINT",
] as const;

const INTERNAL_LISTENING = /^celld internal listening on (\S+) /u;

/** Platform payload directory name, shared with packaging (native/celld). */
export function celldTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string {
  return `${platform}-${arch}`;
}

/**
 * Resolve the fork binary. `VIBESTUDIO_CELLD_BIN` (absolute) selects a local
 * build; otherwise the app's staged platform payload
 * `<appRoot>/native/celld/<platform>-<arch>/celld[.exe]` is used. There is no
 * PATH fallback: the runtime must be the exact binary this app was built for.
 */
export function resolveCelldBinary(
  appRoot: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): string {
  const override = env["VIBESTUDIO_CELLD_BIN"];
  if (override) {
    if (!path.isAbsolute(override)) throw new Error("VIBESTUDIO_CELLD_BIN must be absolute");
    if (!fs.existsSync(override)) throw new Error(`VIBESTUDIO_CELLD_BIN does not exist: ${override}`);
    return override;
  }
  const executable = process.platform === "win32" ? "celld.exe" : "celld";
  if (appRoot) {
    const staged = getPhysicalPathForAsarPath(
      path.join(appRoot, "native", "celld", celldTarget(), executable)
    );
    if (fs.existsSync(staged)) return staged;
  }
  throw new Error(
    `No celld runtime is staged for ${celldTarget()}: set VIBESTUDIO_CELLD_BIN to a fork build ` +
      `or stage native/celld/${celldTarget()}/${executable}`
  );
}

export interface CelldNodeOptions {
  readonly binary: string;
  /** Private node state: deployment project, key index, local working set. */
  readonly stateDir: string;
  /** The workspace blob root (Vibestudio's CAS layout, shared with its GC). */
  readonly blobRoot: string;
  /** Stable per workspace, so a restarted node resumes its own cells. */
  readonly nodeId: string;
  /** The proxy every outbound request goes through, with the secret that
   *  authenticates the node's identity to it. Both or neither: without them
   *  isolates dial their destinations themselves (fixtures only). */
  readonly egressProxyUrl?: string;
  readonly egressSecret?: string;
  readonly onOutput: (stream: "stdout" | "stderr", line: string) => void;
}

/** A wrangler configuration for the runtime application, without `main`. */
export type CelldDeploymentConfig = Record<string, unknown> & { readonly name: string };

export interface CelldNodeExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export class CelldNodeProcess {
  readonly exited: Promise<CelldNodeExit>;
  #internalOrigin: string | null = null;
  #exit: CelldNodeExit | null = null;

  constructor(
    readonly child: ChildProcess,
    readonly listenPort: number,
    readonly inspectorPort: number | null,
    internalOrigin: Promise<string>
  ) {
    this.exited = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        this.#exit = { code, signal };
        resolve(this.#exit);
      });
    });
    void internalOrigin.then(
      (origin) => {
        this.#internalOrigin = origin;
      },
      () => undefined
    );
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get hasExited(): boolean {
    return this.#exit !== null || this.child.exitCode !== null || this.child.signalCode !== null;
  }

  /** Adopt the bucket's current deployment now (`POST /reload`). */
  async reload(): Promise<void> {
    const origin = this.requireInternalOrigin("reload");
    const response = await fetch(`${origin}/reload`, { method: "POST" });
    const body = await response.text();
    if (!response.ok) throw new Error(`celld reload failed (${response.status}): ${body}`);
  }

  /**
   * Ask for the node's same-node durable stop (the path `celld dev` uses).
   * Returns false when the node could not be asked; the caller then signals.
   */
  async requestShutdown(): Promise<boolean> {
    if (!this.#internalOrigin || this.hasExited) return false;
    try {
      const response = await fetch(`${this.#internalOrigin}/shutdown?handoff=preserve`, {
        method: "POST",
      });
      await response.arrayBuffer();
      return response.ok;
    } catch {
      return false;
    }
  }

  private requireInternalOrigin(operation: string): string {
    if (this.hasExited) throw new Error(`celld node exited before ${operation}`);
    if (!this.#internalOrigin)
      throw new Error(`celld node has not announced its operator listener (${operation})`);
    return this.#internalOrigin;
  }
}

export class CelldNode {
  constructor(private readonly options: CelldNodeOptions) {
    fs.mkdirSync(this.projectDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.workingDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(options.blobRoot, { recursive: true });
    if (options.egressSecret !== undefined) {
      fs.writeFileSync(this.secretFile, options.egressSecret, { mode: 0o600 });
    }
    // The key that seals class secrets in the bucket. It lives beside the
    // node's private state, never in the bucket, so reading the bucket (an
    // index, a backup) reveals no secret.
    if (!fs.existsSync(this.secretsKeyFile)) {
      const key = execFileSync(options.binary, ["secret", "keygen"], { env: this.baseEnv() });
      fs.writeFileSync(this.secretsKeyFile, key, { mode: 0o600 });
    }
  }

  private get secretsKeyFile(): string {
    return path.join(this.options.stateDir, "secrets.key");
  }

  private get projectDir(): string {
    return path.join(this.options.stateDir, "app");
  }

  private get workingDir(): string {
    return path.join(this.options.stateDir, "node");
  }

  private get secretFile(): string {
    return path.join(this.options.stateDir, "egress.secret");
  }

  /** The node's bucket: the shared workspace blob root, keys in a private index. */
  get bucket(): string {
    const root = this.options.blobRoot.split(path.sep).join("/");
    const index = path.join(this.options.stateDir, "index.sqlite").split(path.sep).join("/");
    const rooted = root.startsWith("/") ? root : `/${root}`;
    return `vibestore://${rooted}?index=${encodeURIComponent(index)}`;
  }

  private baseEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const name of INHERITED_TOPOLOGY_ENV) delete env[name];
    return env;
  }

  /** `celld secret put`: the value goes in on stdin, never on a command line. */
  private async putSecret(script: string, name: string, value: string): Promise<void> {
    const child = spawn(
      this.options.binary,
      ["secret", "put", script, name, "--pipe", "--bucket", this.bucket],
      {
        stdio: ["pipe", "ignore", "pipe"],
        env: { ...this.baseEnv(), CELLD_SECRETS_KEY_FILE: this.secretsKeyFile },
      }
    );
    let stderr = "";
    child.stderr?.on("data", (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-2000);
    });
    child.stdin?.end(value);
    const exit = await new Promise<CelldNodeExit>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    if (exit.code !== 0) {
      throw new Error(`celld secret put ${name} failed (code=${exit.code}): ${stderr.trim()}`);
    }
  }

  /**
   * Publish the runtime application as the bucket's current deployment. The
   * module is prebuilt (`no_bundle`), so deploy needs no esbuild.
   */
  async deploy(
    bundle: string,
    config: CelldDeploymentConfig,
    secrets: Readonly<Record<string, string>> = {}
  ): Promise<void> {
    // A deployment that declares secrets is refused until each is stored.
    for (const [name, value] of Object.entries(secrets)) {
      await this.putSecret(config.name, name, value);
    }
    const project = this.projectDir;
    await fs.promises.writeFile(path.join(project, "runtime-app.mjs"), bundle, { mode: 0o600 });
    await fs.promises.writeFile(
      path.join(project, "wrangler.json"),
      JSON.stringify({ ...config, main: "runtime-app.mjs", no_bundle: true }, null, 2),
      { mode: 0o600 }
    );
    const output: string[] = [];
    const child = spawn(this.options.binary, ["deploy", project, "--bucket", this.bucket], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...this.baseEnv(), CELLD_SECRETS_KEY_FILE: this.secretsKeyFile },
    });
    const collect = (stream: "stdout" | "stderr") => (data: Buffer) => {
      for (const line of data.toString().split(/\r?\n/u)) {
        if (!line.trim()) continue;
        output.push(line);
        if (output.length > 40) output.shift();
        this.options.onOutput(stream, `deploy: ${line}`);
      }
    };
    child.stdout?.on("data", collect("stdout"));
    child.stderr?.on("data", collect("stderr"));
    const exit = await new Promise<CelldNodeExit>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    if (exit.code !== 0) {
      throw new Error(
        `celld deploy failed (code=${exit.code}, signal=${exit.signal}):\n${output.join("\n")}`
      );
    }
  }

  /** Spawn a node serving the bucket's current deployment. */
  start(ports: { listen: number; inspector: number | null }): CelldNodeProcess {
    const args = [
      "--no-control-plane",
      "--bucket",
      this.bucket,
      "--listen",
      `127.0.0.1:${ports.listen}`,
      "--internal-listen",
      "127.0.0.1:0",
      "--no-implicit-deadlines",
      ...(this.options.egressProxyUrl !== undefined
        ? ["--egress-proxy", this.options.egressProxyUrl, "--egress-secret-file", this.secretFile]
        : []),
      ...(ports.inspector ? ["--inspector-addr", `127.0.0.1:${ports.inspector}`] : []),
    ];
    const child = spawn(this.options.binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...this.baseEnv(),
        CELLD_SECRETS_KEY_FILE: this.secretsKeyFile,
        CELLD_WATCH: this.workingDir,
        CELLD_NODE: this.options.nodeId,
      },
    });
    const internalOrigin = new Promise<string>((resolve, reject) => {
      child.once("exit", (code, signal) =>
        reject(new Error(`celld node exited before announcing its operator listener (${code}, ${signal})`))
      );
      const lines = lineReader((line) => {
        const match = INTERNAL_LISTENING.exec(line);
        if (match?.[1]) resolve(`http://${match[1]}`);
        this.options.onOutput("stdout", line);
      });
      child.stdout?.on("data", lines);
    });
    internalOrigin.catch(() => undefined);
    child.stderr?.on(
      "data",
      lineReader((line) => this.options.onOutput("stderr", line))
    );
    return new CelldNodeProcess(child, ports.listen, ports.inspector, internalOrigin);
  }
}

function lineReader(onLine: (line: string) => void): (data: Buffer) => void {
  let pending = "";
  return (data) => {
    pending += data.toString();
    const lines = pending.split(/\r?\n/u);
    pending = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) onLine(line);
  };
}
