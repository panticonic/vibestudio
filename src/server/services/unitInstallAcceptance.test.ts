import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UnitAuthorityManifest } from "@vibestudio/shared/authorityManifest";
import { installRowKey } from "@vibestudio/shared/authority/unitInstallReview";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { UnitAdmissionStore } from "./unitAdmissionStore.js";
import { heldClearanceRowKeys } from "./unitClearanceGrants.js";
import { acceptUnitInstallReview, prepareUnitInstallReview } from "./unitInstallAcceptance.js";

let root: string;
let grantStore: CapabilityGrantStore;
let admissionStore: UnitAdmissionStore;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "unit-install-acceptance-"));
  grantStore = new CapabilityGrantStore({ statePath: root });
  admissionStore = new UnitAdmissionStore({ statePath: root });
});

afterEach(() => {
  grantStore.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const everywhere = { kind: "prefix", prefix: "" } as const;
const rowKey = (capability: string) => installRowKey({ capability, resourceScope: everywhere });

function authority(...capabilities: string[]): UnitAuthorityManifest {
  return {
    requests: capabilities.map((capability) => ({
      capability,
      resource: everywhere,
      tier: "gated" as const,
      evidence: "intentional-broad" as const,
    })),
    provides: [],
  };
}

const shell = {
  repoPath: "apps/shell",
  effectiveVersion: "ev-1",
  authority: authority("workspace.files.write"),
};

describe("acceptUnitInstallReview", () => {
  // The bug this module exists to make impossible: the launch gate confirmed a
  // unit, nothing recorded it, and the gate that reads admission then demanded a
  // review the unit could not answer because answering was itself gated on it.
  it("records admission and clearance for a unit decided at the launch gate", () => {
    acceptUnitInstallReview(
      { admissionStore, grantStore },
      { units: [{ identity: shell }], origin: "launch-gate" }
    );

    expect(admissionStore.has(shell)).toBe(true);
    expect(admissionStore.originFor(shell)).toBe("launch-gate");
    expect(admissionStore.hasVersion("apps/shell", "ev-1")).toBe(true);
    expect([...heldClearanceRowKeys({ grantStore, ...shell })]).toEqual([
      rowKey("workspace.files.write"),
    ]);
  });

  it("admits every unit while clearing only what the selection allowed", () => {
    const panel = {
      repoPath: "panels/news",
      effectiveVersion: "ev-1",
      authority: authority("workspace.files.write", "notifications"),
    };
    acceptUnitInstallReview(
      { admissionStore, grantStore },
      {
        origin: "workspace-creation",
        units: [
          // Nothing was checked for this one. It still arrives and still runs —
          // selection withholds clearance, never admission (U5).
          { identity: panel, clearedRowKeys: [] },
          { identity: shell },
        ],
      }
    );

    expect(admissionStore.has(panel)).toBe(true);
    expect([...heldClearanceRowKeys({ grantStore, ...panel })]).toEqual([]);
    // An absent selection means the full slate, which is a different thing from
    // an empty one.
    expect([...heldClearanceRowKeys({ grantStore, ...shell })]).toEqual([
      rowKey("workspace.files.write"),
    ]);
  });

  it("retires the outgoing version's clearance in the same step", () => {
    acceptUnitInstallReview(
      { admissionStore, grantStore },
      { units: [{ identity: shell }], origin: "launch-gate" }
    );
    const updated = { ...shell, effectiveVersion: "ev-2" };
    acceptUnitInstallReview(
      { admissionStore, grantStore },
      {
        units: [
          { identity: updated, previous: { repoPath: "apps/shell", effectiveVersion: "ev-1" } },
        ],
        origin: "launch-gate",
      }
    );

    // Grants are version-bound: leaving the old ones behind would let a reverted
    // unit silently regain authority the user had moved on from.
    expect([...heldClearanceRowKeys({ grantStore, ...shell })]).toEqual([]);
    expect([...heldClearanceRowKeys({ grantStore, ...updated })]).toEqual([
      rowKey("workspace.files.write"),
    ]);
  });

  it("restores admission and the outgoing clearance when publication fails", () => {
    acceptUnitInstallReview(
      { admissionStore, grantStore },
      { units: [{ identity: shell }], origin: "publication" }
    );
    const updated = { ...shell, effectiveVersion: "ev-2" };
    const prepared = prepareUnitInstallReview(
      { admissionStore, grantStore },
      {
        units: [
          {
            identity: updated,
            previous: { repoPath: shell.repoPath, effectiveVersion: shell.effectiveVersion },
          },
        ],
        origin: "publication",
      }
    );

    expect(admissionStore.has(updated)).toBe(true);
    expect([...heldClearanceRowKeys({ grantStore, ...updated })]).toEqual([
      rowKey("workspace.files.write"),
    ]);
    prepared.failed(new Error("protected refs rejected the publication"));

    expect(admissionStore.has(updated)).toBe(false);
    expect(admissionStore.has(shell)).toBe(true);
    expect([...heldClearanceRowKeys({ grantStore, ...shell })]).toEqual([
      rowKey("workspace.files.write"),
    ]);
    expect([...heldClearanceRowKeys({ grantStore, ...updated })]).toEqual([]);
  });

  it("still restores admission when grant rollback itself fails", () => {
    const prepared = prepareUnitInstallReview(
      { admissionStore, grantStore },
      { units: [{ identity: shell }], origin: "publication" }
    );
    vi.spyOn(grantStore, "rollbackInstallClearance").mockImplementationOnce(() => {
      throw new Error("grant database unavailable");
    });

    expect(() => prepared.failed(new Error("protected refs rejected the publication"))).toThrow(
      /could not be rolled back/
    );

    expect(admissionStore.has(shell)).toBe(false);
    expect(new UnitAdmissionStore({ statePath: root }).has(shell)).toBe(false);
  });

  // The bug §7.3 exists to forbid: an update nobody was asked about handed back
  // the permissions the user had unchecked at install.
  it("carries an unasked update's clearance forward instead of re-granting the slate", () => {
    const news = {
      repoPath: "panels/news",
      effectiveVersion: "ev-1",
      authority: authority("workspace.files.write", "notifications"),
    };
    acceptUnitInstallReview(
      { admissionStore, grantStore },
      {
        units: [{ identity: news, clearedRowKeys: [rowKey("notifications")] }],
        origin: "publication",
      }
    );

    // A code-only update: same declaration, new version, no row of its own (U7),
    // so nothing supplies a selection for it.
    const updated = { ...news, effectiveVersion: "ev-2" };
    acceptUnitInstallReview(
      { admissionStore, grantStore },
      {
        units: [
          { identity: updated, previous: { repoPath: "panels/news", effectiveVersion: "ev-1" } },
        ],
        origin: "publication",
      }
    );

    expect([...heldClearanceRowKeys({ grantStore, ...updated })]).toEqual([
      rowKey("notifications"),
    ]);
  });

  it("keeps an update the user emptied empty, rather than reading it as unasked", () => {
    acceptUnitInstallReview(
      { admissionStore, grantStore },
      { units: [{ identity: shell }], origin: "publication" }
    );
    const updated = { ...shell, effectiveVersion: "ev-2" };
    acceptUnitInstallReview(
      { admissionStore, grantStore },
      {
        units: [
          {
            identity: updated,
            previous: { repoPath: "apps/shell", effectiveVersion: "ev-1" },
            clearedRowKeys: [],
          },
        ],
        origin: "publication",
      }
    );

    expect([...heldClearanceRowKeys({ grantStore, ...updated })]).toEqual([]);
  });

  // A unit arriving for the first time has nothing to inherit, so one click
  // still adds the complete slate.
  it("gives a unit with no previous version everything its manifest makes clearable", () => {
    acceptUnitInstallReview(
      { admissionStore, grantStore },
      { units: [{ identity: shell }], origin: "host-build" }
    );

    expect([...heldClearanceRowKeys({ grantStore, ...shell })]).toEqual([
      rowKey("workspace.files.write"),
    ]);
  });

  // What `admitDecidedUnits` wires up: the gate asks nothing about permissions,
  // so the outgoing version is both what retires and what the decision inherits.
  it("retires and inherits from the version the admission store names as outgoing", () => {
    acceptUnitInstallReview(
      { admissionStore, grantStore },
      {
        units: [
          {
            identity: {
              ...shell,
              authority: authority("workspace.files.write", "notifications"),
            },
            clearedRowKeys: [rowKey("workspace.files.write")],
          },
        ],
        origin: "launch-gate",
      }
    );
    const outgoing = admissionStore.latestAdmittedVersion("apps/shell");
    expect(outgoing).toBe("ev-1");

    const updated = {
      repoPath: "apps/shell",
      effectiveVersion: "ev-2",
      authority: authority("workspace.files.write", "notifications"),
    };
    acceptUnitInstallReview(
      { admissionStore, grantStore },
      {
        units: [
          { identity: updated, previous: { repoPath: "apps/shell", effectiveVersion: outgoing! } },
        ],
        origin: "launch-gate",
      }
    );

    expect([
      ...heldClearanceRowKeys({ grantStore, repoPath: "apps/shell", effectiveVersion: "ev-1" }),
    ]).toEqual([]);
    expect([...heldClearanceRowKeys({ grantStore, ...updated })]).toEqual([
      rowKey("workspace.files.write"),
    ]);
  });

  it("is a no-op for an empty acceptance", () => {
    acceptUnitInstallReview({ admissionStore, grantStore }, { units: [], origin: "launch-gate" });
    expect(admissionStore.isEmpty()).toBe(true);
  });
});
