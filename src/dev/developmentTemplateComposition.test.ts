import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  readLedger,
  readResult,
  ledgerLiveness,
  failureError,
  awaitRetirement,
} from "@vibestudio/shared/ownershipLedger";
import { pathToFileURL } from "node:url";
import { parseTemplateManifestContent } from "@vibestudio/workspace/templateManifest";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";
import { composeDevelopmentTemplateCheckouts } from "./developmentTemplateComposition.js";

const roots: string[] = [];
const releases: (() => Promise<void>)[] = [];

function template(name: string, manifest: string, files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `vibestudio-${name}-template-`));
  roots.push(root);
  fs.mkdirSync(path.join(root, "meta"), { recursive: true });
  fs.writeFileSync(path.join(root, "meta", "vibestudio.yml"), manifest);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}

afterEach(async () => {
  for (const release of releases.splice(0)) await release();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("composeDevelopmentTemplateCheckouts", () => {
  it("materializes dependency-owned and dependent-owned units without changing their ownership", async () => {
    const base = template(
      "base",
      `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\ntemplate:\n  name: Base\n`,
      { "packages/base/package.json": "{}", "packages/base/BASE.md": "base" }
    );
    const personal = template(
      "personal",
      `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\ntemplate:\n  name: Personal\n  dependencies:\n    - url: git+https://example.test/base.git\n`,
      { "panels/tour/package.json": "{}", "panels/tour/PERSONAL.md": "personal" }
    );

    const composition = await composeDevelopmentTemplateCheckouts([
      { checkout: base, url: "git+https://example.test/base.git" },
      { checkout: personal, url: "git+https://example.test/personal.git" },
    ]);
    roots.push(composition.root);
    releases.push(composition.release);
    const parsed = parseTemplateManifestContent(
      fs.readFileSync(path.join(composition.root, "meta", "vibestudio.yml"), "utf8"),
      WORKSPACE_SYSTEM_EPOCH
    );

    expect(parsed.top.template).not.toHaveProperty("repositories");

    expect(parsed.dependencies).toEqual([{ url: "git+https://example.test/base.git" }]);
    expect(fs.readFileSync(path.join(composition.root, "packages/base/BASE.md"), "utf8")).toBe(
      "base"
    );
    expect(fs.readFileSync(path.join(composition.root, "panels/tour/PERSONAL.md"), "utf8")).toBe(
      "personal"
    );
  });
});

it("retires a private composition normally and preserves it only with an explicit keep request", async () => {
  const base = template(
    "lifecycle",
    `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\ntemplate:\n  name: Base\n`,
    { "packages/base/package.json": "{}" }
  );
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "composition-profile-"));
  roots.push(profile);
  const composition = await composeDevelopmentTemplateCheckouts(
    [{ checkout: base, url: "fixture://base" }],
    { profileDir: profile, keep: false }
  );
  releases.push(composition.release);
  expect(composition.root.startsWith(path.join(profile, "ownership", "scratch"))).toBe(true);
  await composition.release();
  expect(fs.existsSync(composition.root)).toBe(false);
  const kept = await composeDevelopmentTemplateCheckouts(
    [{ checkout: base, url: "fixture://base" }],
    { profileDir: profile, keep: true }
  );
  releases.push(kept.release);
  await kept.release();
  expect(fs.existsSync(path.join(kept.root, "packages/base/package.json"))).toBe(true);
});

it.skipIf(process.platform !== "linux")(
  "retires composition copies and their actual compiler process on owner SIGKILL",
  async () => {
    const base = template(
      "crash",
      `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\ntemplate:\n  name: Base\n`,
      { "packages/base/package.json": "{}" }
    );
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "composition-crash-"));
    roots.push(profile);
    const factory = path.resolve(import.meta.dirname, "developmentTemplateComposition.ts");
    const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm/api")).href;
    const owner = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import {tsImport} from ${JSON.stringify(loader)};
    const {composeDevelopmentTemplateCheckouts}=await tsImport(${JSON.stringify(factory)},import.meta.url);
    const composition=await composeDevelopmentTemplateCheckouts([{checkout:${JSON.stringify(base)},url:"fixture://base"}],{profileDir:${JSON.stringify(profile)},keep:false});
    const work=composition.ownership.spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{kill:"immediate",stdio:"ignore",label:"compiler-fixture"});
    await work.registered;
    console.log(JSON.stringify({root:composition.root,pid:work.child.pid,reference:composition.ownership.reference}));
    setInterval(()=>{},1000);
  `,
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let output = "",
      errors = "";
    owner.stdout!.on("data", (chunk) => {
      output += chunk;
    });
    owner.stderr!.on("data", (chunk) => {
      errors += chunk;
    });
    const done = new Promise<void>((resolve) => owner.once("close", () => resolve()));
    const ready = await new Promise<{
      root: string;
      pid: number;
      reference: { dir: string; id: string; token: string };
    }>((resolve, reject) => {
      owner.stdout!.on("data", () => {
        const row = output.split("\n").find((row) => row.startsWith("{"));
        if (row) resolve(JSON.parse(row));
      });
      owner.once("exit", (code) =>
        reject(new Error(`Composition owner exited ${code}: ${errors}`))
      );
    });
    // Recovery is teardown only: it must never manufacture the automatic
    // reaper proof asserted below. It also joins a failed fixture's compiler.
    releases.push(() =>
      awaitRetirement(ready.reference.dir, ready.reference.id, { token: ready.reference.token })
    );
    try {
      expect(fs.existsSync(ready.root)).toBe(true);
      owner.kill("SIGKILL");
      await done;
      // Kernel observation is bounded by this conventional test's deadline.
      while (fs.existsSync(ready.root)) {
        const ledger = readLedger(ready.reference.dir, ready.reference.id);
        if (ledger && ledgerLiveness(ledger) !== "live") {
          const result = readResult(ready.reference.dir, ready.reference.id);
          throw result
            ? failureError(result)
            : new Error(
                "Composition reaper exited without retiring its source: " + JSON.stringify(ledger)
              );
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      let running = false;
      try {
        const stat = fs.readFileSync(`/proc/${ready.pid}/stat`, "utf8");
        running = !["Z", "X"].includes(
          stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3)
        );
      } catch {
        // An absent kernel process is already retired.
      }
      expect(running).toBe(false);
    } finally {
      if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
      await done;
    }
  }
);

it.skipIf(process.platform === "win32")(
  "retires a partially copied composition when source copying fails",
  async () => {
    const base = template(
      "copy-failure",
      `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\ntemplate:\n  name: Base\n`,
      { "packages/base/package.json": "{}" }
    );
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "composition-failure-profile-"));
    roots.push(profile);
    const unreadable = path.join(base, "packages/base/package.json");
    fs.chmodSync(unreadable, 0);
    try {
      await expect(
        composeDevelopmentTemplateCheckouts([{ checkout: base, url: "fixture://base" }], {
          profileDir: profile,
          keep: false,
        })
      ).rejects.toThrow();
      expect(fs.readdirSync(path.join(profile, "ownership", "scratch"))).toEqual([]);
    } finally {
      fs.chmodSync(unreadable, 0o600);
    }
  }
);
