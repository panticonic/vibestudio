import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UnitAuthorityManifest } from "@vibestudio/shared/authorityManifest";
import {
  installRowKey,
  reviewedUserlandDefinitions,
} from "@vibestudio/shared/authority/unitInstallReview";
import type { UserlandCapabilityDefinition } from "@vibestudio/shared/authorityManifest";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";
import {
  clearableRequests,
  heldClearanceRowKeys,
  mintUnitClearanceGrants,
  retireUnitClearanceGrants,
} from "./unitClearanceGrants.js";

let root: string;
let grantStore: CapabilityGrantStore;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "unit-clearance-"));
  grantStore = new CapabilityGrantStore({ statePath: root });
});

afterEach(() => {
  grantStore.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const everywhere = { kind: "prefix", prefix: "" } as const;

function authority(
  requests: Array<{ capability: string; tier?: "gated" | "critical" }>
): UnitAuthorityManifest {
  return {
    requests: requests.map(({ capability, tier }) => ({
      capability,
      resource: everywhere,
      tier: tier ?? "gated",
      evidence: "intentional-broad" as const,
    })),
    provides: [],
  };
}

const rowKey = (capability: string) => installRowKey({ capability, resourceScope: everywhere });

function mint(unit: {
  repoPath?: string;
  effectiveVersion?: string;
  authority: UnitAuthorityManifest;
  clearedRowKeys?: readonly string[];
}) {
  return mintUnitClearanceGrants({
    grantStore,
    units: [
      {
        repoPath: unit.repoPath ?? "panels/news",
        effectiveVersion: unit.effectiveVersion ?? "ev-1",
        authority: unit.authority,
        ...(unit.clearedRowKeys === undefined ? {} : { clearedRowKeys: unit.clearedRowKeys }),
      },
    ],
    origin: "template-install",
    decidedBy: "user:alice",
    issuedBy: "host:vibestudio",
  });
}

function definition(
  grantScopes: UserlandCapabilityDefinition["grantScopes"]
): UserlandCapabilityDefinition {
  return {
    name: "read-feed",
    title: "Read a feed",
    action: "read a feed",
    tier: "gated",
    sensitivity: "read",
    resourceType: "feed",
    presentation: { domain: "automation", verb: "act" },
    notability: "everyday",
    grantScopes,
  };
}

describe("install clearance", () => {
  it("binds to the reviewed unit version, not to a build", () => {
    const [grant] = mint({ authority: authority([{ capability: "workspace.files.write" }]) });
    expect(grant).toMatchObject({
      subject: "code:panels/news@ev-1",
      capability: "workspace.files.write",
      effect: "allow",
      provenance: "install",
      scope: "version",
      decidedBy: "user:alice",
    });
  });

  it("mints nothing for a request that keeps asking at use", () => {
    expect(
      mint({
        authority: authority([
          { capability: "credential.use" },
          { capability: "git.publish", tier: "critical" },
        ]),
      })
    ).toEqual([]);
  });

  it("does not turn a provider task ceiling into a version grant", () => {
    const manifest = authority([{ capability: "workspace-service:read-feed" }]);
    const issued = mintUnitClearanceGrants({
      grantStore,
      units: [
        {
          repoPath: "panels/news",
          effectiveVersion: "ev-1",
          authority: manifest,
        },
      ],
      origin: "template-install",
      decidedBy: "user:alice",
      issuedBy: "host:vibestudio",
      userlandDefinitions: new Map([["workspace-service:read-feed", definition(["once", "task"])]]),
    });
    expect(issued).toEqual([]);
  });

  it("mints version clearance for a reviewed direct receiver wildcard", () => {
    const capability = "userland:workers/browser-data/browser-data.write#*";
    const manifest = authority([{ capability }]);
    const receiver = {
      ...definition(["once", "version"]),
      name: "browser-data.write",
    };
    const issued = mintUnitClearanceGrants({
      grantStore,
      units: [
        {
          repoPath: "extensions/browser-data",
          effectiveVersion: "ev-browser-extension",
          authority: manifest,
        },
      ],
      origin: "workspace-creation",
      decidedBy: "user:alice",
      issuedBy: "host:vibestudio",
      userlandDefinitions: reviewedUserlandDefinitions([
        {
          repoPath: "workers/browser-data",
          authority: { provides: [receiver] },
        },
      ]),
    });

    expect(issued).toEqual([
      expect.objectContaining({
        capability,
        resource: everywhere,
        subject: "code:extensions/browser-data@ev-browser-extension",
        scope: "version",
      }),
    ]);
  });

  it("withholds a grant for a row the user deselected, and admits the unit anyway", () => {
    const manifest = authority([
      { capability: "workspace.files.write" },
      { capability: "notifications" },
    ]);
    const issued = mint({ authority: manifest, clearedRowKeys: [rowKey("notifications")] });

    expect(issued.map((grant) => grant.capability)).toEqual(["notifications"]);
    expect(
      heldClearanceRowKeys({ grantStore, repoPath: "panels/news", effectiveVersion: "ev-1" })
    ).toEqual(new Set([rowKey("notifications")]));
  });

  it("treats an empty selection as a real choice rather than a missing one", () => {
    expect(
      mint({ authority: authority([{ capability: "workspace.files.write" }]), clearedRowKeys: [] })
    ).toEqual([]);
  });

  it("never mints a row the review could not have offered, however the acceptance was shaped", () => {
    const issued = mint({
      authority: authority([{ capability: "credential.use" }]),
      clearedRowKeys: [rowKey("credential.use")],
    });
    expect(issued).toEqual([]);
  });

  it("retires the outgoing version's clearance without touching another unit's", () => {
    mint({ authority: authority([{ capability: "workspace.files.write" }]) });
    mint({
      repoPath: "panels/chat",
      authority: authority([{ capability: "workspace.files.write" }]),
    });

    expect(
      retireUnitClearanceGrants({
        grantStore,
        units: [{ repoPath: "panels/news", effectiveVersion: "ev-1" }],
      })
    ).toBe(1);
    expect(
      heldClearanceRowKeys({ grantStore, repoPath: "panels/news", effectiveVersion: "ev-1" }).size
    ).toBe(0);
    expect(
      heldClearanceRowKeys({ grantStore, repoPath: "panels/chat", effectiveVersion: "ev-1" }).size
    ).toBe(1);
  });

  it("carries an earlier decision into the next version instead of re-granting everything", () => {
    const manifest = authority([
      { capability: "workspace.files.write" },
      { capability: "notifications" },
    ]);
    mint({ authority: manifest, clearedRowKeys: [rowKey("notifications")] });

    // §7.3: new clearance = rows already cleared ∩ the new manifest ∩ policy.
    const held = heldClearanceRowKeys({
      grantStore,
      repoPath: "panels/news",
      effectiveVersion: "ev-1",
    });
    const nextClearable = clearableRequests(manifest).map((entry) => entry.key);
    const carried = nextClearable.filter((key) => held.has(key));
    mint({ effectiveVersion: "ev-2", authority: manifest, clearedRowKeys: carried });

    expect(
      heldClearanceRowKeys({ grantStore, repoPath: "panels/news", effectiveVersion: "ev-2" })
    ).toEqual(new Set([rowKey("notifications")]));
  });

  it("leaves a revoked permission revoked instead of resurrecting it", () => {
    const manifest = authority([{ capability: "workspace.files.write" }]);
    const [grant] = mint({ authority: manifest });
    expect(grantStore.revoke(grant!.id!)).toBe(true);

    expect(
      heldClearanceRowKeys({ grantStore, repoPath: "panels/news", effectiveVersion: "ev-1" }).size
    ).toBe(0);
  });
});
