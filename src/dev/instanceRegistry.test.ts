import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ownership, OwnershipClaimedError } from "@vibestudio/shared/ownership";
import { ledgerFile, readLedger } from "@vibestudio/shared/ownershipLedger";
import {
  adoptDevInstance,
  clearDevInstanceReady,
  devInstanceLedgerDir,
  devInstanceLedgerId,
  devInstanceReadyPath,
  devInstanceRecordPath,
  persistentInstanceRoot,
  publishDevInstanceReady,
  registerDevInstance,
  resolveDevInstance,
  unregisterDevInstance,
  waitForDevInstanceReady,
} from "./instanceRegistry.js";
import {
  claimFixtureLedger,
  deadProcessStart,
  registerFixtureInstance,
} from "./testSupport/ledgerFixture.js";

describe("developer instance registry", () => {
  let tempDir: string;
  let previousXdg: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-instance-registry-"));
    previousXdg = process.env["XDG_CONFIG_HOME"];
    process.env["XDG_CONFIG_HOME"] = path.join(tempDir, "profile");
  });

  afterEach(() => {
    if (previousXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
    else process.env["XDG_CONFIG_HOME"] = previousXdg;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("resolves a live checkout-scoped instance without exposing another checkout", async () => {
    const repoRoot = fs.mkdtempSync(path.join(tempDir, "repo-a-"));
    const otherRepo = fs.mkdtempSync(path.join(tempDir, "repo-b-"));
    const root = persistentInstanceRoot(repoRoot, "source");
    await registerFixtureInstance({ id: "source", root, repoRoot, startedAt: 123 });

    expect(resolveDevInstance(repoRoot, "source")).toMatchObject({ id: "source", root });
    expect(() => resolveDevInstance(otherRepo, "source")).toThrow(/Unknown Vibestudio instance/u);

    unregisterDevInstance(repoRoot, "source");
    expect(() => resolveDevInstance(repoRoot, "source")).toThrow(/Unknown Vibestudio instance/u);
  });

  it("rejects ids that could escape the registry", () => {
    expect(() => persistentInstanceRoot(tempDir, "../escape")).toThrow(/Invalid instance id/u);
    expect(() => devInstanceLedgerId(tempDir, "../escape")).toThrow(/Invalid instance id/u);
  });

  it("keeps the same instance id in two checkouts from contending for one claim", () => {
    const first = fs.mkdtempSync(path.join(tempDir, "repo-a-"));
    const second = fs.mkdtempSync(path.join(tempDir, "repo-b-"));
    expect(devInstanceLedgerId(first, "source")).not.toBe(devInstanceLedgerId(second, "source"));
  });

  it("retains a clean-room profile root for instance-scoped CLI commands", async () => {
    const repoRoot = fs.mkdtempSync(path.join(tempDir, "repo-clean-"));
    const root = fs.mkdtempSync(path.join(tempDir, "instance-clean-"));
    const profileRoot = path.join(root, "profile");
    await registerFixtureInstance({
      id: "clean",
      root,
      profileRoot,
      repoRoot,
      kind: "desktop",
      lifecycle: "ephemeral",
      startedAt: 123,
    });

    expect(resolveDevInstance(repoRoot, "clean")).toMatchObject({ profileRoot });
    unregisterDevInstance(repoRoot, "clean");
  });

  it("rejects a private profile outside an ephemeral instance root", () => {
    const repoRoot = fs.mkdtempSync(path.join(tempDir, "repo-invalid-profile-"));
    const root = fs.mkdtempSync(path.join(tempDir, "instance-invalid-profile-"));
    expect(() =>
      registerDevInstance({
        id: "invalid-profile",
        root,
        profileRoot: path.join(tempDir, "foreign-profile"),
        repoRoot,
        supervisorPid: process.pid,
        ledgerId: devInstanceLedgerId(repoRoot, "invalid-profile"),
        kind: "desktop",
        lifecycle: "ephemeral",
        startedAt: 123,
      })
    ).toThrow(/private developer profile/u);
  });

  it("registers only under a live ownership claim", async () => {
    const repoRoot = fs.mkdtempSync(path.join(tempDir, "repo-claim-"));
    const root = persistentInstanceRoot(repoRoot, "unclaimed");
    const input = {
      id: "unclaimed",
      root,
      repoRoot,
      supervisorPid: process.pid,
      ledgerId: devInstanceLedgerId(repoRoot, "unclaimed"),
      kind: "server" as const,
      lifecycle: "persistent" as const,
      startedAt: 1,
    };
    expect(() => registerDevInstance(input)).toThrow(/without a live ownership claim/u);

    // A claim whose reaper is gone is not live either.
    await claimFixtureLedger({
      id: input.ledgerId,
      reaper: deadProcessStart(),
      owner: deadProcessStart(),
    });
    expect(() => registerDevInstance(input)).toThrow(/without a live ownership claim/u);
  });

  it("treats a record as stale once its claim is gone, replaced, or its owner dead", async () => {
    const repoRoot = fs.mkdtempSync(path.join(tempDir, "repo-stale-"));
    const root = persistentInstanceRoot(repoRoot, "stale");
    const { instance, ledger } = await registerFixtureInstance({ id: "stale", root, repoRoot });
    expect(resolveDevInstance(repoRoot, "stale").generationId).toBe(instance.generationId);

    // Replaced: a later claim of the same name has a different token.
    fs.rmSync(ledgerFile(devInstanceLedgerDir(), ledger.id));
    await claimFixtureLedger({ id: ledger.id });
    expect(() => resolveDevInstance(repoRoot, "stale")).toThrow(/no longer running/u);

    // Owner dead, even while a reaper still holds the claim.
    fs.rmSync(ledgerFile(devInstanceLedgerDir(), ledger.id));
    const reclaimed = await registerFixtureInstance({
      id: "stale",
      root,
      repoRoot,
      ledger: { owner: deadProcessStart() },
    });
    expect(() => resolveDevInstance(repoRoot, "stale")).toThrow(/no longer running/u);

    // Gone entirely.
    fs.rmSync(ledgerFile(devInstanceLedgerDir(), reclaimed.ledger.id));
    expect(() => resolveDevInstance(repoRoot, "stale")).toThrow(/no longer running/u);
  });

  it("publishes an atomic CLI-ready barrier after instance pairing", async () => {
    const repoRoot = fs.mkdtempSync(path.join(tempDir, "repo-ready-"));
    const root = fs.mkdtempSync(path.join(tempDir, "instance-"));
    const { instance } = await registerFixtureInstance({ id: "test", root, repoRoot });

    publishDevInstanceReady(instance, { status: "paired", workspaceName: "dev" });
    await expect(waitForDevInstanceReady(instance)).resolves.toMatchObject({
      schemaVersion: 1,
      status: "paired",
      workspaceName: "dev",
    });
    expect(fs.statSync(devInstanceReadyPath(instance)).mode & 0o777).toBe(0o600);

    clearDevInstanceReady(instance);
    expect(fs.existsSync(devInstanceReadyPath(instance))).toBe(false);
  });

  it("ignores a prior supervisor generation until the current one publishes readiness", async () => {
    const repoRoot = fs.mkdtempSync(path.join(tempDir, "repo-generation-"));
    const root = fs.mkdtempSync(path.join(tempDir, "instance-"));
    const { instance: current } = await registerFixtureInstance({ id: "test", root, repoRoot });
    const prior = { ...current, generationId: "a".repeat(32) };
    publishDevInstanceReady(prior, { status: "paired", workspaceName: "old" });

    const waiting = waitForDevInstanceReady(current);
    await new Promise((resolve) => setTimeout(resolve, 20));
    publishDevInstanceReady(current, { status: "paired", workspaceName: "current" });

    await expect(waiting).resolves.toMatchObject({
      instanceGeneration: current.generationId,
      workspaceName: "current",
    });
  });

  it("fails readiness when the owner is gone, and stops waiting on an abort", async () => {
    const repoRoot = fs.mkdtempSync(path.join(tempDir, "repo-exit-"));
    const root = fs.mkdtempSync(path.join(tempDir, "instance-"));
    const { instance, ledger } = await registerFixtureInstance({ id: "exit", root, repoRoot });

    const aborted = new AbortController();
    const waiting = waitForDevInstanceReady(instance, aborted.signal);
    aborted.abort(new Error("interrupted"));
    await expect(waiting).rejects.toThrow("interrupted");

    fs.rmSync(ledgerFile(devInstanceLedgerDir(), ledger.id));
    await expect(waitForDevInstanceReady(instance)).rejects.toThrow(/exited before CLI readiness/u);
  });

  it("adopts a generation from a dead owner and refuses one with a live owner", async () => {
    const repoRoot = fs.mkdtempSync(path.join(tempDir, "repo-adopt-"));
    const root = fs.mkdtempSync(path.join(tempDir, "instance-"));
    const { instance, ledger } = await registerFixtureInstance({
      id: "adopt",
      root,
      repoRoot,
      ledger: { owner: deadProcessStart() },
    });
    const adopter = await claimFixtureLedger({ id: "adopter" });

    const adopted = adoptDevInstance(repoRoot, instance, { ledgerId: adopter.id });
    expect(adopted).toMatchObject({
      generationId: instance.generationId,
      ledgerId: adopter.id,
      ledgerToken: adopter.token,
    });
    expect(resolveDevInstance(repoRoot, "adopt").ledgerId).toBe(adopter.id);

    // The adopter's claim is live now: another adopter may not take the generation.
    const other = await claimFixtureLedger({ id: "other-adopter" });
    expect(() => adoptDevInstance(repoRoot, adopted, { ledgerId: other.id })).toThrow(
      expect.objectContaining({ code: "EOWNERSHIP" })
    );
    expect(ledger.id).not.toBe(adopter.id);
    expect(() =>
      adoptDevInstance(
        repoRoot,
        { ...instance, generationId: "b".repeat(32) },
        { ledgerId: other.id }
      )
    ).toThrow(/generation changed/u);
  });

  describe("claiming an instance id", () => {
    it("grants a contended claim to exactly one owner and rejects the rest as claimed", async () => {
      const repoRoot = fs.mkdtempSync(path.join(tempDir, "repo-race-"));
      const id = devInstanceLedgerId(repoRoot, "race");
      const attempts = await Promise.allSettled(
        Array.from({ length: 6 }, () =>
          Ownership.open({ profileDir: profileRoot(), id, lifetime: "until-stop" })
        )
      );
      const winners = attempts.flatMap((attempt) =>
        attempt.status === "fulfilled" ? [attempt.value] : []
      );
      const losers = attempts.flatMap((attempt) =>
        attempt.status === "rejected" ? [attempt.reason] : []
      );
      try {
        expect(winners).toHaveLength(1);
        expect(losers).toHaveLength(5);
        for (const loser of losers) expect(loser).toBeInstanceOf(OwnershipClaimedError);
        expect(readLedger(devInstanceLedgerDir(), id)?.owner.pid).toBe(process.pid);
      } finally {
        await Promise.all(winners.map((winner) => winner.release()));
      }
      expect(readLedger(devInstanceLedgerDir(), id)).toBeNull();
    });

    it("lets exactly one racer take over a stale claim and removes what the stale claim owned", async () => {
      const repoRoot = fs.mkdtempSync(path.join(tempDir, "repo-takeover-"));
      const id = devInstanceLedgerId(repoRoot, "takeover");
      const staleRecord = devInstanceRecordPath(repoRoot, "takeover");
      fs.mkdirSync(path.dirname(staleRecord), { recursive: true });
      fs.writeFileSync(staleRecord, "{}");
      await claimFixtureLedger({
        id,
        owner: deadProcessStart(),
        reaper: deadProcessStart(),
        paths: [{ path: staleRecord, kind: "path" }],
      });

      const attempts = await Promise.allSettled(
        Array.from({ length: 6 }, () =>
          Ownership.open({ profileDir: profileRoot(), id, lifetime: "until-stop" })
        )
      );
      const winners = attempts.flatMap((attempt) =>
        attempt.status === "fulfilled" ? [attempt.value] : []
      );
      try {
        expect(winners).toHaveLength(1);
        expect(
          attempts.filter(
            (attempt) =>
              attempt.status === "rejected" && attempt.reason instanceof OwnershipClaimedError
          )
        ).toHaveLength(5);
        expect(fs.existsSync(staleRecord)).toBe(false);
        expect(readLedger(devInstanceLedgerDir(), id)?.owner.pid).toBe(process.pid);
      } finally {
        await Promise.all(winners.map((winner) => winner.release()));
      }
    });
  });
});

/** The profile directory the registry resolves, as `Ownership.open` needs it. */
function profileRoot(): string {
  return path.dirname(devInstanceLedgerDir());
}
