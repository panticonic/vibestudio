import * as esbuild from "esbuild";
import * as http from "node:http";
import * as fs from "node:fs";
import { runtimeAppBuildOptions, runtimeAppCompilerOutput } from "./runtime-app-build.mjs";
import { captureRuntimeApp } from "./lib/runtime-app.mjs";
import { CelldNode } from "../src/server/celldNode.ts";
import { buildRuntimeDeployment } from "../src/server/runtimeDeployment.ts";

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
const { config, secrets } = buildRuntimeDeployment({
  compatibility: { compatibilityDate: "2025-12-01", compatibilityFlags: ["nodejs_compat"] },
  classes: classes.map((c) => ({ className: c, rpcToken: `t-${c}`, env: {}, codegen: c === "EvalDO" })),
  doLoaderSecret: "dls",
  vars: { RUNTIME_GATEWAY_TOKEN: "gw", RUNTIME_DISPATCH_SECRET: "ds", RUNTIME_LOADER_SECRET: "ls", GATEWAY_URL: "http://127.0.0.1:9", WORKSPACE_ID: "ws", WORKERD_SESSION_ID: "s", WORKERD_BOOT_GENERATION: "1" },
});
const t0 = Date.now();
await node.deploy(app.bundle, config, secrets);
console.log("deployed in", Date.now() - t0, "ms");
const running = node.start({ listen: 18765, inspector: 18766 });
for (;;) {
  if (running.hasExited) throw new Error("node exited");
  try { const r = await fetch("http://127.0.0.1:18765/__vibestudio_workerd_ready", { headers: { Authorization: "Bearer gw" } }); console.log("ready", r.status, Date.now() - t0, "ms"); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}
const r2 = await fetch("http://127.0.0.1:18765/_w/vibestudio/internal/WebhookStoreDO/k1/ping", { method: "POST", headers: { Authorization: "Bearer gw", "X-Vibestudio-Dispatch-Secret": "ds" }, body: "{}" });
console.log("internal DO", r2.status, (await r2.text()).slice(0, 300));
const ins = await fetch("http://127.0.0.1:18766/json/list"); console.log("inspector", ins.status, (await ins.text()).slice(0, 300));
const forkBody = JSON.stringify({ op: "fork", namespace: "do_vibestudio_internal_WebhookStoreDO", from: "k1", to: "k2" });
const objectHeaders = { Authorization: "Bearer gw", "X-Vibestudio-Dispatch-Secret": "ds", "Content-Type": "application/json" };
const fork = await fetch("http://127.0.0.1:18765/_object", { method: "POST", headers: objectHeaders, body: forkBody });
console.log("fork", fork.status, (await fork.text()).slice(0, 200));
const again = await fetch("http://127.0.0.1:18765/_object", { method: "POST", headers: objectHeaders, body: forkBody });
console.log("fork again (refused)", again.status, (await again.text()).slice(0, 200));
const restore = await fetch("http://127.0.0.1:18765/_object", { method: "POST", headers: objectHeaders, body: JSON.stringify({ op: "restore", namespace: "do_vibestudio_internal_WebhookStoreDO", from: "k1", to: "k2", stop: true }) });
console.log("restore", restore.status, (await restore.text()).slice(0, 200));
await running.reload(); console.log("reload ok");
console.log("proxy saw", seen);
console.log("shutdown requested", await running.requestShutdown(), await running.exited);
proxy.close();
