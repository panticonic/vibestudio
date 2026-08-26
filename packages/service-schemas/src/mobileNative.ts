import { z } from "zod";
import { requirementForPrincipals } from "@vibestudio/shared/authorization";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";

const nonEmpty = z.string().min(1);
const nativeAuthority = {
  requirement: requirementForPrincipals(["host", "code"], "native.mobile.execute"),
  resource: { kind: "literal" as const, key: "native.mobile" },
};
const device = z
  .object({
    serial: nonEmpty,
    state: z.enum(["device", "unauthorized", "offline"]),
    model: nonEmpty.optional(),
  })
  .strict();
const iosDevice = z
  .object({ udid: nonEmpty, name: nonEmpty, state: nonEmpty, runtime: nonEmpty })
  .strict();
const optionalDevice = z.object({ device: nonEmpty.optional() }).strict().optional();
const inspect = (action: string, description: string) => ({
  capability: "native.mobile.execute",
  presentation: {
    title: "Access a mobile runtime",
    action,
    description,
    group: "runtime" as const,
    authorityCategory: { domain: "people" as const, verb: "manage" as const },
  },
  tier: {
    tier: "gated" as const,
    session: "codeOnly" as const,
    residency: "native-effect" as const,
    family: "mobile-native.execute",
    rationale: "Reads private state from a host mobile toolchain or attached device",
  },
  authority: nativeAuthority,
  access: { sensitivity: "read" as const },
});
const execute = (action: string, description: string) => ({
  capability: "native.mobile.execute",
  presentation: {
    title: "Change a mobile runtime",
    action,
    description,
    group: "runtime" as const,
    authorityCategory: { domain: "people" as const, verb: "manage" as const },
  },
  tier: {
    tier: "gated" as const,
    session: "codeOnly" as const,
    residency: "native-effect" as const,
    family: "mobile-native.execute",
    rationale: "Runs a reviewed mobile build or device command against the installed host scaffold",
  },
  authority: nativeAuthority,
  access: { sensitivity: "write" as const },
});

