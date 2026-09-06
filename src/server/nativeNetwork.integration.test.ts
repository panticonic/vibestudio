import { afterEach, expect, it, vi } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, get, type Server } from "node:http";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertMxcPrerequisites, compileMxcLaunch } from "@vibestudio/process-adapter/mxc";
import { getMxcExecutable } from "@vibestudio/shared/runtimePaths";
import { prepareNativeRuntime } from "./nativeRuntimeResources.js";

const roots: string[] = [];
const children: Array<{ child: ChildProcessWithoutNullStreams; closed: Promise<unknown> }> = [];
const servers: Server[] = [];
async function stopChild(record: (typeof children)[number]): Promise<void> {
  if (record.child.exitCode === null && record.child.signalCode === null)
    record.child.stdin.end("stop\n");
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      record.closed,
      new Promise((_, reject) => {
        deadline = setTimeout(
          () => reject(new Error("Native network fixture failed to close")),
          12000
        );
      }),
    ]);
  } catch (error) {
    record.child.kill("SIGKILL");
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}
afterEach(async () => {
  const stopped = await Promise.allSettled(children.splice(0).map(stopChild));
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  const failure = stopped.find((result) => result.status === "rejected");
  if (failure) {
    roots.length = 0;
    throw new Error("Native network fixture paths retained after incomplete retirement", {
      cause: failure,
    });
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function request(port: number): Promise<{ connected: boolean; body?: string; error?: string }> {
  return new Promise((resolve) => {
    const req = get({ host: "127.0.0.1", port, path: "/" }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += String(chunk);
      });
      res.on("end", () => resolve({ connected: true, body }));
    });
    req.on("error", (error: NodeJS.ErrnoException) =>
      resolve({ connected: false, error: error.code })
    );
    req.setTimeout(1500, () =>
      req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }))
    );
  });
}

