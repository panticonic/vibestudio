import { _electron as electron, expect, test } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { launchManagedServerOwner } from "./managedServerLease";
import { readCurrentHostBuildGeneration } from "../../scripts/host-build-generations.mjs";
import { getProfileDataPath } from "@vibestudio/env-paths";
import { ownDesktop, type OwnedDesktop } from "./ownedDesktop";
import type { TestApp } from "./electronSetup";

const require = createRequire(import.meta.url);

/** A fresh server uses the normal profile's provider configuration; the paired
 * desktop has a disposable profile and keyring. No credentials are copied into
 * fixtures, source files or test artifacts. Every process is owned by this test. */
export async function launchManagedServerApp(
  environment: Record<string, string> = {}
): Promise<TestApp> {
  const root = process.env["VIBESTUDIO_E2E_TEMP_ROOT"];
  if (!root) throw new Error("Managed desktop tests require the E2E run owner");
  const instance = `website-live-${randomUUID().slice(0, 8)}`;
  // Leave room for D-Bus/keyring socket names within Unix socket path limits.
  const directory = fs.mkdtempSync(path.join(root, "d-"));
  const logPath = test.info().outputPath("managed-owner.log");
  const owner = await launchManagedServerOwner(instance, directory, root, logPath, environment);
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  let desktop: OwnedDesktop | undefined;
  const output: string[] = [];
  let pairingLink = "";
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () =>
    (cleanupPromise ??= (async () => {
      const failures: unknown[] = [];
      try {
        if (desktop) {
          try {
            await desktop.close();
          } catch (error) {
            failures.push(error);
          }
          try {
            await desktop.retire();
          } catch (error) {
            failures.push(error);
          }
        } else if (app) {
          // Launched, but ownership never opened: close it through its protocol.
          await app.close();
        }
      } catch (error) {
        failures.push(error);
      }
      try {
        await owner.stop();
      } catch (error) {
        failures.push(error);
      } finally {
        await test.info().attach("managed-owner.log", { path: logPath, contentType: "text/plain" });
        await test.info().attach("paired-desktop.log", {
          body: output.join("").replaceAll(pairingLink || "<no-link>", "<redacted pairing link>"),
          contentType: "text/plain",
        });
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length) throw new AggregateError(failures, "Managed desktop cleanup failed");
    })());
  try {
    console.log(`[website-e2e] provisioning ${instance}`);
    const ready = await owner.ready;
    pairingLink = ready.pairingLink;
    const secrets = ready.secrets;
    console.log(`[website-e2e] pairing disposable desktop to ${instance}`);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...secrets.env,
      NODE_ENV: "development",
      VIBESTUDIO_TEST_MODE: "1",
      VIBESTUDIO_APP_ROOT: process.cwd(),
      ELECTRON_DISABLE_GPU: "1",
      ELECTRON_DISABLE_SANDBOX: "1",
    };
    delete env["VIBESTUDIO_INSTANCE_ROOT"];
    delete env["VIBESTUDIO_INSTANCE"];
    delete env["VIBESTUDIO_WORKSPACE"];
    app = await electron.launch({
      executablePath: require("electron") as string,
      args: [
        "--no-sandbox",
        ...secrets.electronArgs,
        `--user-data-dir=${path.join(directory, "user-data")}`,
        readCurrentHostBuildGeneration(process.cwd(), "desktop"),
        pairingLink,
        "--dev-iroh-remote",
      ],
      env: Object.fromEntries(
        Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
      ),
      timeout: 120_000,
    });
    // The disposable profile's ledgers (the desktop's own hub, executors) live
    // under the secret service's XDG config home.
    const xdgConfigHome = secrets.env["XDG_CONFIG_HOME"];
    desktop = await ownDesktop(app, {
      profileDir: getProfileDataPath(),
      ...(xdgConfigHome ? { appProfileDir: path.join(xdgConfigHome, "vibestudio") } : {}),
      meta: { runRoot: root },
    });
    app.process().stdout?.on("data", (chunk) => output.push(String(chunk)));
    app.process().stderr?.on("data", (chunk) => output.push(String(chunk)));
    const window = await app.firstWindow();
    console.log("[website-e2e] desktop window opened");
    await expect
      .poll(() => app!.evaluate(() => Boolean(globalThis.__testApi)), { timeout: 120_000 })
      .toBe(true);
    const catalog = await app.evaluate(() => globalThis.__testApi!.listWorkspaces());
    const system = catalog.find((entry) => entry.privateRole === "system");
    if (!system) throw new Error("Paired account has no System workspace");
    return {
      app,
      window,
      workspaceId: system.workspaceId,
      systemWorkspaceId: system.workspaceId,
      workspacePath: directory,
      getOutput: () => output.join(""),
      getHubOutput: () => "See managed instance supervisor log",
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw new Error(
      String(error).replaceAll(pairingLink || "<no-link>", "<redacted pairing link>")
    );
  }
}
