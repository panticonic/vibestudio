import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeMobileSmokeLog } from "../scripts/cli/lib/mobile-smoke-log.mjs";

function setup() {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as string | null,
  });
  const log = observeMobileSmokeLog(child, {
    expectedPhases: ["ready"],
    deadlineMs: Date.now() + 60_000,
    packageName: "app.vibestudio.mobile.internal",
  });
  return { child, log };
}

afterEach(() => vi.restoreAllMocks());

describe("mobile smoke log lifecycle", () => {
  it("reassembles chunked phases and counts new occurrences", async () => {
    const { child, log } = setup();
    child.stdout.write("[VibestudioMobileSmoke] pha");
    expect(log.hasPhase("ready")).toBe(false);
    child.stdout.write("se=ready\r\n[VibestudioMobileSmoke] phase=ready\n");
    await expect(log.waitForPhase("ready")).resolves.toBeUndefined();
    await expect(log.waitForPhaseAfter("ready", 1, 1000)).resolves.toBeUndefined();
    expect(log.phaseCount("ready")).toBe(2);
  });

  it("reports the app crash and its cause instead of accepting an earlier ready phase", async () => {
    const { child, log } = setup();
    child.stdout.write("[VibestudioMobileSmoke] phase=ready\n");
    child.stdout.write("E/AndroidRuntime: FATAL EXCEPTION: main\n");
    child.stdout.write("E/AndroidRuntime: Process: app.vibestudio.mobile.internal, PID: 42\n");
    child.stdout.write(
      "E/AndroidRuntime: java.lang.IllegalArgumentException: Invalid origin rule\n"
    );
    expect(() => log.hasPhase("ready")).toThrow("The Android app crashed");
    await expect(log.waitForPhase("ready")).rejects.toThrow("Invalid origin rule");
    await expect(log.waitForAnyPhase(["ready"])).rejects.toThrow("The Android app crashed");
    await expect(log.waitForPhaseAfter("ready", 0, 1000)).rejects.toThrow(
      "The Android app crashed"
    );
  });

  it("does not attribute another Android package's crash to the app", async () => {
    const { child, log } = setup();
    child.stdout.write(
      "E/AndroidRuntime: Process: app.vibestudio.mobile.internal.other, PID: 42\n"
    );
    child.stdout.write("[VibestudioMobileSmoke] phase=ready\n");
    await expect(log.waitForPhase("ready")).resolves.toBeUndefined();
  });

  it("reports terminal pairing failure even when a success phase was observed", async () => {
    const { child, log } = setup();
    child.stdout.write("[VibestudioMobileSmoke] phase=ready\n");
    child.stdout.write("[VibestudioMobileSmoke] phase=embedded-pairing-failed\n");
    await expect(log.waitForPhase("ready")).rejects.toThrow("terminal pairing failure");
  });

  it("fails immediately when adb cannot start or is terminated by a signal", async () => {
    const first = setup();
    first.child.emit("error", new Error("spawn adb ENOENT"));
    await expect(first.log.waitForPhase("ready")).rejects.toThrow("spawn adb ENOENT");
    const second = setup();
    second.child.signalCode = "SIGKILL";
    await expect(second.log.waitForPhase("ready")).rejects.toThrow("adb logcat exited (SIGKILL)");
  });
});