it("permits developer HTTP clients/listeners and keeps internal cleanup offline", async () => {
  const platform = process.platform;
  if (platform !== "linux" && platform !== "darwin" && platform !== "win32")
    throw new Error(`Unsupported MXC target: ${platform}`);
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "vibestudio-native-network-")));
  roots.push(root);
  const runtimeRoot = path.join(root, "runtime");
  const home = path.join(root, "home");
  mkdirSync(runtimeRoot);
  mkdirSync(home);
  const runtime = prepareNativeRuntime({ runtimeRoot, platform });
  const appRoot = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
  const launcher = getMxcExecutable(appRoot);
  let hostRequests = 0;
  const server = createServer((_req, res) => {
    hostRequests++;
    res.end("host-endpoint");
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture HTTP address");
  expect(await request(address.port)).toEqual({ connected: true, body: "host-endpoint" });
  const entry = path.join(runtimeRoot, "probe.cjs");
  writeFileSync(
    entry,
    `
    const http = require('node:http');
    const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
    send({ type: 'environment', ownerSecret: process.env.MXC_TRUSTED_OWNER_SECRET ?? null });
    const mode = process.argv[2];
    const timer = setTimeout(() => process.exit(124), 25000);
    process.stdin.on('data', () => { clearTimeout(timer); process.exit(0); });
    process.stdin.on('end', () => { clearTimeout(timer); process.exit(0); });
    const request = http.get({ host: '127.0.0.1', port: ${address.port}, path: '/' }, response => {
      let body = '';
      response.on('data', data => body += data);
      response.on('end', () => send({ type: 'outbound', connected: true, body }));
    });
    request.on('error', error => send({ type: 'outbound', connected: false, error: error.code }));
    request.setTimeout(1500, () => request.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    if (mode === 'allow') {
      let dnsLookup = false;
      let trustWriteDenied = false;
      try { require('node:fs').writeFileSync(process.env.NODE_EXTRA_CA_CERTS, 'tampered'); }
      catch { trustWriteDenied = true; }
      const internet = require('node:https').get('https://github.com/robots.txt', response => {
        const tlsAuthenticated = response.socket.authorized === true;
        let body = '';
        response.on('data', data => {
          body += data;
          if (body.length > 65536) response.destroy(new Error('HTTPS fixture response exceeded 64 KiB'));
        });
        response.on('error', error => send({ type: 'internet', error: error.message }));
        response.on('end', () => send({ type: 'internet', status: response.statusCode, tlsAuthenticated, dnsLookup, trustWriteDenied, robots: /user-agent/i.test(body) }));
      });
      internet.on('socket', socket => socket.on('lookup', (error, _address, _family, hostname) => {
        if (!error && hostname === 'github.com') dnsLookup = true;
      }));
      internet.on('error', error => send({ type: 'internet', error: error.code + ': ' + error.message }));
      internet.setTimeout(15000, () => internet.destroy(new Error('Public DNS/HTTPS probe timed out after 15 seconds')));
      const listener = http.createServer((_req, res) => res.end('sandbox-endpoint'));
      listener.on('error', error => send({ type: 'listener', listening: false, error: error.code }));
      listener.listen(0, '127.0.0.1', () => send({ type: 'listener', listening: true, port: listener.address().port }));
    }
  `
  );
  for (const network of ["allow", "deny"] as const) {
    const launch = compileMxcLaunch(
      {
        platform,
        launcher,
        containerId: `vibestudio-network-${network}-${Date.now()}`,
        argv: [runtime.executable, entry, network],
        cwd: home,
        guestEnvironment: {
          ...runtime.environment,
          HOME: home,
          PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        },
        readPaths: runtime.readPaths,
        writePaths: [home],
        network,
      },
      { ...process.env, MXC_TRUSTED_OWNER_SECRET: "synthetic-owner-only" }
    );
    expect(launch.environment["MXC_TRUSTED_OWNER_SECRET"]).toBe("synthetic-owner-only");
    await assertMxcPrerequisites({ platform, launcher, environment: launch.environment });
    const before = hostRequests;
    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: launch.environment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const record = { child, closed: once(child, "close") };
    children.push(record);
    let output = "";
    let stderr = "";
    const records: Array<Record<string, unknown>> = [];
    child.stderr.on("data", (data) => {
      stderr = (stderr + String(data)).slice(-16384);
    });
    child.stdout.on("data", (data) => {
      output += String(data);
      for (;;) {
        const end = output.indexOf("\n");
        if (end < 0) break;
        records.push(JSON.parse(output.slice(0, end)));
        output = output.slice(end + 1);
      }
    });
    await vi.waitFor(
      () => {
        if (child.exitCode !== null)
          throw new Error(`Native network probe exited ${child.exitCode}: ${stderr}`);
        expect(records.some((value) => value["type"] === "outbound")).toBe(true);
        if (network === "allow")
          expect(records.some((value) => value["type"] === "listener")).toBe(true);
      },
      { timeout: 5000 }
    );
    const outbound = records.find((value) => value["type"] === "outbound")!;
    expect(records.find((value) => value["type"] === "environment")).toEqual({
      type: "environment",
      ownerSecret: null,
    });
    if (network === "deny") {
      expect(outbound["connected"]).toBe(false);
      expect(hostRequests).toBe(before);
    } else {
      const listener = records.find((value) => value["type"] === "listener")!;
      const inbound = listener["listening"]
        ? await request(listener["port"] as number)
        : { connected: false, error: String(listener["error"]) };
      expect(outbound).toEqual({ type: "outbound", connected: true, body: "host-endpoint" });
      expect(listener["listening"]).toBe(true);
      expect(inbound).toEqual({ connected: true, body: "sandbox-endpoint" });
      expect(hostRequests).toBe(before + 1);
      await vi.waitFor(
        () => {
          if (child.exitCode !== null)
            throw new Error(`DNS/HTTPS probe exited ${child.exitCode}: ${stderr}`);
          expect(records.some((value) => value["type"] === "internet")).toBe(true);
        },
        { timeout: 20000 }
      );
      const internet = records.find((value) => value["type"] === "internet")!;
      expect(internet, `Native public DNS/HTTPS failure: ${JSON.stringify(internet)}`).toEqual({
        type: "internet",
        status: 200,
        tlsAuthenticated: true,
        dnsLookup: true,
        trustWriteDenied: true,
        robots: true,
      });
    }
    await stopChild(record);
    expect(child.exitCode).toBe(0);
  }
}, 30000);
