import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ownership } from "@vibestudio/shared/ownership";
import { ledgerDirOf, readLedger, readResult } from "@vibestudio/shared/ownershipLedger";
import { observeProcessStart } from "@vibestudio/shared/ownedProcessIdentity";
import {
  devInstanceLedgerDir,
  devInstanceLedgerId,
  devInstanceRecordPath,
  publishDevInstanceReady,
  readDevInstanceRecord,
} from "./instanceRegistry.js";
import {
  acquireSystemTestInstance,
  commandProvisionsSystemTestInstance,
  describeInstanceLedger,
  ensureSystemTestInstance,
  isLocalSystemTestHelpCommand,
  parseSystemTestLauncherArgs,
  stopManagedSystemTestInstance,
  systemTestInstanceEnvironment,
} from "./systemTestInstance.js";
import { DEFAULT_IROH_RELAYS } from "../server/irohRelayConfig.js";
import {
  claimFixtureLedger,
  deadProcessStart,
  registerFixtureInstance,
} from "./testSupport/ledgerFixture.js";

const tsxLoader = createRequire(import.meta.url).resolve("tsx");
const OWNERSHIP_URL = new URL("../../packages/shared/src/ownership.mjs", import.meta.url).href;
const SYSTEM_TEST_INSTANCE_URL = new URL("./systemTestInstance.ts", import.meta.url).href;
const REGISTRY_URL = new URL("./instanceRegistry.ts", import.meta.url).href;

