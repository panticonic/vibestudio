import { it, expect } from "vitest";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { internalDoUniqueKey, UNIVERSAL_DO_UNIQUE_KEY } from "./workerdStorageIdentity.js";
import { getPhysicalPathForAsarPath } from "@vibestudio/shared/runtimePaths";

const require = createRequire(import.meta.url);
const packages: Record<string, string> = {
  "linux x64 LE": "@cloudflare/workerd-linux-64",
  "linux arm64 LE": "@cloudflare/workerd-linux-arm64",
  "darwin arm64 LE": "@cloudflare/workerd-darwin-arm64",
  "darwin x64 LE": "@cloudflare/workerd-darwin-64",
  "win32 x64 LE": "@cloudflare/workerd-windows-64",
};
function installedWorkerd(): string {
  const packageName = packages[`${process.platform} ${os.arch()} ${os.endianness()}`];
  if (!packageName) throw new Error("Unsupported workerd native test target");
  return getPhysicalPathForAsarPath(
    require.resolve(`${packageName}/bin/workerd${process.platform === "win32" ? ".exe" : ""}`)
  );
}
async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  return address.port;
}

it.each([
  "http",
  "nodejs",
  "inspector",
  "sqlite",
  "sqlite-long-path",
  "sqlite-facet",
  "sqlite-facet-long-path",
  "workerLoader",
] as const)(
  "serves real requests with installed workerd: %s",
  async (feature) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vibestudio-workerd-native-"));
    let child: ReturnType<typeof spawn> | undefined;
    let closed: Promise<void> | undefined;
    let stderr = "";
    let stdout = "";
    try {
      const port = await unusedPort();
      const inspectorPort = feature === "inspector" ? await unusedPort() : undefined;
      const sqlite = feature.startsWith("sqlite");
      const facet = feature.startsWith("sqlite-facet");
      const storageRoot = feature.endsWith("long-path")
        ? path.join(
            root,
            "profile-" + "x".repeat(80),
            "instance",
            "workspaces",
            "workspace-native-test",
            "state",
            ".databases",
            "workerd-universal-do"
          )
        : path.join(root, "storage");
      if (sqlite) await mkdir(storageRoot, { recursive: true });
      let source = 'export default { fetch() { return new Response("http-ok"); } };';
      let fields = "";
      if (feature === "nodejs") {
        source = `import { createHash } from 'node:crypto';
          export default { fetch() { return new Response(createHash('sha256').update('native').digest('hex')); } };`;
        fields = 'compatibilityFlags = ["nodejs_compat"],';
      } else if (sqlite && !facet) {
        source = `export class Counter {
        constructor(ctx) { this.sql = ctx.storage.sql; this.sql.exec('CREATE TABLE IF NOT EXISTS count (value INTEGER)'); }
        fetch() { this.sql.exec('INSERT INTO count VALUES (1)'); return new Response(String(this.sql.exec('SELECT count(*) AS n FROM count').one().n)); }
      }
      export default { fetch(req, env) { return env.COUNTER.get(env.COUNTER.idFromName('test')).fetch(req); } };`;
        fields = `bindings = [(name = "COUNTER", durableObjectNamespace = "Counter")], durableObjectNamespaces = [(className = "Counter", uniqueKey = "${internalDoUniqueKey("@vibestudio/internal", "Counter")}", enableSql = true)], durableObjectStorage = (localDisk = "storage"),`;
      } else if (facet) {
        const facetSource = `export class Counter {
          constructor(ctx) { this.sql = ctx.storage.sql; this.sql.exec('CREATE TABLE IF NOT EXISTS count (value INTEGER)'); }
          fetch() { this.sql.exec('INSERT INTO count VALUES (1)'); return new Response(String(this.sql.exec('SELECT count(*) AS n FROM count').one().n)); }
        }`;
        source = `export class UniversalDO {
          constructor(ctx, env) { this.ctx = ctx; this.env = env; }
          fetch(req) {
            const worker = this.env.LOADER.load({ compatibilityDate: '2025-12-01', mainModule: 'facet.js', modules: { 'facet.js': ${JSON.stringify(facetSource)} } });
            const facet = this.ctx.facets.get('do', () => ({ class: worker.getDurableObjectClass('Counter') }));
            return facet.fetch(req);
          }
        }
        export default { fetch(req, env) { return env.COUNTER.get(env.COUNTER.idFromName('test')).fetch(req); } };`;
        fields = `compatibilityFlags = ["experimental"], bindings = [(name = "LOADER", workerLoader = (id = "facets")), (name = "COUNTER", durableObjectNamespace = "UniversalDO")], durableObjectNamespaces = [(className = "UniversalDO", uniqueKey = "${UNIVERSAL_DO_UNIQUE_KEY}", enableSql = true)], durableObjectStorage = (localDisk = "storage"),`;
      } else if (feature === "workerLoader") {
        source = `export default { async fetch(req, env) {
        const worker = env.LOADER.get('test', async () => ({ compatibilityDate: '2025-12-01', mainModule: 'worker.js', modules: { 'worker.js': 'export default { fetch() { return new Response("dynamic-ok") } }' } }));
        return worker.getEntrypoint().fetch(req);
      } };`;
        fields =
          'compatibilityFlags = ["experimental"], bindings = [(name = "LOADER", workerLoader = (id = "native-test"))],';
      }
      const config = `using Workerd = import "/workerd/workerd.capnp";
      const config :Workerd.Config = (
        services = [(name = "main", worker = (compatibilityDate = "2025-12-01", ${fields} modules = [(name = "worker.js", esModule = ${JSON.stringify(source)})]))${sqlite ? `, (name = "storage", disk = (path = ${JSON.stringify(storageRoot)}, writable = true))` : ""}],
        sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "main")]
      );`;
      const configPath = path.join(root, "config.capnp");
      await writeFile(configPath, config);
      // Match the production executable and inherited owner environment. The
      // feature cases narrow configuration only; no platform execution bypass.
      child = spawn(
        installedWorkerd(),
        [
          "serve",
          "--experimental",
          ...(inspectorPort ? [`--inspector-addr=127.0.0.1:${inspectorPort}`] : []),
          configPath,
        ],
        { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } }
      );
      let failure: Error | undefined;
      child.once("error", (error) => {
        failure = error;
      });
      closed = new Promise((resolve) => child!.once("close", () => resolve()));
      child.stderr?.on("data", (data) => {
        stderr = (stderr + String(data)).slice(-16384);
      });
      child.stdout?.on("data", (data) => {
        stdout = (stdout + String(data)).slice(-16384);
      });
      const endpoint = `http://127.0.0.1:${port}`;
      let response: Response | undefined;
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (failure || child.exitCode !== null || child.signalCode !== null)
          throw new Error(
            `${feature}: workerd exited ${child.exitCode ?? child.signalCode}: ${failure?.message ?? ""}\n${stderr}\n${stdout}`
          );
        try {
          response = await fetch(endpoint, { signal: AbortSignal.timeout(1000) });
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      if (!response) throw new Error(`${feature}: workerd never served HTTP\n${stderr}\n${stdout}`);
      if (sqlite) {
        const files = (await readdir(storageRoot, { recursive: true })).map((file) =>
          path.join(storageRoot, file)
        );
        console.log(
          "[workerd native storage]",
          JSON.stringify({
            feature,
            root: storageRoot,
            rootLength: storageRoot.length,
            files: files.map((file) => ({ path: file, length: file.length })),
          })
        );
      }
      expect(response.status, stderr).toBe(200);
      expect(await response.text(), stderr).toBe(
        feature === "nodejs"
          ? createHash("sha256").update("native").digest("hex")
          : sqlite
            ? "1"
            : feature === "workerLoader"
              ? "dynamic-ok"
              : "http-ok"
      );
      if (sqlite)
        expect(await (await fetch(endpoint, { signal: AbortSignal.timeout(3000) })).text()).toBe(
          "2"
        );
      if (sqlite) {
        const databases = (await readdir(storageRoot, { recursive: true })).filter((file) =>
          file.endsWith(".sqlite")
        );
        expect(databases.length).toBeGreaterThan(0);
        if (facet) expect(databases.some((file) => /\.\d+\.sqlite$/.test(file))).toBe(true);
        if (feature.endsWith("long-path"))
          expect(databases.some((file) => path.join(storageRoot, file).length > 260)).toBe(true);
      }
      if (inspectorPort) {
        const targets = await fetch(`http://127.0.0.1:${inspectorPort}/json/list`, {
          signal: AbortSignal.timeout(3000),
        });
        expect(targets.status).toBe(200);
        expect(((await targets.json()) as unknown[]).length).toBeGreaterThan(0);
      }
    } finally {
      if (child && closed) {
        child.kill("SIGTERM");
        const kill = setTimeout(() => child!.kill("SIGKILL"), 2000);
        try {
          await closed;
        } finally {
          clearTimeout(kill);
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  },
  15000
);

it("keeps namespace directory names portable and source identities distinct", () => {
  const first = internalDoUniqueKey("@host/a/b", "Counter");
  const second = internalDoUniqueKey("@host/a_b", "Counter");
  expect(first).not.toBe(second);
  expect(first).toBe(internalDoUniqueKey("@host/a/b", "Counter"));
  for (const key of [first, second, UNIVERSAL_DO_UNIQUE_KEY]) expect(key).toMatch(/^[a-z0-9-]+$/);
});
