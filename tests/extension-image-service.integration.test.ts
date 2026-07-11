import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { envelopeFromMessage } from "@vibestudio/rpc";
import { afterEach, describe, expect, it } from "vitest";

interface ReadyPayload {
  gatewayUrl: string;
  connectUrl: string;
  rootInvites: { desktop: { code: string } } | null;
  workspaces: Array<{ name: string; workspaceId: string }>;
}

const RUN_SERVER_INTEGRATION = process.env["VIBESTUDIO_RUN_SERVER_INTEGRATION"] === "1";
const serverPath = path.resolve(process.cwd(), "dist", "server.mjs");
const maybeDescribe =
  RUN_SERVER_INTEGRATION && fs.existsSync(serverPath) ? describe : describe.skip;

let proc: ChildProcessWithoutNullStreams | null = null;
let tempRoot: string | null = null;

afterEach(async () => {
  if (proc && proc.exitCode === null) {
    proc.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 8_000);
      proc?.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
  proc = null;
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

maybeDescribe("image-service extension server smoke", () => {
  it("approves declared extensions then invokes image-service through the server RPC surface", async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-extension-server-smoke-"));
    const readyFile = path.join(tempRoot, "ready.json");
    proc = spawn(
      process.execPath,
      [serverPath, "--ephemeral", "--serve-panels", "--ready-file", readyFile],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_ENV: "development",
          HOME: tempRoot,
          XDG_CONFIG_HOME: path.join(tempRoot, ".config"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    let serverOutput = "";
    const appendServerOutput = (chunk: Buffer | string): void => {
      serverOutput += String(chunk);
      if (serverOutput.length > 20_000) serverOutput = serverOutput.slice(-20_000);
    };
    proc.stdout.on("data", appendServerOutput);
    proc.stderr.on("data", (chunk) => {
      appendServerOutput(chunk);
    });

    try {
      const ready = await waitForReadyFile(readyFile, proc, () => serverOutput);
      const shellToken = await issueShellToken(ready);

      // Extensions are declared in meta/vibestudio.yml; the startup reconcile raises
      // one joint approval. Approve it as the shell would, then wait for the
      // image-service process to come up.
      const approvalId = await waitForUnitBatchApproval(ready, shellToken);
      await rpc(ready, shellToken, "shellApproval.resolve", [approvalId, "once"]);
      const provenance = await rpc<Array<{ approvalId: string; workspaceId: string }>>(
        ready,
        shellToken,
        "governance.list",
        [{ filter: { recordKind: "approval" } }]
      );
      expect(provenance).toContainEqual(
        expect.objectContaining({
          approvalId,
          workspaceId: ready.workspaces[0]!.workspaceId,
        })
      );
      await waitForExtensionRunning(ready, shellToken, "@workspace-extensions/image-service");

      await expect(
        rpc(ready, shellToken, "extensions.invoke", [
          "@workspace-extensions/image-service",
          "detectMimeType",
          [[137, 80, 78, 71, 13, 10, 26, 10]],
        ])
      ).resolves.toBe("image/png");
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nServer output:\n${serverOutput}`,
        { cause: error }
      );
    }
  }, 120_000);
});

async function waitForUnitBatchApproval(ready: ReadyPayload, shellToken: string): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const pending = await rpc<Array<{ approvalId: string; kind: string }>>(
      ready,
      shellToken,
      "shellApproval.listPending",
      []
    );
    const batch = pending.find((p) => p.kind === "unit-batch");
    if (batch) return batch.approvalId;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("unit-batch approval never appeared");
}

async function waitForExtensionRunning(
  ready: ReadyPayload,
  shellToken: string,
  name: string
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const extensions = await rpc<Array<{ name: string; status: string; lastError: string | null }>>(
      ready,
      shellToken,
      "extensions.list",
      []
    );
    const entry = extensions.find((e) => e.name === name);
    if (entry?.status === "running") return;
    if (entry?.status === "error") throw new Error(`${name} failed: ${entry.lastError}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${name} never reached running state`);
}

async function waitForReadyFile(
  readyFile: string,
  child: ChildProcessWithoutNullStreams,
  getStderr: () => string
): Promise<ReadyPayload> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(readyFile)) {
      return JSON.parse(fs.readFileSync(readyFile, "utf8")) as ReadyPayload;
    }
    if (child.exitCode !== null) {
      throw new Error(`server exited before ready: ${child.exitCode}\n${getStderr()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`server did not write ready file\n${getStderr()}`);
}

async function issueShellToken(ready: ReadyPayload): Promise<string> {
  const code = ready.rootInvites?.desktop.code;
  const workspace = ready.workspaces[0]?.name;
  if (!code || !workspace) throw new Error("fresh hub did not advertise a root invite/workspace");
  const pairedResponse = await fetch(`${ready.connectUrl}/_r/s/auth/complete-pairing`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      handle: "extension-smoke",
      displayName: "Extension Smoke",
      label: "Vitest extension smoke",
      platform: "test",
    }),
  });
  const paired = (await pairedResponse.json()) as {
    deviceId?: unknown;
    refreshToken?: unknown;
    shellToken?: unknown;
    error?: unknown;
  };
  if (
    !pairedResponse.ok ||
    typeof paired.deviceId !== "string" ||
    typeof paired.refreshToken !== "string" ||
    typeof paired.shellToken !== "string"
  ) {
    throw new Error(
      `failed to pair root device (${pairedResponse.status}): ${JSON.stringify(paired)}`
    );
  }
  const routeResponse = await fetch(`${ready.connectUrl}/rpc`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${paired.shellToken}`,
    },
    body: JSON.stringify({
      method: "hubControl.routeWorkspace",
      args: [{ workspace }],
    }),
  });
  const routePayload = (await routeResponse.json()) as {
    result?: { serverUrl?: unknown };
    error?: unknown;
  };
  const route = routePayload.result;
  if (!routeResponse.ok || typeof route?.serverUrl !== "string") {
    throw new Error(
      `failed to route workspace (${routeResponse.status}): ${JSON.stringify(routePayload)}`
    );
  }
  ready.gatewayUrl = route.serverUrl;
  const refreshResponse = await fetch(`${route.serverUrl}/_r/s/auth/refresh-shell`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: paired.deviceId, refreshToken: paired.refreshToken }),
  });
  const refreshed = (await refreshResponse.json()) as { shellToken?: unknown; error?: unknown };
  if (!refreshResponse.ok || typeof refreshed.shellToken !== "string") {
    throw new Error(
      `failed to refresh child shell (${refreshResponse.status}): ${JSON.stringify(refreshed)}`
    );
  }
  return refreshed.shellToken;
}

async function rpc<T = unknown>(
  ready: ReadyPayload,
  shellToken: string,
  method: string,
  args: unknown[]
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${ready.gatewayUrl}/rpc`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${shellToken}`,
      },
      body: JSON.stringify(
        envelopeFromMessage({
          from: "extension-image-service-integration",
          target: "main",
          callerKind: "shell",
          message: {
            type: "request",
            requestId: randomUUID(),
            fromId: "extension-image-service-integration",
            method,
            args,
          },
        })
      ),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new Error(`RPC ${method} did not respond`, { cause: error });
  }
  const json = (await response.json()) as
    | { error?: string }
    | { message?: { result?: T; error?: string } }
    | { envelope?: { message?: { result?: T; error?: string } } };
  const body =
    "envelope" in json ? json.envelope?.message : "message" in json ? json.message : json;
  if (!response.ok || body?.error) {
    throw new Error(body?.error ?? `RPC ${method} failed with status ${response.status}`);
  }
  return body?.result as T;
}
