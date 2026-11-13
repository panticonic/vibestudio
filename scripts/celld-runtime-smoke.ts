import * as esbuild from "esbuild";
import * as http from "node:http";
import * as fs from "node:fs";
import { runtimeAppBuildOptions, runtimeAppCompilerOutput } from "./runtime-app-build.mjs";
import { captureRuntimeApp } from "./lib/runtime-app.mjs";
import { CelldNode } from "../src/server/celldNode.ts";

const root = process.argv[2]!;
fs.rmSync(root, { recursive: true, force: true });
const app = captureRuntimeApp(runtimeAppCompilerOutput(await esbuild.build(runtimeAppBuildOptions({}))));
const seen: string[] = [];
const proxy = http.createServer((req, res) => { seen.push(`${req.method} ${req.url} id=${req.headers["x-celld-egress-identity"] ? "y" : "n"}`); res.statusCode = 403; res.end("no"); });
await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
const proxyPort = (proxy.address() as any).port;
const node = new CelldNode({ binary: process.env.CELLD!, stateDir: `${root}/celld`, blobRoot: `${root}/blobs`, nodeId: "smoke-node",
  egressProxyUrl: `http://127.0.0.1:${proxyPort}`, egressSecret: "s".repeat(32), onOutput: (s, l) => { if (/ERROR|WARN|error/.test(l)) console.log(s, l); } });
const classes = app.internalClasses;
const internalEnv = Object.fromEntries(classes.map((c) => [c, { RPC_AUTH_TOKEN: `t-${c}` }]));
const bindings = Object.fromEntries(classes.map((c) => [`vibestudio/internal:${c}`, `do_vibestudio_internal_${c}`]));
const t0 = Date.now();
await node.deploy(app.bundle, {
  name: "vibestudio", compatibility_date: "2025-12-01", compatibility_flags: ["nodejs_compat"],
  worker_loaders: [{ binding: "LOADER" }],
  durable_objects: { bindings: [{ name: "UNIVERSAL_DO", class_name: "UniversalDO" }, ...classes.map((c) => ({ name: bindings[`vibestudio/internal:${c}`], class_name: c }))] },
  migrations: [{ tag: "v1", new_sqlite_classes: ["UniversalDO", ...classes] }],
  services: [{ binding: "WORKER_HOST", service: "vibestudio", entrypoint: "WorkerHost" }, { binding: "EXECUTABLE_PREPARATION", service: "vibestudio", entrypoint: "ExecutablePreparation" }],
  celld: { durable_objects: { EvalDO: { codegen: true } } },
  vars: { WORKERD_DO_BINDINGS: bindings, WORKERD_GATEWAY_TOKEN: "gw", WORKERD_DISPATCH_SECRET: "ds", WORKERD_LOADER_SECRET: "ls", GATEWAY_URL: "http://127.0.0.1:9", WORKSPACE_ID: "ws", WORKERD_SESSION_ID: "s", WORKERD_BOOT_GENERATION: "1", INTERNAL_DO_ENV: internalEnv },
});
console.log("deployed in", Date.now() - t0, "ms");
const running = node.start({ listen: 18765, inspector: 18766 });
for (;;) {
  if (running.hasExited) throw new Error("node exited");
  try { const r = await fetch("http://127.0.0.1:18765/__vibestudio_workerd_ready", { headers: { Authorization: "Bearer gw" } }); console.log("ready", r.status, Date.now() - t0, "ms"); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}
const r2 = await fetch("http://127.0.0.1:18765/_w/vibestudio/internal/WebhookStoreDO/k1/ping", { method: "POST", headers: { Authorization: "Bearer gw", "X-Vibestudio-Dispatch-Secret": "ds" }, body: "{}" });
console.log("internal DO", r2.status, (await r2.text()).slice(0, 300));
const ins = await fetch("http://127.0.0.1:18766/json/list"); console.log("inspector", ins.status, (await ins.text()).slice(0, 300));
await running.reload(); console.log("reload ok");
console.log("proxy saw", seen);
console.log("shutdown requested", await running.requestShutdown(), await running.exited);
proxy.close();
