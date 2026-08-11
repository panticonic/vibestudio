// @ts-expect-error Script modules are plain .mjs and intentionally untyped.
import {
  privateLanIpv4,
  relayOnlyServerEnv,
  requiresLocalTurn,
  signalingTurnVars,
  startLocalTurnRelay,
} from "../scripts/cli/lib/local-turn.mjs";
// @ts-expect-error Script modules are plain .mjs and intentionally untyped.
import {
  parseAndroidDeviceAbi,
  resolveAdbInstallTarget,
} from "../scripts/cli/lib/mobile-android.mjs";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  killed = false;
  kill = vi.fn(() => {
    this.killed = true;
    this.exitCode = 0;
    this.emit("exit", 0, "SIGTERM");
    return true;
  });
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("mobile script platform and relay guarantees", () => {
  it("builds source APKs without leaving Gradle or Kotlin compiler daemons behind", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "scripts/cli/mobile-install.mjs"),
      "utf8"
    );
    expect(source).toContain('"--no-daemon"');
    expect(source).toContain('"--max-workers=2"');
    expect(source).toContain('"-Pkotlin.compiler.execution.strategy=in-process"');
    expect(source).toContain("-PreactNativeArchitectures=${deviceAbi}");
    expect(source).not.toContain('"--rerun-tasks"');
  });

  it("resolves one adb target and validates its primary build ABI", () => {
    const devices = [
      "List of devices attached",
      "phone-1 device product:oriole model:Pixel_6 transport_id:1",
      "",
    ].join("\n");
    expect(resolveAdbInstallTarget(devices, null)).toBe("phone-1");
    expect(resolveAdbInstallTarget(devices, "phone-1")).toBe("phone-1");
    expect(parseAndroidDeviceAbi("arm64-v8a\n")).toBe("arm64-v8a");
    expect(() => parseAndroidDeviceAbi("mips\n")).toThrow(/unsupported primary ABI/u);
  });

  it("requires an explicit adb target when more than one device is ready", () => {
    const devices = [
      "List of devices attached",
      "phone-1 device product:oriole",
      "emulator-5554 device product:sdk_gphone64_x86_64",
      "",
    ].join("\n");
    expect(() => resolveAdbInstallTarget(devices, null)).toThrow(/multiple install targets/u);
    expect(resolveAdbInstallTarget(devices, "emulator-5554")).toBe("emulator-5554");
  });

  it("tracks monorepo and workspace Metro sources in the Android bundle task", () => {
    const gradle = fs.readFileSync(
      path.join(process.cwd(), "apps/mobile/android/app/build.gradle"),
      "utf8"
    );
    expect(gradle).toContain('rootProject.file("../../../packages")');
    expect(gradle).toContain('rootProject.file("../../../workspace/apps/mobile")');
    expect(gradle).toContain('task.name.startsWith("createBundle")');
    expect(gradle).toContain('withPropertyName("vibestudioMetroSources")');
    expect(gradle).toContain("PathSensitivity.RELATIVE");
    expect(gradle).toContain('System.getenv("VIBESTUDIO_RN_BUNDLE_WORKERS") ?: "2"');
    expect(gradle).toContain('"--max-workers"');
    expect(gradle).toContain('.gradleProperty("reactNativeArchitectures")');
    expect(gradle).toContain("abiFilters.addAll(configuredReactNativeArchitectures)");
  });

  it("keeps managed panel artifacts warm across ordinary background transitions", () => {
    const webView = fs.readFileSync(
      path.join(process.cwd(), "workspace/apps/mobile/src/components/PanelWebView.tsx"),
      "utf8"
    );
    expect(webView).toContain("cacheEnabled\n");
    expect(webView).toContain('cacheMode="LOAD_DEFAULT"');
    expect(webView).not.toContain("LOAD_NO_CACHE");

    const lifecycle = fs.readFileSync(
      path.join(process.cwd(), "workspace/apps/mobile/src/hooks/useAppLifecycle.ts"),
      "utf8"
    );
    expect(lifecycle.match(/shellClient\.trimMemory\(\)/gu)).toHaveLength(1);
    expect(lifecycle).toMatch(/memoryWarning[\s\S]*shellClient\.trimMemory\(\)/u);
    expect(lifecycle).not.toContain("shellClient.panels");
  });

  it("gives the shell recovery coordinator sole ownership of panel refresh", () => {
    const main = fs.readFileSync(
      path.join(process.cwd(), "workspace/apps/mobile/src/components/MainScreen.tsx"),
      "utf8"
    );
    const reconnectBlock = main.match(
      /const unsubReconnect = shellClient\.transport\.onReconnect\(\(\) => \{([\s\S]*?)\n    \}\);/u
    )?.[1];
    expect(reconnectBlock).toBeDefined();
    expect(reconnectBlock).not.toContain("panels.refresh");
    expect(main).toContain('if (kind !== "cold-recover") return;');
    expect(main).toContain('mobilePanelMaterializationState(panel, entry) === "current"');
  });

  it("bounds one-shot Metro builds and preserves its content cache", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "workspace/extensions/react-native/index.ts"),
      "utf8"
    );
    expect(source).toContain('"--max-workers"');
    expect(source).toContain('process.env["VIBESTUDIO_RN_BUNDLE_WORKERS"] ?? "2"');
    expect(source).not.toContain('"--reset-cache"');
    expect(source).toContain("export async function deactivate()");
    expect(source).toContain("ownedTempDirs.clear()");
  });

  it("advances mobile panel projections on the server's execution activation edge", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "workspace/apps/mobile/src/services/shellClient.ts"),
      "utf8"
    );
    expect(source).toContain('this.events.on("panel:executionActivated"');
    expect(source).toContain('this.events.subscribe("panel:executionActivated")');
    expect(source).toContain("handleExecutionActivated");
    expect(source).not.toContain('this.events.subscribe("panel-presentation-changed")');
  });

  it("keeps observing launch approval resolved by the desktop or server", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "apps/mobile/index.js"), "utf8");
    const approvalBranch = source.match(
      /if \(launch\.status === "approval-required"\) \{([\s\S]*?)\n        \}/u
    )?.[1];
    expect(approvalBranch).toBeDefined();
    expect(approvalBranch).toContain("setBusy(false)");
    expect(approvalBranch).toContain("continue;");
    expect(approvalBranch).not.toContain("setBusy(true)");
    expect(approvalBranch).not.toMatch(/setApprovals\(launch\.approvals\);\s+return;/u);
  });

  it("serializes Android accessibility snapshots and has one approval driver", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "scripts/cli/mobile-smoke.mjs"),
      "utf8"
    );
    expect(source).toContain("let windowDumpTail = Promise.resolve()");
    expect(source).toContain("windowDumpTail.then(dump, dump)");
    expect(source).not.toContain('void tapOptionalButtonByText(options.device, "Start"');
  });

  it("keeps launch decisions above expanded first-use trust details", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "apps/mobile/index.js"), "utf8");
    const approvalView = source.slice(
      source.indexOf("launchGate.nativeCodeWarning"),
      source.indexOf("launchGate.declineConsequence")
    );
    expect(approvalView.indexOf("launchGate.acceptLabel")).toBeGreaterThanOrEqual(0);
    expect(approvalView.indexOf("launchGate.acceptLabel")).toBeLessThan(
      approvalView.indexOf("launchGateDetailsOpen")
    );
    expect(approvalView.indexOf("launchGate.declineLabel")).toBeLessThan(
      approvalView.indexOf("launchGateDetailsOpen")
    );
  });

  it("gives host build and bundle transfer independent phase deadlines", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "scripts/cli/mobile-smoke.mjs"),
      "utf8"
    );
    expect(source).toMatch(
      /for \(const phase of \["embedded-bundle-activate-start", "embedded-bundle-activate-complete"\]\) \{\s+const phaseDeadlineMs = Date\.now\(\) \+ options\.pairingTimeoutMs;/u
    );
    expect(source).not.toContain("hostTargetLaunchDeadlineMs");
  });

  it("opens the New Panel launcher without the retired panel-kind chooser", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "scripts/cli/mobile-smoke.mjs"),
      "utf8"
    );
    expect(source).toContain(
      'tapButtonByText(options.device, "Create new panel", managedLaunchDeadlineMs)'
    );
    expect(source).not.toContain("tapButtonAndChoose");
  });

  it("bounds and retries transient hosted signaling preflight failures", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "scripts/cli/mobile-smoke.mjs"),
      "utf8"
    );
    expect(source).toContain("attempt <= 3");
    expect(source).toContain("AbortSignal.timeout(15_000)");
    expect(source).toContain("could not reach ${url}");
  });

  it("pairs the rebuilt phone with the current source server", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "scripts/cli/mobile-smoke.mjs"),
      "utf8"
    );
    expect(source).toContain('VIBESTUDIO_SERVER_ENTRY: "live"');
  });

  it("proves warm panel artifacts stay off the WebRTC pipe during recovery", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "scripts/cli/mobile-smoke.mjs"),
      "utf8"
    );
    expect(source).toContain('"workspace-panel-ready"');
    expect(source).toContain('"workspace-panel-cacheable-asset-pipe-miss"');
    expect(source).toContain("Warm app relaunch fetched panel artifact bytes over the WebRTC pipe");
    expect(source).toContain(
      "Warm server recovery fetched panel artifact bytes over the WebRTC pipe"
    );
    expect(source).toMatch(
      /am", "force-stop"[\s\S]*?await sleep\(250\);[\s\S]*?appRestartCacheablePipeMissCount/u
    );
    expect(source).toMatch(
      /await serverExit;[\s\S]*?serverRestartCacheablePipeMissCount[\s\S]*?spawnManaged/u
    );
    expect(source).not.toContain("appRestartStoreHitCount");
    expect(source).not.toContain("serverRestartStoreHitCount");

    const mainScreen = fs.readFileSync(
      path.join(process.cwd(), "workspace/apps/mobile/src/components/MainScreen.tsx"),
      "utf8"
    );
    expect(mainScreen.indexOf("phase=workspace-panel-ready")).toBeLessThan(
      mainScreen.indexOf(".reportView(runtimeEntityId, connectionId, observation)")
    );
  });

  it("recognizes generated agent handles in the visible-turn validator", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "scripts/cli/mobile-smoke.mjs"),
      "utf8"
    );
    expect(source).toContain("@[a-z0-9][a-z0-9_-]*");
    expect(source).not.toContain("@(?:agent|ai-chat)");
  });

  it("fails iOS smoke explicitly instead of reporting install/launch as a pass", () => {
    const result = spawnSync(
      process.execPath,
      [path.join(process.cwd(), "scripts/cli/mobile-smoke.mjs"), "--platform", "ios"],
      { encoding: "utf8" }
    );
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(
      /iOS end-to-end smoke is unsupported[\s\S]*Refusing to report a partial install\/launch/u
    );
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("installed and launched");
  });

  it("selects a private host address and requires TURN for launched or selected emulators", () => {
    expect(
      privateLanIpv4({
        docker: [{ family: "IPv4", internal: false, address: "172.20.0.1" }],
        wifi: [{ family: "IPv4", internal: false, address: "192.168.1.5" }],
      })
    ).toBe("192.168.1.5");
    expect(requiresLocalTurn({ launchedEmulator: true })).toBe(true);
    expect(requiresLocalTurn({ device: "emulator-5554" })).toBe(true);
    expect(requiresLocalTurn({ device: "R5CT123" })).toBe(false);
    expect(relayOnlyServerEnv({})).toEqual({ VIBESTUDIO_WEBRTC_ICE: "relay" });
    expect(relayOnlyServerEnv(null)).toEqual({});
  });

  it("starts one strict coturn configuration and exposes the signaling variables", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-turn-test-"));
    roots.push(tempDir);
    const child = new FakeChild();
    const spawnManaged = vi.fn(() => child);
    const waitForSpawn = vi.fn(async () => undefined);
    const probeReady = vi.fn(async () => undefined);
    const turn = await startLocalTurnRelay({
      spawnManaged,
      waitForSpawn,
      networkInterfaces: {
        wifi: [{ family: "IPv4", internal: false, address: "10.10.0.5" }],
      },
      tempDir,
      pid: 123,
      allocatePort: async () => 49123,
      probeReady,
    });

    expect(spawnManaged).toHaveBeenCalledWith("turnserver", ["-c", turn.configPath], {
      label: "coturn",
    });
    expect(waitForSpawn).toHaveBeenCalledWith(child, "turnserver", ["-c", turn.configPath]);
    expect(probeReady).toHaveBeenCalledWith("10.10.0.5", "49123");
    const config = fs.readFileSync(turn.configPath, "utf8");
    expect(config).toContain("listening-port=49123");
    expect(config).toContain("listening-ip=10.10.0.5");
    expect(config).not.toContain("listening-ip=127.0.0.1");
    expect(config).toContain("relay-ip=10.10.0.5");
    expect(config).toContain("no-tls\nno-dtls");
    expect(config).toContain("no-cli\nno-tcp-relay");
    expect(config).not.toContain("min-port=");
    expect(config).toContain(`user=${turn.user}:${turn.pass}`);
    expect(turn.user).toMatch(/^vs-[A-Za-z0-9_-]{12}$/);
    expect(turn.pass).toMatch(/^[A-Za-z0-9_-]{32}$/);
    if (process.platform !== "win32") {
      expect(fs.statSync(turn.configPath).mode & 0o777).toBe(0o600);
    }
    expect(signalingTurnVars(turn)).toEqual([
      "--var",
      "VIBESTUDIO_LOCAL_TURN_HOST:10.10.0.5",
      "--var",
      "VIBESTUDIO_LOCAL_TURN_PORT:49123",
      "--var",
      `VIBESTUDIO_LOCAL_TURN_USER:${turn.user}`,
      "--var",
      `VIBESTUDIO_LOCAL_TURN_PASS:${turn.pass}`,
    ]);

    await turn.cleanupArtifacts();
    expect(fs.existsSync(turn.configPath)).toBe(false);
  });

  it("fails loud and removes relay artifacts when coturn cannot start", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-turn-fail-test-"));
    roots.push(tempDir);
    const child = new FakeChild();
    await expect(
      startLocalTurnRelay({
        spawnManaged: () => child,
        waitForSpawn: async () => {
          throw new Error("spawn ENOENT");
        },
        networkInterfaces: {
          wifi: [{ family: "IPv4", internal: false, address: "192.168.5.10" }],
        },
        tempDir,
        pid: 456,
        allocatePort: async () => 49124,
        probeReady: vi.fn(async () => undefined),
      })
    ).rejects.toThrow(/Local TURN relay is required[\s\S]*spawn ENOENT/u);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(fs.readdirSync(tempDir)).toEqual([]);
  });

  it("fails closed and removes relay artifacts when coturn never answers STUN", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-turn-probe-test-"));
    roots.push(tempDir);
    const child = new FakeChild();
    await expect(
      startLocalTurnRelay({
        spawnManaged: () => child,
        waitForSpawn: async () => undefined,
        networkInterfaces: {
          wifi: [{ family: "IPv4", internal: false, address: "192.168.5.10" }],
        },
        tempDir,
        pid: 789,
        allocatePort: async () => 49125,
        probeReady: async () => {
          throw new Error("no STUN response");
        },
      })
    ).rejects.toThrow(/Local TURN relay is required[\s\S]*no STUN response/u);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(fs.readdirSync(tempDir)).toEqual([]);
  });
});