export const mobileNativeMethods = defineServiceMethods({
  doctor: {
    description:
      "Inspect host mobile tooling, attached devices, and the current internal artifact.",
    args: z.tuple([]),
    returns: z
      .object({
        adb: z.boolean(),
        xcrun: z.boolean(),
        xcodebuild: z.boolean(),
        androidSourceBuildAvailable: z.boolean(),
        iosSourceBuildAvailable: z.boolean(),
        device: device.optional(),
        deviceAbi: nonEmpty.nullable(),
        iosSimulator: iosDevice.optional(),
        apkSigned: z.boolean(),
        apkBytes: z.number().int().nonnegative().nullable(),
        issues: z.array(z.string()),
      })
      .strict(),
    ...inspect(
      "inspect mobile development status",
      "Check the host toolchain and attached mobile devices."
    ),
  },
  listDevices: {
    description: "List Android devices visible to adb.",
    args: z.tuple([]),
    returns: z.array(device),
    ...inspect(
      "list attached Android devices",
      "Read identifiers and status for Android devices visible to adb."
    ),
  },
  listIosSimulators: {
    description: "List iOS simulators visible to Xcode.",
    args: z.tuple([]),
    returns: z.array(iosDevice),
    ...inspect("list iOS simulators", "Read identifiers and status for local iOS simulators."),
  },
  buildAndroid: {
    description: "Build the installed host's Android native shell for selected architectures.",
    args: z.tuple([
      z
        .object({
          device: nonEmpty.optional(),
          architectures: z.array(nonEmpty).optional(),
        })
        .strict()
        .optional(),
    ]),
    returns: z
      .object({
        apkBytes: z.number().int().nonnegative(),
        architectures: z.array(nonEmpty),
        durationMs: z.number().int().nonnegative(),
      })
      .strict(),
    ...execute(
      "build the Android app",
      "Build the internal Vibestudio Android shell for development testing."
    ),
  },
  installAndroid: {
    description: "Build and install the internal Android shell on an attached device.",
    args: z.tuple([
      z
        .object({
          device: nonEmpty.optional(),
          resetApp: z.boolean().optional(),
          launch: z.boolean().optional(),
        })
        .strict()
        .optional(),
    ]),
    returns: z.object({ packageName: nonEmpty }).strict(),
    ...execute(
      "install the Android app",
      "Build and install Vibestudio on an attached Android device."
    ),
  },
  installIos: {
    description: "Build and install the iOS shell on a simulator or device.",
    args: z.tuple([
      z
        .object({
          device: nonEmpty.optional(),
          simulator: z.boolean().optional(),
          configuration: z.enum(["Debug", "Release", "Internal"]).optional(),
          launch: z.boolean().optional(),
        })
        .strict()
        .optional(),
    ]),
    returns: z.object({ bundleId: nonEmpty }).strict(),
    ...execute(
      "install the iOS app",
      "Build and install Vibestudio on an iOS simulator or device."
    ),
  },
  launchAndroid: {
    description: "Launch an installed Android package.",
    args: z.tuple([
      z
        .object({ device: nonEmpty.optional(), packageName: nonEmpty.optional() })
        .strict()
        .optional(),
    ]),
    returns: z.void(),
    ...execute("launch the Android app", "Launch Vibestudio on an attached Android device."),
  },
  launchIos: {
    description: "Launch an installed iOS bundle.",
    args: z.tuple([
      z.object({ device: nonEmpty.optional(), bundleId: nonEmpty.optional() }).strict().optional(),
    ]),
    returns: z.void(),
    ...execute("launch the iOS app", "Launch Vibestudio on an iOS simulator or device."),
  },
  clearAndroidApp: {
    description: "Clear an Android package's application data.",
    args: z.tuple([
      z
        .object({ device: nonEmpty.optional(), packageName: nonEmpty.optional() })
        .strict()
        .optional(),
    ]),
    returns: z.void(),
    ...execute(
      "reset the Android app",
      "Clear Vibestudio application data on an attached Android device."
    ),
  },
  adbReverse: {
    description: "Configure adb reverse-port mappings.",
    args: z.tuple([
      z
        .object({
          device: nonEmpty.optional(),
          ports: z.array(z.tuple([z.number().int().positive(), z.number().int().positive()])),
        })
        .strict(),
    ]),
    returns: z.void(),
    ...execute(
      "configure Android port routing",
      "Expose selected host ports to an attached Android device."
    ),
  },
  screenshot: {
    description: "Capture an Android device screenshot.",
    args: z.tuple([optionalDevice]),
    returns: z.object({ pngBase64: nonEmpty }).strict(),
    ...inspect(
      "capture an Android screenshot",
      "Read the current screen of an attached Android device."
    ),
  },
  screenshotIos: {
    description: "Capture an iOS simulator screenshot.",
    args: z.tuple([optionalDevice]),
    returns: z.object({ pngBase64: nonEmpty }).strict(),
    ...inspect("capture an iOS screenshot", "Read the current screen of an iOS simulator."),
  },
  verify: {
    description: "Verify Android installation and rendering state.",
    args: z.tuple([
      z
        .object({ device: nonEmpty.optional(), packageName: nonEmpty.optional() })
        .strict()
        .optional(),
    ]),
    returns: z
      .object({
        installed: z.boolean(),
        bundleActive: z.boolean(),
        rendering: z.boolean(),
        screenshotCaptured: z.boolean(),
        screenshotBytes: z.number().int().nonnegative(),
        issues: z.array(z.string()),
      })
      .strict(),
    ...inspect(
      "inspect an Android app",
      "Read installation, process, and rendering state from an attached Android device."
    ),
  },
  verifyWorkspaceReady: {
    description: "Wait for the Android workspace shell readiness markers.",
    args: z.tuple([
      z
        .object({
          device: nonEmpty.optional(),
          packageName: nonEmpty.optional(),
          sinceMs: z.number().int().nonnegative().optional(),
          timeoutMs: z.number().int().positive().optional(),
        })
        .strict()
        .optional(),
    ]),
    returns: z
      .object({
        ready: z.boolean(),
        workspaceConnected: z.boolean(),
        panelHostReady: z.boolean(),
        panelWebViewLoaded: z.boolean(),
        issues: z.array(z.string()),
      })
      .strict(),
    ...inspect(
      "inspect Android workspace readiness",
      "Read process logs from an attached Android device until its workspace is ready."
    ),
  },
  logcat: {
    description: "Stream Android logs.",
    args: z.tuple([
      z
        .object({
          device: nonEmpty.optional(),
          packageName: nonEmpty.optional(),
          filter: nonEmpty.optional(),
        })
        .strict()
        .optional(),
    ]),
    ...inspect("stream Android device logs", "Read live logs from an attached Android device."),
  },
  logsIos: {
    description: "Stream iOS simulator logs.",
    args: z.tuple([
      z.object({ device: nonEmpty.optional(), predicate: nonEmpty.optional() }).strict().optional(),
    ]),
    ...inspect("stream iOS simulator logs", "Read live logs from an iOS simulator."),
  },
  shell: {
    description: "Run and stream an Android shell command.",
    args: z.tuple([
      z
        .object({
          device: nonEmpty.optional(),
          command: nonEmpty,
          args: z.array(z.string()).optional(),
        })
        .strict(),
    ]),
    ...execute(
      "run an Android device command",
      "Run a reviewed shell command on an attached Android device."
    ),
  },
});