describe("self-provisioning system-test instance", () => {
  let tempDir: string;
  let repoRoot: string;
  let previousXdg: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-system-test-instance-"));
    repoRoot = fs.mkdtempSync(path.join(tempDir, "repo-"));
    previousXdg = process.env["XDG_CONFIG_HOME"];
    process.env["XDG_CONFIG_HOME"] = path.join(tempDir, "profile");
  });

  afterEach(() => {
    if (previousXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
    else process.env["XDG_CONFIG_HOME"] = previousXdg;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("extracts one stable instance id without forwarding launcher flags", () => {
    expect(parseSystemTestLauncherArgs(["doctor", "--instance", "incident-a", "--json"])).toEqual({
      instanceId: "incident-a",
      explicitInstance: true,
      persistent: false,
      selfDevelopment: false,
      keep: false,
      command: ["doctor", "--json"],
    });
    expect(
      parseSystemTestLauncherArgs(["--workspace", "personal", "run", "browser-import"])
    ).toEqual({
      instanceId: "system-test",
      explicitInstance: false,
      persistent: false,
      selfDevelopment: false,
      keep: false,
      workspace: "personal",
      command: ["run", "browser-import"],
    });
    expect(parseSystemTestLauncherArgs(["--workspace=system", "list"]).workspace).toBe("system");
    expect(() => parseSystemTestLauncherArgs(["--workspace", "project", "list"])).toThrow(
      /personal or system/
    );
    expect(() =>
      parseSystemTestLauncherArgs(["--workspace", "personal", "--workspace", "system", "list"])
    ).toThrow(/only be specified once/);
    expect(
      parseSystemTestLauncherArgs(["--instance", "self-development", "--persistent", "doctor"])
    ).toEqual({
      instanceId: "self-development",
      explicitInstance: true,
      persistent: true,
      selfDevelopment: false,
      keep: false,
      command: ["doctor"],
    });
    expect(
      parseSystemTestLauncherArgs([
        "run",
        "client-launch-terminal",
        "--device",
        "terminal",
        "--device=desktop",
        "--device",
        "terminal",
      ])
    ).toMatchObject({
      devices: ["terminal", "desktop"],
      command: ["run", "client-launch-terminal"],
    });
    expect(() => parseSystemTestLauncherArgs(["run", "--device", "phone"])).toThrow(
      /terminal or desktop/
    );
    expect(parseSystemTestLauncherArgs(["list"])).toEqual({
      instanceId: "system-test",
      explicitInstance: false,
      persistent: false,
      selfDevelopment: false,
      keep: false,
      command: ["list"],
    });
    // The adoption flag is the launcher's, never the test command's.
    expect(parseSystemTestLauncherArgs(["--self-development", "run", "x"])).toEqual({
      instanceId: "system-test",
      explicitInstance: false,
      persistent: false,
      selfDevelopment: true,
      keep: false,
      command: ["run", "x"],
    });
    // `--keep` is the launcher's: `run` then creates its instance until stop.
    expect(parseSystemTestLauncherArgs(["--keep", "run", "x"])).toMatchObject({
      keep: true,
      command: ["run", "x"],
    });
    expect(() =>
      parseSystemTestLauncherArgs(["--instance", "a", "--instance=b", "doctor"])
    ).toThrow(/only be specified once/u);
  });

  it("recognizes launcher and subcommand help as side-effect-free", () => {
    expect(isLocalSystemTestHelpCommand(["--help"])).toBe(true);
    expect(isLocalSystemTestHelpCommand(["-h"])).toBe(true);
    expect(isLocalSystemTestHelpCommand(["run", "--help"])).toBe(true);
    expect(isLocalSystemTestHelpCommand(["list", "--help"])).toBe(true);
    expect(isLocalSystemTestHelpCommand(["run", "--", "--help"])).toBe(false);
    expect(isLocalSystemTestHelpCommand([])).toBe(false);
  });

  it("owns the public Phase-0 Iroh relay topology instead of inheriting overrides", () => {
    expect(
      systemTestInstanceEnvironment({ VIBESTUDIO_IROH_RELAYS: "https://stale.invalid/" })
    ).toEqual({
      VIBESTUDIO_IROH_RELAYS: DEFAULT_IROH_RELAYS.join(","),
      VIBESTUDIO_SYSTEM_TEST_INSTANCE: "1",
    });
  });

  it("reuses an explicitly selected ready server without taking ownership", async () => {
    const root = fs.mkdtempSync(path.join(tempDir, "instance-"));
    const { instance } = await registerFixtureInstance({ id: "existing", root, repoRoot });
    publishDevInstanceReady(instance, { status: "paired", workspaceName: "dev" });

    await expect(
      ensureSystemTestInstance(repoRoot, "existing", { explicitInstance: true })
    ).resolves.toMatchObject({
      instance: { id: "existing" },
      ready: { status: "paired", workspaceName: "dev" },
      created: false,
      managed: false,
    });
    await expect(stopManagedSystemTestInstance(repoRoot, "existing")).rejects.toThrow(
      /not created by pnpm system-test/u
    );
  });

  it("waits for the owning generation instead of expiring slow readiness", async () => {
    const root = fs.mkdtempSync(path.join(tempDir, "slow-ready-"));
    const { instance } = await registerFixtureInstance({ id: "slow-ready", root, repoRoot });
    let settled = false;
    const ensuring = ensureSystemTestInstance(repoRoot, instance.id, {
      explicitInstance: true,
    }).finally(() => {
      settled = true;
    });
    // No clock decides: the instance simply is not ready until its owner says so.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(settled).toBe(false);
    publishDevInstanceReady(instance, { status: "paired", workspaceName: "dev" });
    await expect(ensuring).resolves.toMatchObject({
      instance: { id: "slow-ready" },
      ready: { status: "paired", workspaceName: "dev" },
    });
  });

  it("stops waiting for readiness when told to, with the reason it was told", async () => {
    const root = fs.mkdtempSync(path.join(tempDir, "interrupted-"));
    await registerFixtureInstance({ id: "interrupted", root, repoRoot });
    const interrupt = new AbortController();
    const ensuring = ensureSystemTestInstance(repoRoot, "interrupted", {
      explicitInstance: true,
      signal: interrupt.signal,
    });
    interrupt.abort(new Error("Interrupted by SIGINT"));
    await expect(ensuring).rejects.toThrow("Interrupted by SIGINT");
  });

  it("retains managed ownership when reusing an instance after launcher recovery", async () => {
    const root = fs.mkdtempSync(path.join(tempDir, "instance-"));
    const { instance } = await registerFixtureInstance({
      id: "managed",
      root,
      repoRoot,
      lifecycle: "ephemeral",
      ledger: { meta: { managed: true } },
    });
    publishDevInstanceReady(instance, { status: "paired", workspaceName: "dev" });

    await expect(
      ensureSystemTestInstance(repoRoot, "managed", { explicitInstance: true })
    ).resolves.toMatchObject({
      instance: { id: "managed" },
      created: false,
      managed: true,
    });
  });

  it("does not silently reuse an unmanaged default instance", async () => {
    const root = fs.mkdtempSync(path.join(tempDir, "instance-"));
    const { instance } = await registerFixtureInstance({
      id: "system-test",
      root,
      repoRoot,
      lifecycle: "ephemeral",
    });
    publishDevInstanceReady(instance, { status: "paired", workspaceName: "dev" });

    await expect(ensureSystemTestInstance(repoRoot, "system-test")).rejects.toThrow(
      /owned by another workflow/u
    );
  });

  it("reclaims a dead managed ephemeral generation and its copied workspace", async () => {
    const root = fs.mkdtempSync(path.join(tempDir, "stale-managed-"));
    fs.writeFileSync(path.join(root, "copied-workspace-data"), "owned by stale generation");
    await registerFixtureInstance({
      id: "stale-managed",
      root,
      repoRoot,
      lifecycle: "ephemeral",
      ledger: {
        owner: deadProcessStart(),
        reaper: deadProcessStart(),
        meta: { managed: true },
        paths: [{ path: root, kind: "scratch" }],
      },
    });

    await expect(stopManagedSystemTestInstance(repoRoot, "stale-managed")).resolves.toBe(true);
    expect(fs.existsSync(root)).toBe(false);
    expect(readLedger(devInstanceLedgerDir(), devInstanceLedgerId(repoRoot, "stale-managed"))).toBe(
      null
    );
    await expect(stopManagedSystemTestInstance(repoRoot, "stale-managed")).resolves.toBe(false);
  });

  it("refuses to stop an unmanaged instance, live or dead", async () => {
    for (const [id, dead] of [
      ["unmanaged-live", false],
      ["unmanaged-dead", true],
    ] as const) {
      const root = fs.mkdtempSync(path.join(tempDir, `${id}-`));
      await registerFixtureInstance({
        id,
        root,
        repoRoot,
        lifecycle: "ephemeral",
        ...(dead ? { ledger: { owner: deadProcessStart(), reaper: deadProcessStart() } } : {}),
      });
      await expect(stopManagedSystemTestInstance(repoRoot, id)).rejects.toThrow(
        /not created by pnpm system-test/u
      );
      expect(fs.existsSync(root)).toBe(true);
    }
  });

  it("provisions only for doctor and run; every other command requires a running instance", async () => {
    expect(commandProvisionsSystemTestInstance(["doctor"])).toBe(true);
    expect(commandProvisionsSystemTestInstance(["run", "x"])).toBe(true);
    for (const command of [
      ["inspect", "r1", "--json"],
      ["trajectory", "r1"],
      ["list"],
      ["rerun", "r1"],
      ["status", "r1"],
    ]) {
      expect(commandProvisionsSystemTestInstance(command)).toBe(false);
      await expect(
        acquireSystemTestInstance(repoRoot, "stopped", command, { explicitInstance: true })
      ).rejects.toThrow(/is not running.*system-test --instance stopped doctor/su);
    }
    // Nothing was spawned: no supervisor log and no ownership claim exist.
    expect(fs.existsSync(devInstanceLedgerDir())).toBe(false);
    expect(
      fs.existsSync(path.join(process.env["XDG_CONFIG_HOME"]!, "vibestudio", "instance-state"))
    ).toBe(false);
  });

  it("serves a running instance to a non-provisioning command and reports its claim", async () => {
    const root = fs.mkdtempSync(path.join(tempDir, "instance-"));
    const { instance } = await registerFixtureInstance({ id: "live", root, repoRoot });
    publishDevInstanceReady(instance, { status: "paired", workspaceName: "dev" });
    const ensured = await acquireSystemTestInstance(repoRoot, "live", ["inspect", "r1"], {
      explicitInstance: true,
    });
    expect(ensured).toMatchObject({ created: false });
    expect(describeInstanceLedger(ensured.ledger)).toMatch(
      /^ownership instance-[0-9a-f]{16}-live: until-stop, ready, 0 groups, 0 MiB resident$/u
    );
  });
});

const live = process.platform === "linux";

/** A kernel observation: running, and not a zombie. */
function running(pid: number): boolean {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = raw.slice(raw.lastIndexOf(")") + 2, raw.lastIndexOf(")") + 3);
    return state !== "Z" && state !== "X";
  } catch {
    return false;
  }
}
async function until(condition: () => boolean): Promise<void> {
  // Bounded only by the test runner's own deadline.
  for (;;) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * The supervisor stand-in: what `runInstance.ts` does for ownership, with a
 * workload and without a server. It claims the instance id, owns its scratch
 * root and registry record, registers, publishes readiness, and retires in
 * order on SIGTERM or lease loss. `STUB_HOLD` makes its shutdown wait for a
 * `release` file; `STUB_SEALED` gives it a path whose removal fails.
 */
const STUB_SUPERVISOR = `
import * as fs from "node:fs";
import * as path from "node:path";
import { Ownership, watchLease } from ${JSON.stringify(OWNERSHIP_URL)};
import { devInstanceLedgerDir, devInstanceLedgerId, devInstanceRecordPath,
  publishDevInstanceReady, registerDevInstance } from ${JSON.stringify(REGISTRY_URL)};
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => argv[argv.indexOf(name) + 1];
if (process.env.STUB_FAIL_BEFORE_CLAIM) { console.error("stub: failing before the claim"); process.exit(3); }
const repoRoot = fs.realpathSync(process.cwd());
const id = value("--instance");
const lifetime = value("--lifetime");
const ledgerId = devInstanceLedgerId(repoRoot, id);
const ownership = await Ownership.open({
  profileDir: path.dirname(devInstanceLedgerDir()), id: ledgerId, lifetime,
  meta: { kind: "dev-instance", instanceId: id, repoRoot,
    managed: flag("--system-test-managed"), selfDevelopment: flag("--self-development") },
});
const lease = lifetime === "leased" ? watchLease() : null;
const root = await ownership.scratch("vs-" + id + "-");
if (process.env.STUB_SEALED) await ownership.own(path.join(process.env.STUB_SEALED, "inner"));
await ownership.own(devInstanceRecordPath(repoRoot, id));
const instance = registerDevInstance({ id, root, repoRoot, supervisorPid: process.pid, ledgerId,
  kind: "server", lifecycle: "ephemeral", startedAt: Date.now() });
const workload = ownership.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],
  { kill: "graceful", stdio: "ignore" });
await workload.registered;
const control = process.env.STUB_CONTROL_DIR;
let stopping;
const stop = () => {
  stopping ??= (async () => {
    if (control) fs.writeFileSync(path.join(control, "stopping"), "1");
    while (process.env.STUB_HOLD && !fs.existsSync(path.join(control, "release")))
      await new Promise((resolve) => setTimeout(resolve, 10));
    await ownership.release();
  })().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
};
process.on("SIGTERM", stop);
lease?.addEventListener("abort", stop);
// Ready means everything is in place: the workload is registered and a stop
// request is handled, so a launcher acting on readiness never races setup.
if (control) fs.writeFileSync(path.join(control, "ready.json"),
  JSON.stringify({ pid: process.pid, root, workload: workload.child.pid }));
await ownership.markReady();
publishDevInstanceReady(instance, { status: "paired", workspaceName: "dev" });
setInterval(() => {}, 1000);
`;

/** A launcher process: opens its ownership, ensures an instance, reports, and idles. */
const STUB_LAUNCHER = `
import * as path from "node:path";
import { Ownership } from ${JSON.stringify(OWNERSHIP_URL)};
import { devInstanceLedgerDir } from ${JSON.stringify(REGISTRY_URL)};
import { ensureSystemTestInstance } from ${JSON.stringify(SYSTEM_TEST_INSTANCE_URL)};
const [repoRoot, id, lifetime, entry] = process.argv.slice(2);
const ownership = await Ownership.open({ profileDir: path.dirname(devInstanceLedgerDir()), lifetime: "leased" });
const ensured = await ensureSystemTestInstance(repoRoot, id, {
  explicitInstance: true, lifetime, ownership, supervisorEntry: entry });
process.stdout.write(JSON.stringify({ launcher: ownership.id, supervisor: ensured.ledger.owner.pid,
  ledger: ensured.ledger.id, root: ensured.instance.root, created: ensured.created }) + "\\n");
setInterval(() => {}, 1000);
`;

describe.skipIf(!live)("system-test instance lifetimes (stub supervisor)", () => {
  let tempDir: string;
  let repoRoot: string;
  let previousXdg: string | undefined;
  let stub: string;
  let launcherScript: string;
  let control: string;
  const children: ChildProcess[] = [];
  const opened: Ownership[] = [];
  const stubEnv = ["STUB_FAIL_BEFORE_CLAIM", "STUB_HOLD", "STUB_SEALED", "STUB_CONTROL_DIR"];

  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-lifetimes-")));
    repoRoot = fs.mkdtempSync(path.join(tempDir, "repo-"));
    previousXdg = process.env["XDG_CONFIG_HOME"];
    process.env["XDG_CONFIG_HOME"] = path.join(tempDir, "profile");
    stub = path.join(tempDir, "stub-supervisor.mjs");
    launcherScript = path.join(tempDir, "stub-launcher.mjs");
    control = path.join(tempDir, "control");
    fs.mkdirSync(control);
    fs.writeFileSync(stub, STUB_SUPERVISOR);
    fs.writeFileSync(launcherScript, STUB_LAUNCHER);
    process.env["STUB_CONTROL_DIR"] = control;
  });

  afterEach(async () => {
    for (const name of stubEnv) delete process.env[name];
    await Promise.allSettled(opened.splice(0).map((ownership) => ownership.release()));
    // Whatever a failed test left running: every recorded owner, reaper and group.
    try {
      for (const file of fs.readdirSync(
        ledgerDirOf(process.env["XDG_CONFIG_HOME"] + "/vibestudio")
      )) {
        if (!file.endsWith(".json")) continue;
        const ledger = JSON.parse(
          fs.readFileSync(
            path.join(ledgerDirOf(process.env["XDG_CONFIG_HOME"] + "/vibestudio"), file),
            "utf8"
          )
        );
        for (const pid of [ledger.owner.pid, ledger.reaper.pid]) {
          if (pid !== process.pid) {
            try {
              process.kill(pid, "SIGKILL");
            } catch {
              // already gone
            }
          }
        }
        for (const group of ledger.groups) {
          try {
            process.kill(-group.pid, "SIGKILL");
          } catch {
            // already gone
          }
        }
      }
    } catch {
      // no ledger directory
    }
    for (const child of children.splice(0)) child.kill("SIGKILL");
    if (previousXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
    else process.env["XDG_CONFIG_HOME"] = previousXdg;
    fs.chmodSync(tempDir, 0o700);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const profileDir = () => path.join(process.env["XDG_CONFIG_HOME"]!, "vibestudio");
  const ledgerOf = (id: string) =>
    readLedger(ledgerDirOf(profileDir()), devInstanceLedgerId(repoRoot, id));
  async function openOwnership(): Promise<Ownership> {
    const ownership = await Ownership.open({ profileDir: profileDir(), lifetime: "leased" });
    opened.push(ownership);
    return ownership;
  }
  async function startLauncher(
    id: string,
    lifetime: "leased" | "until-stop"
  ): Promise<{
    child: ChildProcess;
    report: { launcher: string; supervisor: number; ledger: string; root: string };
  }> {
    const child = spawn(
      process.execPath,
      ["--import", tsxLoader, launcherScript, repoRoot, id, lifetime, stub],
      { stdio: ["ignore", "pipe", "inherit"] }
    );
    children.push(child);
    const report = await new Promise<{
      launcher: string;
      supervisor: number;
      ledger: string;
      root: string;
    }>((resolve, reject) => {
      let buffered = "";
      child.stdout!.on("data", (chunk: Buffer) => {
        buffered += chunk.toString();
        if (buffered.includes("\n")) resolve(JSON.parse(buffered.split("\n")[0]!));
      });
      child.once("exit", () => reject(new Error("launcher exited before reporting")));
    });
    return { child, report };
  }
  const recordExists = (id: string) => fs.existsSync(devInstanceRecordPath(repoRoot, id));

  it("retires a leased instance when its launcher is SIGKILLed", async () => {
    const { child, report } = await startLauncher("leased-one", "leased");
    const launcherReaper = readLedger(ledgerDirOf(profileDir()), report.launcher)!.reaper.pid;
    expect(ledgerOf("leased-one")).toMatchObject({ lifetime: "leased", state: "ready" });
    const workload = ledgerOf("leased-one")!.groups[0]!.pid;
    expect(running(report.supervisor)).toBe(true);

    child.kill("SIGKILL");

    await until(
      () =>
        !running(report.supervisor) &&
        !running(workload) &&
        !running(launcherReaper) &&
        ledgerOf("leased-one") === null
    );
    expect(fs.existsSync(report.root)).toBe(false);
    expect(recordExists("leased-one")).toBe(false);
    // The launcher's own claim retired as well.
    expect(readLedger(ledgerDirOf(profileDir()), report.launcher)).toBeNull();
  });

  it("lets an until-stop instance outlive its launcher's SIGKILL, and stop joins it", async () => {
    const { child, report } = await startLauncher("kept-one", "until-stop");
    const launcherReaper = readLedger(ledgerDirOf(profileDir()), report.launcher)!.reaper.pid;
    expect(ledgerOf("kept-one")).toMatchObject({ lifetime: "until-stop", state: "ready" });
    const workload = ledgerOf("kept-one")!.groups[0]!.pid;

    child.kill("SIGKILL");
    // The launcher's reaper retires the launcher's claim and exits; the instance is not its to retire.
    await until(
      () =>
        !running(launcherReaper) && readLedger(ledgerDirOf(profileDir()), report.launcher) === null
    );
    expect(running(report.supervisor)).toBe(true);
    expect(running(workload)).toBe(true);
    expect(ledgerOf("kept-one")).not.toBeNull();
    expect(fs.existsSync(report.root)).toBe(true);

    await expect(stopManagedSystemTestInstance(repoRoot, "kept-one")).resolves.toBe(true);

    // The supervisor exits right behind its reaper's last reply.
    await until(() => !running(report.supervisor));
    expect(running(workload)).toBe(false);
    expect(ledgerOf("kept-one")).toBeNull();
    expect(fs.existsSync(report.root)).toBe(false);
    expect(recordExists("kept-one")).toBe(false);
    await expect(stopManagedSystemTestInstance(repoRoot, "kept-one")).resolves.toBe(false);
  });

  it("attaches `run` to an until-stop instance that `doctor` created and leaves it running", async () => {
    const created = await ensureSystemTestInstance(repoRoot, "doctored", {
      explicitInstance: true,
      ownership: await openOwnership(),
      lifetime: "until-stop",
      supervisorEntry: stub,
    });
    expect(created).toMatchObject({ created: true, managed: true });
    expect(created.ledger.lifetime).toBe("until-stop");

    const ownership = await openOwnership();
    const attached = await ensureSystemTestInstance(repoRoot, "doctored", {
      explicitInstance: true,
      lifetime: "leased",
      ownership,
      supervisorEntry: stub,
    });
    expect(attached).toMatchObject({ created: false, managed: true });
    expect(attached.instance.generationId).toBe(created.instance.generationId);

    // The attaching launcher ends; the instance it merely used does not.
    await ownership.release();
    expect(running(created.ledger.owner.pid)).toBe(true);
    expect(ledgerOf("doctored")).not.toBeNull();

    await expect(stopManagedSystemTestInstance(repoRoot, "doctored")).resolves.toBe(true);
    await until(() => !running(created.ledger.owner.pid));
  });

  it("refuses to keep an instance that is leased to another launcher", async () => {
    const ownership = await openOwnership();
    const leased = await ensureSystemTestInstance(repoRoot, "leased-two", {
      explicitInstance: true,
      lifetime: "leased",
      ownership,
      supervisorEntry: stub,
    });
    expect(leased).toMatchObject({ created: true });
    await expect(
      ensureSystemTestInstance(repoRoot, "leased-two", {
        explicitInstance: true,
        lifetime: "until-stop",
        supervisorEntry: stub,
      })
    ).rejects.toThrow(/leased to the launcher that created it.*cannot be kept/su);
    // Attaching without requiring more than the lease is fine.
    await expect(
      ensureSystemTestInstance(repoRoot, "leased-two", {
        explicitInstance: true,
        lifetime: "leased",
        ownership,
        supervisorEntry: stub,
      })
    ).resolves.toMatchObject({ created: false });
    // The lease is the launcher's: releasing it retires the instance, joined here.
    await ownership.release();
    await until(() => ledgerOf("leased-two") === null && !running(leased.ledger.owner.pid));
  });

  it.each(["leased", "until-stop"] as const)(
    "requires the launcher's ownership to create a %s instance",
    async (lifetime) => {
      await expect(
        ensureSystemTestInstance(repoRoot, "no-ownership", {
          explicitInstance: true,
          lifetime,
          supervisorEntry: stub,
        })
      ).rejects.toThrow(/needs the launcher's ownership/u);
    }
  );

  it("lets exactly one of two concurrent creators win the claim; the other attaches", async () => {
    const [first, second] = await Promise.all([
      ensureSystemTestInstance(repoRoot, "contended", {
        explicitInstance: true,
        ownership: await openOwnership(),
        lifetime: "until-stop",
        supervisorEntry: stub,
      }),
      ensureSystemTestInstance(repoRoot, "contended", {
        explicitInstance: true,
        ownership: await openOwnership(),
        lifetime: "until-stop",
        supervisorEntry: stub,
      }),
    ]);
    expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
    expect(first.instance.generationId).toBe(second.instance.generationId);
    expect(readDevInstanceRecord(repoRoot, "contended").generationId).toBe(
      first.instance.generationId
    );
    await expect(stopManagedSystemTestInstance(repoRoot, "contended")).resolves.toBe(true);
  });

  it("takes over a stale managed claim, retiring what it owned, and creates afresh", async () => {
    const staleRoot = fs.mkdtempSync(path.join(tempDir, "stale-root-"));
    fs.writeFileSync(path.join(staleRoot, "leftover"), "x");
    await claimFixtureLedger({
      id: devInstanceLedgerId(repoRoot, "takeover"),
      owner: deadProcessStart(),
      reaper: deadProcessStart(),
      meta: { managed: true },
      paths: [{ path: staleRoot, kind: "scratch" }],
    });

    const created = await ensureSystemTestInstance(repoRoot, "takeover", {
      explicitInstance: true,
      ownership: await openOwnership(),
      lifetime: "until-stop",
      supervisorEntry: stub,
    });

    expect(created.created).toBe(true);
    expect(fs.existsSync(staleRoot)).toBe(false);
    expect(created.ledger.owner.pid).not.toBe(process.pid);
    await expect(stopManagedSystemTestInstance(repoRoot, "takeover")).resolves.toBe(true);
  });

  it("stop is complete only when the supervisor's retirement is, not when it was signalled", async () => {
    process.env["STUB_HOLD"] = "1";
    const created = await ensureSystemTestInstance(repoRoot, "slow-stop", {
      explicitInstance: true,
      ownership: await openOwnership(),
      lifetime: "until-stop",
      supervisorEntry: stub,
    });
    const workload = created.ledger.groups[0]?.pid ?? 0;
    let settled = false;
    const stopping = stopManagedSystemTestInstance(repoRoot, "slow-stop").finally(() => {
      settled = true;
    });
    await until(() => fs.existsSync(path.join(control, "stopping")));
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Signalled, still retiring: the stop is still joined to it.
    expect(settled).toBe(false);
    expect(ledgerOf("slow-stop")).not.toBeNull();

    fs.writeFileSync(path.join(control, "release"), "1");
    await expect(stopping).resolves.toBe(true);
    expect(ledgerOf("slow-stop")).toBeNull();
    await until(() => !running(created.ledger.owner.pid));
    expect(workload).toBeGreaterThan(0);
    expect(running(workload)).toBe(false);
    expect(fs.existsSync(created.instance.root)).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)(
    "rethrows the retirement failure the instance's reaper recorded",
    async () => {
      const sealed = path.join(tempDir, "sealed");
      fs.mkdirSync(path.join(sealed, "inner"), { recursive: true });
      process.env["STUB_SEALED"] = sealed;
      const created = await ensureSystemTestInstance(repoRoot, "failing-stop", {
        explicitInstance: true,
        ownership: await openOwnership(),
        lifetime: "until-stop",
        supervisorEntry: stub,
      });
      fs.chmodSync(sealed, 0o500);
      try {
        const failure = await stopManagedSystemTestInstance(repoRoot, "failing-stop").then(
          () => null,
          (error: unknown) => error
        );
        expect(failure).toBeInstanceOf(AggregateError);
        expect(failure).toMatchObject({ code: "EOWNERSHIP" });
        expect((failure as AggregateError).errors[0]).toMatchObject({ code: "EACCES" });
        // The failure is retained for the next attempt, not forgotten with the supervisor.
        const ledgerId = devInstanceLedgerId(repoRoot, "failing-stop");
        expect(readResult(ledgerDirOf(profileDir()), ledgerId)).not.toBeNull();
        expect(readLedger(ledgerDirOf(profileDir()), ledgerId)).not.toBeNull();
        // The supervisor exits right behind its reaper's last reply.
        await until(() => !running(created.ledger.owner.pid));

        fs.chmodSync(sealed, 0o700);
        await expect(stopManagedSystemTestInstance(repoRoot, "failing-stop")).resolves.toBe(true);
        expect(readLedger(ledgerDirOf(profileDir()), ledgerId)).toBeNull();
      } finally {
        fs.chmodSync(sealed, 0o700);
      }
    }
  );

  it("reports a supervisor that exits before registering, with its log", async () => {
    process.env["STUB_FAIL_BEFORE_CLAIM"] = "1";
    await expect(
      ensureSystemTestInstance(repoRoot, "never-up", {
        explicitInstance: true,
        ownership: await openOwnership(),
        lifetime: "until-stop",
        supervisorEntry: stub,
      })
    ).rejects.toMatchObject({
      classification: "infrastructure",
      message: expect.stringMatching(/exited with code 3 before registration.*Supervisor log: /su),
    });
    expect(ledgerOf("never-up")).toBeNull();
  });

  it("attaches to a creator that is still starting instead of contending with it", async () => {
    // A live claim that has not registered yet: another launcher's instance mid-start.
    const claim = await claimFixtureLedger({
      id: devInstanceLedgerId(repoRoot, "starting"),
      state: "claimed",
      meta: { managed: true },
    });
    const root = fs.mkdtempSync(path.join(tempDir, "starting-root-"));
    const ensuring = ensureSystemTestInstance(repoRoot, "starting", {
      explicitInstance: true,
      ownership: await openOwnership(),
      lifetime: "until-stop",
      supervisorEntry: stub,
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    // Nothing was spawned for it: our stub would have failed on the live claim and left a log.
    expect(fs.existsSync(path.join(profileDir(), "instance-state"))).toBe(false);

    const { registerDevInstance } = await import("./instanceRegistry.js");
    const instance = registerDevInstance({
      id: "starting",
      root,
      repoRoot,
      supervisorPid: process.pid,
      ledgerId: claim.id,
      kind: "server",
      lifecycle: "persistent",
      startedAt: Date.now(),
    });
    publishDevInstanceReady(instance, { status: "paired", workspaceName: "dev" });
    fs.writeFileSync(
      path.join(ledgerDirOf(profileDir()), `${claim.id}.json`),
      JSON.stringify({ ...claim, state: "ready" })
    );
    await expect(ensuring).resolves.toMatchObject({ created: false, managed: true });
    expect(observeProcessStart(claim.owner)).toBe("live");
  });
});
