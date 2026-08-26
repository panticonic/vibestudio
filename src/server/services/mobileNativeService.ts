import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { mobileNativeMethods } from "@vibestudio/service-schemas/mobileNative";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import {
  INTERNAL_ANDROID_PACKAGE,
  adbArgs,
  buildAndroidApp,
  hasCompleteAndroidSourceProject,
  internalAndroidApkPath,
  listAdbDevices,
  pickAndroidDevice,
  readAndroidDeviceAbi,
  mobileCliEnvironment,
  runNativeCapture,
  runNativeCommand,
} from "../../../scripts/cli/lib/mobile-native-android.mjs";

const iosBundleId = () => process.env["VIBESTUDIO_IOS_BUNDLE_ID"] ?? "app.vibestudio.mobile";

export const mobileNativeServiceDocumentation = {
  name: "mobileNative",
  description: "Host-owned mobile build, device, and diagnostic effects",
  authority: { principals: ["host", "code"] },
  methods: mobileNativeMethods,
} satisfies Omit<ServiceDefinition, "handler">;

export function androidInstallPlan(
  appRoot: string,
  input?: { device?: string; resetApp?: boolean; launch?: boolean }
) {
  if (!hasCompleteAndroidSourceProject(appRoot)) {
    throw Object.assign(
      new Error("Mobile debugging requires a complete Vibestudio source checkout"),
      { code: "EANDROID_BUILD" }
    );
  }
  return {
    packageName: INTERNAL_ANDROID_PACKAGE,
    args: [
      path.join(appRoot, "scripts", "cli", "mobile-install.mjs"),
      "--from-source",
      "--package",
      INTERNAL_ANDROID_PACKAGE,
      ...(input?.resetApp ? ["--reset-app"] : []),
      ...(input?.launch ? ["--launch"] : []),
      ...(input?.device ? ["--device", input.device] : []),
    ],
  };
}

