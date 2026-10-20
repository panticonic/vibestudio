import * as path from "node:path";
import type { OwnedProcess, Ownership } from "@vibestudio/shared/ownership";

/**
 * Device drivers attached for the duration of one system-test command.
 *
 * Client system tests drive a person's device through the server's
 * `deviceDriver` service, so a device host has to be running and registered
 * before the run starts. Each kind has one script that pairs it to the
 * instance and keeps it registered until stopped:
 *
 * - `terminal`: the real `vibestudio` CLI in PTYs, under a HOME of its own;
 * - `desktop`: a headless Electron client under xvfb.
 *
 * Readiness is the script announcing that its driver registered, or the
 * script exiting: both are events, so attaching never waits on a clock.
 *
 * Each driver is a member of the launcher's ownership, killed immediately when
 * retired: the launcher's reaper retires it even if the launcher is killed. A
 * driver script owns its own scratch and children through its own ownership,
 * so retiring its group never strands them.
 */

export const DEVICE_KINDS = ["terminal", "desktop"] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

export function isDeviceKind(value: string): value is DeviceKind {
  return (DEVICE_KINDS as readonly string[]).includes(value);
}

export interface DeviceExecutorSpec {
  script: string;
  /** The line the script prints once its driver is registered. */
  ready: RegExp;
}

export const DEVICE_EXECUTORS: Record<DeviceKind, DeviceExecutorSpec> = {
  terminal: {
    script: "scripts/development-terminal-executor.mjs",
    ready: /terminal device ready/u,
  },
  desktop: {
    script: "scripts/development-client-executor.mjs",
    ready: /desktop device ready/u,
  },
};

interface Attached {
  kind: DeviceKind;
  owned: OwnedProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  output: string[];
  /** Its failure to register was already reported; stopping it adds nothing. */
  failedToStart: boolean;
}

export interface AttachedDeviceDrivers {
  /** Stop every driver and join it; every failure is retained. */
  stop(): Promise<void>;
}

export async function attachDeviceDrivers(input: {
  ownership: Ownership;
  repoRoot: string;
  instanceId: string;
  kinds: readonly DeviceKind[];
  specs?: Record<DeviceKind, DeviceExecutorSpec>;
  log?: (line: string) => void;
}): Promise<AttachedDeviceDrivers> {
  const specs = input.specs ?? DEVICE_EXECUTORS;
  const log = input.log ?? ((line) => console.error(line));
  const attached: Attached[] = [];
  const stopAll = async (): Promise<void> => {
    const results = await Promise.allSettled(attached.map((driver) => stopDriver(driver)));
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, "Device drivers did not all stop cleanly");
  };

  const starts = [...new Set(input.kinds)].map(async (kind) => {
    const spec = specs[kind];
    const owned = input.ownership.spawn(
      process.execPath,
      [path.join(input.repoRoot, spec.script), "--instance", input.instanceId],
      {
        cwd: input.repoRoot,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        kill: "immediate",
        label: `${kind}-device`,
      }
    );
    const child = owned.child;
    const output: string[] = [];
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.once("error", (error) => {
          output.push(String(error));
          resolve({ code: null, signal: null });
        });
        child.once("exit", (code, signal) => resolve({ code, signal }));
      }
    );
    const driver: Attached = { kind, owned, exited, output, failedToStart: false };
    attached.push(driver);
    await new Promise<void>((resolve, reject) => {
      let buffered = "";
      let registered = false;
      const onData = (chunk: Buffer) => {
        buffered += chunk.toString();
        const lines = buffered.split(/\r?\n/u);
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          if (!line) continue;
          output.push(line);
          log(`[system-test] ${kind} device: ${line}`);
          if (spec.ready.test(line)) {
            registered = true;
            resolve();
          }
        }
      };
      child.stdout!.on("data", onData);
      child.stderr!.on("data", onData);
      void exited.then(({ code, signal }) => {
        if (registered) return;
        driver.failedToStart = true;
        reject(
          new Error(
            `The ${kind} device driver exited before it registered (${signal ?? code}):\n${output.slice(-20).join("\n")}`
          )
        );
      });
    });
  });

  const settled = await Promise.allSettled(starts);
  const failures = settled.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []
  );
  if (failures.length > 0) {
    try {
      await stopAll();
    } catch (cleanup) {
      failures.push(cleanup);
    }
    throw failures.length === 1
      ? failures[0]
      : new AggregateError(failures, "Device drivers could not be attached");
  }
  return { stop: stopAll };
}

async function stopDriver(driver: Attached): Promise<void> {
  const { child } = driver.owned;
  // A driver that ended on its own after registering was not stopped by us.
  const endedBySelf = child.exitCode !== null || child.signalCode !== null;
  await driver.owned.retire();
  const { code, signal } = await driver.exited;
  if (driver.failedToStart || !endedBySelf) return;
  if (code !== 0) {
    throw new Error(
      `The ${driver.kind} device driver ended on its own (${signal ?? code}):\n${driver.output.slice(-20).join("\n")}`
    );
  }
}
