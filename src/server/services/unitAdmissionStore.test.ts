import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UnitAuthorityManifest } from "@vibestudio/shared/authorityManifest";
import { writeFileAtomicSync } from "../../atomicFile.js";
import { stateLayout } from "../stateLayout.js";
import { UnitAdmissionStore } from "./unitAdmissionStore.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "unit-admission-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function authority(capability = "notifications"): UnitAuthorityManifest {
  return {
    requests: [
      {
        capability,
        resource: { kind: "exact", key: "workspace" },
        tier: "gated",
        evidence: "exact",
      },
    ],
    provides: [],
  };
}

const identity = {
  repoPath: "panels/example",
  effectiveVersion: "ev-1",
  authority: authority(),
};

describe("UnitAdmissionStore", () => {
  it("records an exact admission that survives a restart", () => {
    new UnitAdmissionStore({ statePath: root }).admit(identity, "workspace-creation");

    const reopened = new UnitAdmissionStore({ statePath: root });
    expect(reopened.has(identity)).toBe(true);
    expect(reopened.originFor(identity)).toBe("workspace-creation");
  });

  it("binds admission to the exact version and the exact declaration", () => {
    const store = new UnitAdmissionStore({ statePath: root });
    store.admit(identity, "publication");

    expect(store.has({ ...identity, effectiveVersion: "ev-2" })).toBe(false);
    expect(store.has({ ...identity, authority: authority("clipboard") })).toBe(false);
  });

  it("admits every unit an accepted operation lands in one write", () => {
    const store = new UnitAdmissionStore({ statePath: root });
    store.admitMany(
      [identity, { ...identity, repoPath: "workers/example", effectiveVersion: "ev-w" }],
      "template-install"
    );

    expect(store.admittedRepoPaths()).toEqual(["panels/example", "workers/example"]);
    expect(store.originFor(identity)).toBe("template-install");
  });

  it("does not expose an admission that failed to reach durable storage", () => {
    let writes = 0;
    const store = new UnitAdmissionStore({
      statePath: root,
      writeFileAtomic: (filePath, data, options) => {
        writes += 1;
        if (writes === 2) throw new Error("admission disk full");
        writeFileAtomicSync(filePath, data, options);
      },
    });
    store.admit(identity, "publication");
    const second = { ...identity, repoPath: "panels/second" };

    expect(() => store.admit(second, "publication")).toThrow("admission disk full");
    expect(store.has(second)).toBe(false);
    expect(new UnitAdmissionStore({ statePath: root }).has(second)).toBe(false);
    expect(store.has(identity)).toBe(true);
  });

  it("rolls back only its own admissions and preserves a later acceptance", () => {
    const store = new UnitAdmissionStore({ statePath: root });
    const preparedIdentity = { ...identity, repoPath: "panels/prepared" };
    const laterIdentity = { ...identity, repoPath: "panels/later" };
    const transaction = store.beginTransaction();
    transaction.admitMany([preparedIdentity], "publication");

    store.admit(laterIdentity, "launch-gate");
    transaction.failed(new Error("protected refs rejected the publication"));

    expect(store.has(preparedIdentity)).toBe(false);
    expect(store.has(laterIdentity)).toBe(true);
    const reopened = new UnitAdmissionStore({ statePath: root });
    expect(reopened.has(preparedIdentity)).toBe(false);
    expect(reopened.has(laterIdentity)).toBe(true);
  });

  it("does not undo a later decision for the same admission identity", () => {
    const store = new UnitAdmissionStore({ statePath: root });
    const transaction = store.beginTransaction();
    transaction.admitMany([identity], "publication", 1_000);

    store.admit(identity, "launch-gate", 2_000);
    transaction.failed(new Error("protected refs rejected the publication"));

    expect(store.has(identity)).toBe(true);
    expect(store.originFor(identity)).toBe("launch-gate");
    expect(new UnitAdmissionStore({ statePath: root }).originFor(identity)).toBe("launch-gate");
  });

  it("restores absence after repeated writes to one key in the same transaction", () => {
    const store = new UnitAdmissionStore({ statePath: root });
    const transaction = store.beginTransaction();
    transaction.admitMany([identity], "publication", 1_000);
    transaction.admitMany([identity], "chrome", 2_000);

    transaction.failed(new Error("protected refs rejected the publication"));

    expect(store.has(identity)).toBe(false);
    expect(new UnitAdmissionStore({ statePath: root }).has(identity)).toBe(false);
  });

  it("retires the admissions of units an operation removed", () => {
    const store = new UnitAdmissionStore({ statePath: root });
    store.admit(identity, "template-install");
    store.retire([identity]);

    expect(store.has(identity)).toBe(false);
    expect(new UnitAdmissionStore({ statePath: root }).has(identity)).toBe(false);
  });

  it("removes the all-or-nothing state at cutover instead of reading it", () => {
    const legacy = stateLayout(root).authority.approvedUnitVersionsFile;
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(
      legacy,
      JSON.stringify({
        schemaVersion: 1,
        approvals: [
          {
            repoPath: "panels/example",
            effectiveVersion: "ev-1",
            authorityDigest: "0".repeat(64),
            approvedAt: 1,
          },
        ],
      })
    );

    const store = new UnitAdmissionStore({ statePath: root });

    expect(fs.existsSync(legacy)).toBe(false);
    expect(store.has(identity)).toBe(false);
  });

  it("discards an older admission file rather than reading trust it cannot honour", () => {
    // Cutover, not migration: an older file records admissions taken when
    // admission still implied blanket authority. Re-reading it would leave
    // units admitted and ungranted — running, but asking for things they were
    // already allowed. Starting empty re-offers the creation review instead.
    const filePath = path.join(stateLayout(root).authority.root, "admitted-unit-versions.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 2,
        admissions: [
          {
            repoPath: "panels/example",
            effectiveVersion: "ev-1",
            authorityDigest: "a".repeat(64),
            origin: "publication",
            admittedAt: 1,
          },
        ],
      })
    );

    const store = new UnitAdmissionStore({ statePath: root });
    expect(store.isEmpty()).toBe(true);
    expect(store.has(identity)).toBe(false);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  // `hasVersion` is what keeps the creation review answerable: the surfaces that
  // answer it are admitted at the launch gate under whatever authority they
  // declared, and the review gate has only repoPath + version to ask with.
  it("answers whether a version was ever admitted, regardless of what it declared", () => {
    const store = new UnitAdmissionStore({ statePath: root });
    store.admit(identity, "launch-gate");

    expect(store.hasVersion("panels/example", "ev-1")).toBe(true);
    // A changed declaration is a different admission for `has`, but the version
    // has still been reviewed — that distinction is the whole point.
    expect(store.has({ ...identity, authority: authority("clipboard") })).toBe(false);
    expect(store.hasVersion("panels/example", "ev-1")).toBe(true);

    expect(store.hasVersion("panels/example", "ev-2")).toBe(false);
    expect(store.hasVersion("panels/other", "ev-1")).toBe(false);
  });

  // What an update needs in order to retire the version it replaces: without an
  // answer here the launch gate admits a new version alongside the old one's
  // still-standing grants, and a revert regains authority nobody re-approved.
  it("names the most recently admitted version as the one an update replaces", () => {
    const store = new UnitAdmissionStore({ statePath: root });
    store.admit(identity, "launch-gate", 1_000);
    store.admit({ ...identity, effectiveVersion: "ev-2" }, "launch-gate", 2_000);
    // A different unit's history never answers for this one.
    store.admit({ ...identity, repoPath: "panels/other" }, "launch-gate", 3_000);

    expect(store.latestAdmittedVersion("panels/example")).toBe("ev-2");
    expect(store.latestAdmittedVersion("panels/never-seen")).toBe(null);
  });

  // First encounter keys on WHERE THE BYTES CAME FROM, never on a repo path.
  // Recording only the deciding surface ("launch-gate") left that question
  // unanswerable, so every third-party origin was a first encounter forever.
  it("records the source the server derived, and reports it in origin key space", () => {
    const store = new UnitAdmissionStore({
      statePath: root,
      resolveSourceOrigin: (repoPath) =>
        repoPath === "panels/example"
          ? { originKey: "github.com/acme", url: "https://github.com/acme/studio" }
          : { originKey: "vibestudio", url: null },
    });
    store.admitMany([identity, { ...identity, repoPath: "workers/example" }], "template-install");

    expect([...store.admittedOriginKeys()].sort()).toEqual(["github.com/acme", "vibestudio"]);
    // It survives a restart, which is what makes the second encounter second.
    expect([...new UnitAdmissionStore({ statePath: root }).admittedOriginKeys()].sort()).toEqual([
      "github.com/acme",
      "vibestudio",
    ]);
  });

  it("uses candidate source facts supplied by the accepting transaction", () => {
    const store = new UnitAdmissionStore({
      statePath: root,
      resolveSourceOrigin: () => ({
        originKey: "github.com/current",
        url: "https://github.com/current/repo",
        version: "main",
      }),
    });
    const candidate = new Map([
      [
        identity.repoPath,
        {
          originKey: "github.com/candidate",
          url: "https://github.com/candidate/repo",
          version: "v2.0.0",
          selfName: "Candidate",
        },
      ],
    ]);

    store.admitMany([identity], "publication", undefined, candidate);

    expect(store.provenanceForVersion(identity.repoPath, identity.effectiveVersion)).toEqual({
      origin: "publication",
      sourceUrl: "https://github.com/candidate/repo",
      sourceSelfName: "Candidate",
      sourceVersion: "v2.0.0",
    });
  });

  it("reads a record written before the source was recorded, and claims no source for it", () => {
    const filePath = path.join(stateLayout(root).authority.root, "admitted-unit-versions.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 4,
        admissions: [
          {
            repoPath: "panels/example",
            effectiveVersion: "ev-1",
            authorityDigest: "a".repeat(64),
            serviceBindingDigest: "b".repeat(64),
            origin: "launch-gate",
            admittedAt: 1,
          },
        ],
      })
    );

    const store = new UnitAdmissionStore({ statePath: root });

    expect(store.isEmpty()).toBe(false);
    expect(store.hasVersion("panels/example", "ev-1")).toBe(true);
    // Silence about a source is not evidence the user has seen one.
    expect([...store.admittedOriginKeys()]).toEqual([]);
  });

  it("records nothing about a source when the server could not derive one", () => {
    const store = new UnitAdmissionStore({ statePath: root, resolveSourceOrigin: () => null });
    store.admit(identity, "launch-gate");

    expect([...store.admittedOriginKeys()]).toEqual([]);
    expect(store.has(identity)).toBe(true);
  });

  it("records the launch gate as its own origin", () => {
    const store = new UnitAdmissionStore({ statePath: root });
    store.admit(identity, "launch-gate");
    expect(store.originFor(identity)).toBe("launch-gate");

    // It survives a restart like any other origin — the file schema accepts it.
    expect(new UnitAdmissionStore({ statePath: root }).originFor(identity)).toBe("launch-gate");
  });
  // The audit trail §U2 requires: a removed template's parts still read
  // `Originally installed from News 1.2.0`, and after the removal the record
  // written here is the only place that name and that ref still exist.
  it("keeps the source name and human ref, so a removed template can still be named", () => {
    const store = new UnitAdmissionStore({
      statePath: root,
      resolveSourceOrigin: () => ({
        originKey: "github.com/panticonic",
        url: "https://github.com/panticonic/news",
        version: "1.2.0",
        selfName: "News",
      }),
    });
    store.admit(identity, "template-install");

    // Survives a restart, because the question it answers outlives the lock.
    const reopened = new UnitAdmissionStore({ statePath: root });
    expect(reopened.recordedSourceFor("panels/example")).toEqual({
      url: "https://github.com/panticonic/news",
      version: "1.2.0",
      selfName: "News",
      isWorkspaceRoot: false,
    });
    expect(reopened.provenanceForVersion("panels/example", "ev-1")).toMatchObject({
      sourceSelfName: "News",
      sourceVersion: "1.2.0",
    });
  });

  it("answers with the most recent admission for a repository, and nothing for an unknown one", () => {
    const store = new UnitAdmissionStore({
      statePath: root,
      resolveSourceOrigin: (repoPath) =>
        repoPath === "panels/example"
          ? { originKey: "github.com/acme", url: "https://github.com/acme/studio", version: "v1" }
          : null,
    });
    store.admit(identity, "template-install", 1_000);
    store.admit({ ...identity, effectiveVersion: "ev-2" }, "publication", 2_000);

    // A part updated three times still came from the same place; the latest
    // admission is the one whose attribution is current.
    expect(store.recordedSourceFor("panels/example")).toEqual({
      url: "https://github.com/acme/studio",
      version: "v1",
      selfName: null,
      isWorkspaceRoot: false,
    });
    expect(store.recordedSourceFor("workers/never-admitted")).toBeNull();
  });
});
