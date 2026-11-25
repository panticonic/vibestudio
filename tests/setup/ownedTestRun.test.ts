import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { Ownership, OWNERSHIP_PARENT_ENV } from "@vibestudio/shared/ownership";
import { ownTestRun, KEEP_TEST_TEMP_ENV } from "./ownedTestRun.js";
import setup, { TEST_TEMP_ROOT_ENV } from "./vitestTempRoot.js";

const original = {
  parent: process.env[OWNERSHIP_PARENT_ENV],
  keep: process.env[KEEP_TEST_TEMP_ENV],
  profile: process.env["VIBESTUDIO_PROFILE_ROOT"],
  tmp: process.env["TMPDIR"],
  root: process.env[TEST_TEMP_ROOT_ENV],
};
const closers: (() => Promise<void>)[] = [];
const paths: string[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const target of paths.splice(0)) fs.rmSync(target, { recursive: true, force: true });
  for (const [key, value] of [
    [OWNERSHIP_PARENT_ENV, original.parent],
    [KEEP_TEST_TEMP_ENV, original.keep],
    ["VIBESTUDIO_PROFILE_ROOT", original.profile],
    ["TMPDIR", original.tmp],
    [TEST_TEMP_ROOT_ENV, original.root],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
function privateProfile() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "test-run-profile-"));
  paths.push(profile);
  process.env["VIBESTUDIO_PROFILE_ROOT"] = profile;
}

it("retires nested fixture custody before removing the run and restores its caller", async () => {
  privateProfile();
  delete process.env[KEEP_TEST_TEMP_ENV];
  const run = await ownTestRun("fixture-run-");
  expect(JSON.parse(process.env[OWNERSHIP_PARENT_ENV]!)).not.toHaveProperty("terminateOwner");
  closers.push(() => run.close());
  const fixture = await Ownership.open({
    profileDir: path.join(run.root, "fixture-profile"),
    lifetime: "leased",
  });
  const fixtureBytes = await fixture.scratch("fixture-");
  fs.writeFileSync(path.join(fixtureBytes, "actual"), "fixture");
  await run.close();
  expect(fs.existsSync(run.root)).toBe(false);
  expect(fixture.signal.aborted).toBe(true);
  expect(process.env[OWNERSHIP_PARENT_ENV]).toBe(original.parent);
});

it("keeps scratch only by explicit optout while retiring child resources", async () => {
  privateProfile();
  process.env[KEEP_TEST_TEMP_ENV] = "1";
  const run = await ownTestRun("fixture-kept-");
  paths.push(run.root);
  closers.push(() => run.close());
  fs.writeFileSync(path.join(run.root, "requested-debug-bytes"), "keep");
  const fixture = await Ownership.open({
    profileDir: path.join(run.root, "fixture-profile"),
    lifetime: "leased",
  });
  const fixtureBytes = await fixture.scratch("fixture-");
  await run.close();
  expect(fs.readFileSync(path.join(run.root, "requested-debug-bytes"), "utf8")).toBe("keep");
  expect(fs.existsSync(fixtureBytes)).toBe(false);
  expect(fixture.signal.aborted).toBe(true);
});

it("Vitest setup owns redirected fixtures and restores environment after teardown", async () => {
  privateProfile();
  delete process.env[KEEP_TEST_TEMP_ENV];
  const previousTmp = process.env["TMPDIR"],
    previousRoot = process.env[TEST_TEMP_ROOT_ENV];
  const close = await setup();
  closers.push(close);
  const root = process.env[TEST_TEMP_ROOT_ENV]!;
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "ordinary-fixture-"));
  expect(fixture.startsWith(root + path.sep)).toBe(true);
  await close();
  expect(fs.existsSync(root)).toBe(false);
  expect(process.env["TMPDIR"]).toBe(previousTmp);
  expect(process.env[TEST_TEMP_ROOT_ENV]).toBe(previousRoot);
});

it("keeps closing-root admission in force while cleanup callbacks join", async () => {
  privateProfile();
  delete process.env[KEEP_TEST_TEMP_ENV];
  const run = await ownTestRun("closing-run-");
  closers.push(() => run.close());
  const descriptor = process.env[OWNERSHIP_PARENT_ENV];
  run.ownership.scope.defer(async () => {
    expect(process.env[OWNERSHIP_PARENT_ENV]).toBe(descriptor);
    await expect(
      Ownership.open({ profileDir: process.env["VIBESTUDIO_PROFILE_ROOT"]!, lifetime: "leased" })
    ).rejects.toThrow("being retired");
  });
  await run.close();
  expect(fs.existsSync(run.root)).toBe(false);
  expect(process.env[OWNERSHIP_PARENT_ENV]).toBe(original.parent);
});
