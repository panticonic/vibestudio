import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { envelopeFromMessage } from "@vibestudio/rpc";
import type { PendingUnitInstallReviewApproval } from "@vibestudio/shared/approvals";
import { defaultAcceptance } from "@vibestudio/shared/authority/unitInstallReview";
import {
  developmentBaseSelectionEnv,
  resolveDevelopmentBaseSelection,
} from "../src/dev/developmentBaseSelection.js";
import { afterEach, describe, expect, it } from "vitest";

interface ReadyPayload {
  gatewayUrl: string;
  rootInvite: { code: string } | null;
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
}, 20_000);

maybeDescribe("image-service extension server smoke", () => {
  it("builds the declared extension then invokes it through the server RPC surface", async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-extension-server-smoke-"));
    const readyFile = path.join(tempRoot, "ready.json");
    const developmentBase = await resolveDevelopmentBaseSelection({
      repoRoot: process.cwd(),
      checkpointTarget: path.join(tempRoot, "base-checkpoint"),
    });
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
          ...(developmentBase ? developmentBaseSelectionEnv(developmentBase) : {}),
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

      // This server-only smoke has no native bootstrap UI, so it settles both
      // host launch-gate reviews and the in-workspace creation review through
      // their shared shellApproval contract.
      await approveStartupInstallReviews(ready, shellToken);
      await waitForExtensionAvailable(ready, shellToken, "@workspace-extensions/image-service");

      // image-service is declared onInvoke: startup admits it without spending
      // a cold build, and the first real operation owns materialization.
      await expect(
        rpc(ready, shellToken, "extensions.invoke", [
          "@workspace-extensions/image-service",
          "detectMimeType",
          [[137, 80, 78, 71, 13, 10, 26, 10]],
        ])
      ).resolves.toBe("image/png");
      await waitForExtensionRunning(ready, shellToken, "@workspace-extensions/image-service");
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nServer output:\n${serverOutput}`,
        { cause: error }
      );
    }
  }, 360_000);
});

async function approveStartupInstallReviews(
  ready: ReadyPayload,
  shellToken: string
): Promise<void> {
  const deadline = Date.now() + 180_000;
  for (;;) {
    const state = await rpc<
      | { status: "preparing" | "not-required" | "resolved" | "unresolved" }
      | { status: "pending"; approvalId: string; partCount: number }
      | { status: "failed"; error: string }
    >(ready, shellToken, "shellApproval.getWorkspaceCreationReviewState", []);
    if (state.status === "failed") {
      throw new Error(`Workspace creation review failed: ${state.error}`);
    }
    if (state.status === "unresolved") {
      throw new Error("Workspace creation review was left unresolved");
    }
    const pending = await rpc<PendingUnitInstallReviewApproval[]>(
      ready,
      shellToken,
      "shellApproval.listPending",
      []
    );
    const installReviews = pending.filter(
      (approval): approval is PendingUnitInstallReviewApproval =>
        approval.kind === "unit-install-review"
    );
    for (const approval of installReviews) {
      await rpc(
        ready,
        shellToken,
        "shellApproval.resolveInstallReview",
        [approval.approvalId, defaultAcceptance(approval.mode, approval.parts)],
        { timeoutMs: 180_000 }
      );
    }
    if (
      (state.status === "resolved" || state.status === "not-required") &&
      installReviews.length === 0
    ) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Workspace creation review did not settle: ${JSON.stringify(state)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function waitForExtensionAvailable(
  ready: ReadyPayload,
  shellToken: string,
  name: string
): Promise<void> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const extensions = await rpc<Array<{ name: string; status: string; lastError: string | null }>>(
      ready,
      shellToken,
      "build.listUnits",
      []
    );
    const extension = extensions.find((entry) => entry.name === name);
    if (extension?.status === "available" || extension?.status === "ready") return;
    if (extension?.status === "error") throw new Error(`${name} failed: ${extension.lastError}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${name} was never admitted for on-demand activation`);
}

async function waitForExtensionRunning(
  ready: ReadyPayload,
  shellToken: string,
  name: string
): Promise<void> {
  // A fresh workspace builds every approved extension from source. Keep this
  // above the cold sequential reconcile time; subsequent invocations are fast.
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const extensions = await rpc<
      Array<{
        identity: { kind: string; entityId: string };
        status: string;
        lastError: string | null;
      }>
    >(ready, shellToken, "runtime.supervision.list", [{ kind: "extension" }]);
    const entry = extensions.find((extension) => extension.identity.entityId === name);
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
  const code = ready.rootInvite?.code;
  if (!code) throw new Error("fresh hub did not advertise a root invite");
  const pairedResponse = await fetch(`${ready.gatewayUrl}/_r/s/auth/complete-pairing`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
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
  const workspaces = await rpc<Array<{ workspaceId: string; name: string }>>(
    ready,
    paired.shellToken,
    "hubControl.listWorkspaces",
    []
  );
  const workspace = workspaces[0];
  if (!workspace?.workspaceId) throw new Error("hub exposed no exact workspace identity");
  const route = await rpc<{ serverUrl: string }>(
    ready,
    paired.shellToken,
    "hubControl.routeWorkspace",
    [{ workspaceId: workspace.workspaceId }],
    { timeoutMs: 180_000 }
  );
  if (typeof route.serverUrl !== "string") throw new Error("workspace route had no server URL");
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
  args: unknown[],
  options: { timeoutMs?: number } = {}
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
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
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
