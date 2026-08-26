import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildAndroidApp,
  parseAdbDevices,
  pickAndroidDevice,
  validateAndroidArchitectures,
} from "../scripts/cli/lib/mobile-native-android.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("host Android native primitive", () => {
  it("parses and selects adb devices without hiding authorization state", () => {
    const devices = parseAdbDevices(
      "List of devices attached\nphone-1 device product:x model:Pixel_9\nphone-2 unauthorized usb:1\n"
    );
    expect(devices).toEqual([
      { serial: "phone-1", state: "device", model: "Pixel_9" },
      { serial: "phone-2", state: "unauthorized" },
    ]);
    expect(pickAndroidDevice(devices, "phone-1").serial).toBe("phone-1");
    expect(() => pickAndroidDevice(devices, "phone-2")).toThrow(/unauthorized/);
  });

  it("rejects unsupported ABIs and de-duplicates supported ones", () => {
    expect(validateAndroidArchitectures(["arm64-v8a", "arm64-v8a", "x86_64"])).toEqual([
      "arm64-v8a",
      "x86_64",
    ]);
    expect(() => validateAndroidArchitectures(["mips"])).toThrow(/Unsupported Android ABI/);
  });

  it("runs the resource-bounded Gradle build from the host-owned scaffold", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-mobile-native-"));
    roots.push(root);
    const android = path.join(root, "apps/mobile/android");
    fs.mkdirSync(path.join(root, "apps/mobile"), { recursive: true });
    fs.writeFileSync(path.join(root, "apps/mobile/package.json"), "{}");
    fs.writeFileSync(path.join(root, "apps/mobile/index.js"), "");
    fs.mkdirSync(path.join(root, "node_modules/react-native"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules/react-native/package.json"), "{}");
    const apk = path.join(android, "app/build/outputs/apk/internal/app-internal.apk");
    fs.mkdirSync(path.dirname(apk), { recursive: true });
    fs.writeFileSync(apk, "apk");
    const gradlew = path.join(android, "gradlew");
    fs.writeFileSync(gradlew, "#!/bin/sh\nprintf '%s\\n' \"$@\" > gradle-args.txt\n");
    fs.chmodSync(gradlew, 0o755);

    const receipt = await buildAndroidApp({
      appRoot: root,
      architectures: ["arm64-v8a"],
      rerunTasks: true,
    });

    expect(receipt).toMatchObject({ apkPath: apk, apkBytes: 3, architectures: ["arm64-v8a"] });
    expect(fs.readFileSync(path.join(android, "gradle-args.txt"), "utf8")).toBe(
      [
        "assembleInternal",
        "--no-daemon",
        "--max-workers=2",
        "-Pkotlin.compiler.execution.strategy=in-process",
        "--rerun-tasks",
        "-PreactNativeArchitectures=arm64-v8a",
        "",
      ].join("\n")
    );
  });
});
