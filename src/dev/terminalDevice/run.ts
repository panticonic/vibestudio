import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { clientsMethods } from "@vibestudio/service-schemas/clients";
import { shellApprovalMethods } from "@vibestudio/service-schemas/shellApproval";
import {
  ApprovalSurfaces,
  serveDeviceDriver,
  type DeviceDriverTransport,
} from "@vibestudio/shared/deviceDriver";
import type { PendingApproval } from "@vibestudio/shared/approvals";
import { defaultAcceptance } from "@vibestudio/shared/authority/unitInstallReview";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import type { EventName } from "@vibestudio/shared/events";
import { loadCliIdentity } from "../../cli/credentialStore.js";
import { selectRemoteWorkspace } from "../../cli/remoteClient.js";
import { RpcClient } from "../../cli/rpcClient.js";
import { ChangeSignal } from "../../../hosts/terminal/clientLaunchGate.js";
import { deviceCall, terminalHostDescriptor } from "../../../hosts/terminal/clientDelivery.js";
import { TerminalHostState, terminalHostStatePath } from "../../../hosts/terminal/hostState.js";
import { openServerEvents } from "../../../hosts/terminal/serverEvents.js";
import { binDirectoryOf, createTerminalDevice } from "./terminalDevice.js";
import { terminalDeviceLayout, vibestudioWrapper } from "./layout.js";

/**
 * Run the terminal device until `signal` aborts: pair a fresh CLI profile to
 * the instance with the invite `link`, serve the device operations to the
 * account's system tests, and retire everything on the way out.
 *
 * The process environment must already be the device's own
 * (`terminalDeviceLayout(...).env`): the CLI's credential and path modules
 * bind their stores when they are first imported.
 */
export async function runTerminalDevice(options: {
  root: string;
  repoRoot: string;
  /** Invites for the device under test and for the driver's own connection. */
  links: { device: string; driver: string };
  signal: AbortSignal;
  log(line: string): void;
}): Promise<void> {
  const { root, repoRoot, signal, log } = options;
  const layout = terminalDeviceLayout(root, repoRoot, process.env, "home");
  const driverLayout = terminalDeviceLayout(root, repoRoot, process.env, "driver");
  const bin = binDirectoryOf(layout.home);
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "vibestudio"), vibestudioWrapper(repoRoot), { mode: 0o755 });

  await Promise.all([
    pairWithInvite(path.join(bin, "vibestudio"), layout.env, options.links.device, signal),
    pairWithInvite(path.join(bin, "vibestudio"), driverLayout.env, options.links.driver, signal),
  ]);
  log("paired the terminal under test and the driver's own connection to the instance's account");

  const identity = loadCliIdentity();
  if (!identity || identity.kind !== "device") throw new Error("Pairing left no device profile");
  const systemRoute = await selectRemoteWorkspace(identity, { privateRole: "system" }, { signal });
  const device = new RpcClient(systemRoute, { signal });
  const release = device.retainConnection();
  const failures: unknown[] = [];
  let driver: Awaited<ReturnType<typeof serveDeviceDriver>> | undefined;
  let terminal: ReturnType<typeof createTerminalDevice> | undefined;
  let events: Awaited<ReturnType<typeof openServerEvents>> | undefined;
  try {
    const call = deviceCall(device);
    const version = hostVersion(repoRoot);
    const descriptor = terminalHostDescriptor(version);
    const clients = createTypedServiceClient("clients", clientsMethods, call);
    const approvals = createTypedServiceClient("shellApproval", shellApprovalMethods, call);

    const changes = new ChangeSignal();
    const surfaces = new ApprovalSurfaces(() => approvals.listPending());
    events = await openServerEvents(device);
    // What changes a client's readiness is announced by `clients:changed` (the
    // declarations) and by `supervision:changed` (a build adopted or failed): a
    // launch or a build wait that listened to the first alone would never see
    // an approved client finish building.
    const watched: readonly EventName[] = [
      "clients:changed",
      "supervision:changed",
      "shell-approval:pending-changed",
    ];
    events.events.on("clients:changed", () => changes.bump());
    events.events.on("supervision:changed", () => changes.bump());
    events.events.on("shell-approval:pending-changed", () => surfaces.notify());
    await events.events.subscribeAll(watched);

    terminal = createTerminalDevice(
      {
        clients: {
          list: () => clients.list(descriptor),
          launch: (id) => clients.launch({ host: descriptor, select: { id } }),
          invokeIntent: async (input) =>
            (await call("clients", "invokeIntent", [descriptor, input])) as Record<string, unknown>,
        },
        bootId: async () => {
          const info = (await device.mainCall("auth.getConnectionInfo", [])) as {
            serverBootId: string;
          };
          return info.serverBootId;
        },
        changes,
        approvals: {
          surfaces,
          resolve: async (approvalId, decision) => {
            if (decision !== "accept-review") {
              await approvals.resolve(approvalId, decision);
              return;
            }
            const review = (await approvals.listPending()).find(
              (candidate): candidate is Extract<PendingApproval, { kind: "unit-install-review" }> =>
                candidate.approvalId === approvalId && candidate.kind === "unit-install-review"
            );
            if (!review) throw new Error(`No pending install review ${approvalId}`);
            await approvals.resolveInstallReview(
              approvalId,
              defaultAcceptance(review.mode, review.parts)
            );
          },
        },
        hostState: new TerminalHostState(
          terminalHostStatePath(path.join(layout.env["XDG_CONFIG_HOME"]!, "vibestudio"))
        ),
      },
      { home: layout.home, env: layout.env }
    );

    const transport: DeviceDriverTransport = {
      call: (service, method, args) => call(service, method, args),
      onDirectEvent: (event, listener) => device.onEvent(event, (payload) => listener(payload)),
    };
    driver = await serveDeviceDriver({
      transport,
      deviceKind: "terminal",
      ops: terminal.ops,
      onUndelivered: (error) => log(`an answer was not delivered: ${String(error)}`),
    });
    log(`terminal device ready (home ${layout.home})`);
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
  } finally {
    for (const step of [
      () => driver?.close(),
      () => terminal?.close(),
      () => events?.close(),
      () => release(),
      () => device.close(),
    ]) {
      try {
        await step();
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length)
    throw new AggregateError(failures, "The terminal device did not retire cleanly");
}

function hostVersion(repoRoot: string): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    version?: string;
  };
  return pkg.version ?? "0.0.0";
}

/** `vibestudio remote pair <link>`: the real command, under the device's own profile. */
function pairWithInvite(
  vibestudio: string,
  env: Record<string, string>,
  link: string,
  signal: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(vibestudio, ["remote", "pair", link], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`vibestudio remote pair failed (${code}): ${output.trim()}`));
    });
  });
}