export function createMobileNativeService(deps: { appRoot: string }): ServiceDefinition {
  const root = path.resolve(deps.appRoot);
  const captureAdb = (device: string | undefined, args: string[]) =>
    runNativeCapture("adb", adbArgs(device, args), { cwd: root, errorCode: "EADB" });
  const runAdb = (device: string | undefined, args: string[]) =>
    runNativeCommand("adb", adbArgs(device, args), { cwd: root, errorCode: "EADB" });

  return {
    ...mobileNativeServiceDocumentation,
    handler: defineServiceHandler("mobileNative", mobileNativeMethods, {
      doctor: async () => {
        const adb = await commandWorks(root, "adb", ["version"]);
        const xcrun = await commandWorks(root, "xcrun", ["--version"]);
        const xcodebuild = await commandWorks(root, "xcodebuild", ["-version"]);
        const devices = adb ? await listAdbDevices({ cwd: root }) : [];
        const simulators = xcrun ? await listIosSimulators(root).catch(() => []) : [];
        const ready = devices.filter((candidate) => candidate.state === "device");
        const apkPath = internalAndroidApkPath(root);
        const androidSourceBuildAvailable = hasCompleteAndroidSourceProject(root);
        const iosSourceBuildAvailable = fs.existsSync(
          path.join(root, "apps", "mobile", "ios", "Vibestudio.xcodeproj", "project.pbxproj")
        );
        const issues: string[] = [];
        if (!adb) issues.push("adb is not on PATH");
        if (process.platform === "darwin") {
          if (!xcrun) issues.push("xcrun is not on PATH");
          if (!xcodebuild) issues.push("xcodebuild is not on PATH");
          if (!simulators.some((candidate) => candidate.state === "Booted"))
            issues.push("No booted iOS simulator");
        }
        if (devices.some((candidate) => candidate.state === "unauthorized"))
          issues.push("Accept the Android USB debugging prompt");
        if (ready.length === 0) issues.push("No ready Android device");
        if (ready.length > 1) issues.push("Multiple ready devices; pass a serial");
        if (androidSourceBuildAvailable && !fs.existsSync(apkPath)) {
          issues.push("Internal APK has not been built");
        }
        let deviceAbi: string | null = null;
        if (ready[0]) {
          try {
            deviceAbi = await readAndroidDeviceAbi({ device: ready[0].serial, cwd: root });
          } catch (error) {
            issues.push(
              `Could not determine Android device ABI: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
        return {
          adb,
          xcrun,
          xcodebuild,
          androidSourceBuildAvailable,
          iosSourceBuildAvailable,
          device: ready[0],
          deviceAbi,
          iosSimulator: simulators.find((candidate) => candidate.state === "Booted"),
          apkSigned: fs.existsSync(apkPath),
          apkBytes: fs.existsSync(apkPath) ? fs.statSync(apkPath).size : null,
          issues,
        };
      },
      listDevices: () => listAdbDevices({ cwd: root }),
      listIosSimulators: () => listIosSimulators(root),
      buildAndroid: async (_ctx, [input]) => {
        const { apkPath: _hostPrivatePath, ...receipt } = await buildAndroidApp({
          appRoot: root,
          variant: "internal",
          ...input,
        });
        return receipt;
      },
      installAndroid: async (_ctx, [input]) => {
        const plan = androidInstallPlan(root, input);
        await runNativeCommand(process.execPath, plan.args, {
          cwd: root,
          env: mobileCliEnvironment(root, process.env["VIBESTUDIO_APP_VERSION"]),
          stdio: "inherit",
          errorCode: "EINSTALL",
        });
        return { packageName: plan.packageName };
      },
      installIos: async (_ctx, [input]) => {
        if (
          !fs.existsSync(
            path.join(root, "apps", "mobile", "ios", "Vibestudio.xcodeproj", "project.pbxproj")
          )
        ) {
          throw Object.assign(
            new Error("iOS source installs require a complete Vibestudio source checkout"),
            { code: "EIOS_BUILD" }
          );
        }
        const args = [
          path.join(root, "scripts", "cli", "mobile-install.mjs"),
          "--platform",
          "ios",
          ...(input?.simulator !== false ? ["--simulator"] : []),
          ...(input?.device ? ["--device", input.device] : []),
          "--configuration",
          input?.configuration ?? "Debug",
          ...(input?.launch ? ["--launch"] : []),
        ];
        await runNativeCommand(process.execPath, args, {
          cwd: root,
          env: mobileCliEnvironment(root, process.env["VIBESTUDIO_APP_VERSION"]),
          stdio: "inherit",
          errorCode: "EIOS",
        });
        return { bundleId: iosBundleId() };
      },
      launchAndroid: async (_ctx, [input]) => {
        const packageName = input?.packageName ?? INTERNAL_ANDROID_PACKAGE;
        await runAdb(input?.device, ["shell", "monkey", "-p", packageName, "1"]);
      },
      launchIos: async (_ctx, [input]) => {
        requireMac("launch iOS apps");
        const bundleId = input?.bundleId ?? iosBundleId();
        await runNativeCommand(
          "xcrun",
          input?.device
            ? ["devicectl", "device", "process", "launch", "--device", input.device, bundleId]
            : ["simctl", "launch", "booted", bundleId],
          { cwd: root, errorCode: "EIOS" }
        );
      },
      clearAndroidApp: async (_ctx, [input]) => {
        const packageName = input?.packageName ?? INTERNAL_ANDROID_PACKAGE;
        await runAdb(input?.device, ["shell", "pm", "clear", packageName]);
      },
      adbReverse: async (_ctx, [input]) => {
        for (const [devicePort, hostPort] of input.ports) {
          await runAdb(input.device, ["reverse", `tcp:${devicePort}`, `tcp:${hostPort}`]);
        }
      },
      screenshot: async (_ctx, [input]) => {
        const result = await captureAdb(input?.device, ["exec-out", "screencap", "-p"]);
        return { pngBase64: result.stdout.toString("base64") };
      },
      screenshotIos: async (_ctx, [input]) => {
        requireMac("capture iOS screenshots");
        const result = await runNativeCapture(
          "xcrun",
          ["simctl", "io", input?.device ?? "booted", "screenshot", "-"],
          { cwd: root, errorCode: "EIOS" }
        );
        return { pngBase64: result.stdout.toString("base64") };
      },
      verify: async (_ctx, [input]) => {
        const selected = pickAndroidDevice(await listAdbDevices({ cwd: root }), input?.device);
        const packageName = input?.packageName ?? INTERNAL_ANDROID_PACKAGE;
        const installed =
          (
            await runNativeCapture(
              "adb",
              adbArgs(selected.serial, ["shell", "pm", "path", packageName]),
              { cwd: root, reject: false }
            )
          ).exitCode === 0;
        const rendering =
          installed &&
          (
            await runNativeCapture(
              "adb",
              adbArgs(selected.serial, ["shell", "pidof", packageName]),
              { cwd: root, reject: false }
            )
          ).exitCode === 0;
        let screenshotBytes = 0;
        const issues = installed ? [] : [`${packageName} is not installed`];
        if (rendering) {
          try {
            screenshotBytes = (await captureAdb(selected.serial, ["exec-out", "screencap", "-p"]))
              .stdout.byteLength;
          } catch (error) {
            issues.push(
              `Screenshot failed: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
        return {
          installed,
          bundleActive: rendering,
          rendering,
          screenshotCaptured: screenshotBytes > 0,
          screenshotBytes,
          issues,
        };
      },
      verifyWorkspaceReady: async (_ctx, [input]) => {
        const selected = pickAndroidDevice(await listAdbDevices({ cwd: root }), input?.device);
        return verifyWorkspaceReady(
          root,
          selected.serial,
          input?.packageName ?? INTERNAL_ANDROID_PACKAGE,
          input?.sinceMs ?? Date.now() - 300_000,
          input?.timeoutMs ?? 180_000
        );
      },
      logcat: (_ctx, [input]) =>
        streamAdb(
          root,
          input?.device,
          input?.packageName ?? INTERNAL_ANDROID_PACKAGE,
          input?.filter
        ),
      logsIos: (_ctx, [input]) => {
        requireMac("stream iOS simulator logs");
        return streamProcess(root, "xcrun", [
          "simctl",
          "spawn",
          input?.device ?? "booted",
          "log",
          "stream",
          "--style",
          "compact",
          "--predicate",
          input?.predicate ?? 'process == "Vibestudio"',
        ]);
      },
      shell: (_ctx, [input]) =>
        streamProcess(
          root,
          "adb",
          adbArgs(input.device, ["shell", input.command, ...(input.args ?? [])])
        ),
    }),
  };
}

async function commandWorks(cwd: string, command: string, args: string[]): Promise<boolean> {
  try {
    return (await runNativeCapture(command, args, { cwd, reject: false })).exitCode === 0;
  } catch {
    return false;
  }
}

function requireMac(action: string): void {
  if (process.platform !== "darwin")
    throw Object.assign(new Error(`${action} requires macOS with Xcode`), {
      code: "EIOS_PLATFORM",
    });
}

async function listIosSimulators(
  cwd: string
): Promise<Array<{ udid: string; name: string; state: string; runtime: string }>> {
  requireMac("list iOS simulators");
  const result = await runNativeCapture("xcrun", ["simctl", "list", "devices", "--json"], {
    cwd,
    errorCode: "EIOS",
  });
  const parsed = JSON.parse(result.stdout.toString("utf8")) as {
    devices?: Record<string, Array<{ udid?: string; name?: string; state?: string }>>;
  };
  return Object.entries(parsed.devices ?? {}).flatMap(([runtime, devices]) =>
    devices.flatMap((device) =>
      device.udid && device.name && device.state
        ? [{ udid: device.udid, name: device.name, state: device.state, runtime }]
        : []
    )
  );
}

export function workspaceReadinessFromLog(log: string, sinceMs = 0) {
  const relevant = log
    .split(/\r?\n/u)
    .filter((line) => {
      const timestamp = /^(\d+(?:\.\d+)?)\s/u.exec(line)?.[1];
      return !timestamp || Number(timestamp) * 1000 >= sinceMs;
    })
    .join("\n");
  const panelHostReady = relevant.includes("phase=workspace-panels-initialized");
  const workspaceConnected = relevant.includes("phase=workspace-connected");
  const panelWebViewLoaded = relevant.includes("phase=workspace-panel-webview-loaded");
  const failure = relevant.match(
    /invalid distance code|phase=workspace-(?:login-error|panel-webview-error|panel-webview-http-error|panel-activate-failed)[^\r\n]*/iu
  )?.[0];
  return {
    ready: panelHostReady && workspaceConnected && !failure,
    workspaceConnected,
    panelHostReady,
    panelWebViewLoaded,
    issues: failure ? [failure] : [],
  };
}

async function verifyWorkspaceReady(
  cwd: string,
  device: string,
  packageName: string,
  sinceMs: number,
  rawTimeout: number
) {
  const timeoutMs = Math.min(Math.max(rawTimeout, 1_000), 300_000);
  const deadline = Date.now() + timeoutMs;
  let last = workspaceReadinessFromLog("", sinceMs);
  let readySince: number | null = null;
  while (readySince !== null || Date.now() < deadline) {
    if (readySince !== null && Date.now() - readySince >= 20_000) return last;
    const pid = (
      await runNativeCapture("adb", adbArgs(device, ["shell", "pidof", packageName]), {
        cwd,
        reject: false,
      })
    ).stdout
      .toString("utf8")
      .trim()
      .split(/\s+/u)[0];
    if (!pid) last = { ...last, issues: [`${packageName} is not rendering`] };
    else {
      const logs = await runNativeCapture(
        "adb",
        adbArgs(device, [
          "logcat",
          "-d",
          `--pid=${pid}`,
          "-v",
          "epoch",
          "ReactNativeJS:V",
          "chromium:V",
          "*:S",
        ]),
        { cwd, errorCode: "EADB" }
      );
      last = workspaceReadinessFromLog(logs.stdout.toString("utf8"), sinceMs);
      if (last.issues.length > 0) return last;
      readySince = last.ready ? (readySince ?? Date.now()) : null;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return {
    ...last,
    issues: last.issues.length
      ? last.issues
      : ["The mobile workspace did not become ready before the verification timeout"],
  };
}

function streamAdb(cwd: string, device?: string, packageName?: string, filter?: string): Response {
  if (!packageName)
    return streamProcess(
      cwd,
      "adb",
      adbArgs(device, filter ? ["logcat", "-v", "time", filter] : ["logcat", "-v", "time"])
    );
  const encoder = new TextEncoder();
  let child: ReturnType<typeof spawn> | null = null;
  let cancelled = false;
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          const probe = await runNativeCapture(
            "adb",
            adbArgs(device, ["shell", "pidof", packageName]),
            { cwd, reject: false }
          );
          if (cancelled) return;
          const pid = probe.stdout
            .toString("utf8")
            .split(/\s+/u)
            .find((part) => /^\d+$/u.test(part));
          if (!pid) {
            controller.enqueue(encoder.encode("package process is not running\n"));
            controller.close();
            return;
          }
          child = pipeProcess(
            cwd,
            "adb",
            adbArgs(device, ["logcat", `--pid=${pid}`, "-v", "time", ...(filter ? [filter] : [])]),
            controller
          );
        } catch (error) {
          controller.error(error);
        }
      },
      cancel() {
        cancelled = true;
        child?.kill("SIGTERM");
      },
    }),
    { headers: { "content-type": "application/octet-stream" } }
  );
}

function pipeProcess(
  cwd: string,
  command: string,
  args: string[],
  controller: ReadableStreamDefaultController<Uint8Array>
) {
  const child = spawn(command, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (chunk) => controller.enqueue(Buffer.from(chunk)));
  child.stderr?.on("data", (chunk) => controller.enqueue(Buffer.from(chunk)));
  child.on("error", (error) => controller.error(error));
  child.on("exit", () => controller.close());
  return child;
}

function streamProcess(cwd: string, command: string, args: string[]): Response {
  let child: ReturnType<typeof spawn> | null = null;
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        child = pipeProcess(cwd, command, args, controller);
      },
      cancel() {
        child?.kill("SIGTERM");
      },
    }),
    { headers: { "content-type": "application/octet-stream" } }
  );
}
