import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseUnitAuthorityManifest } from "@vibestudio/shared/authorityManifest";
import type { BuildUnitIdentityResolution } from "../buildV2/index.js";
import { UnitAdmissionStore, serviceAuthorityDigest } from "./unitAdmissionStore.js";
import { prepareUnitInstallReview } from "./unitInstallAcceptance.js";
import { isSealedCodeAdmitted } from "./codeAdmission.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const statePath = fs.mkdtempSync(path.join(os.tmpdir(), "code-admission-"));
  roots.push(statePath);
  const authority = parseUnitAuthorityManifest(
    {
      requests: [],
      provides: [],
      serviceRequests: [{ protocol: "task-board", availability: "required" }],
    },
    "test"
  );
  const serviceBindings: BuildUnitIdentityResolution["serviceBindings"] = [
    {
      protocol: "task-board",
      availability: "required",
      serviceName: "tasks",
      providerUnit: "workers/tasks",
      catalogDigest: "b".repeat(64),
    },
  ];
  const serviceReviews: BuildUnitIdentityResolution["serviceReviews"] = [
    {
      capability: "workspace-service:tasks",
      providerUnit: "workers/tasks",
      catalogDigest: "b".repeat(64),
      presentation: {
        action: "manage tasks",
        authorityCategory: { domain: "automation", verb: "manage" },
        notability: "everyday",
      },
    },
  ];
  const code = {
    repoPath: "workers/agent",
    effectiveVersion: "agent-ev",
    executionDigest: "a".repeat(64),
  };
  const store = new UnitAdmissionStore({ statePath });
  prepareUnitInstallReview(
    { admissionStore: store },
    {
      origin: "launch-gate",
      units: [
        {
          identity: { repoPath: code.repoPath, effectiveVersion: code.effectiveVersion, authority },
          serviceBindings,
          serviceReviews,
        },
      ],
    }
  ).committed();
  const input = {
    code,
    admissionStore: new UnitAdmissionStore({ statePath }),
    image: {
      sourcePath: code.repoPath,
      ev: code.effectiveVersion,
      execution: { executionDigest: code.executionDigest },
      authority,
      serviceAuthorityDigest: serviceAuthorityDigest(serviceBindings, serviceReviews),
    },
  };
  return { input, serviceBindings, serviceReviews };
}

describe("sealed executable admission", () => {
  it("joins launch-gate and runtime decisions using the complete persisted identity", () => {
    const { input } = fixture();
    expect(
      input.admissionStore.has({
        repoPath: input.code.repoPath,
        effectiveVersion: input.code.effectiveVersion,
        authority: input.image.authority,
      })
    ).toBe(false);
    expect(isSealedCodeAdmitted(input)).toBe(true);
  });

  it("does not reuse approval across provider, catalog, or review changes with unchanged code", () => {
    const { input, serviceBindings, serviceReviews } = fixture();
    for (const [bindings, reviews] of [
      [[{ ...serviceBindings[0]!, providerUnit: "workers/replacement" }], serviceReviews],
      [[{ ...serviceBindings[0]!, catalogDigest: "c".repeat(64) }], serviceReviews],
      [
        serviceBindings,
        [
          {
            ...serviceReviews[0]!,
            presentation: { ...serviceReviews[0]!.presentation!, action: "delete tasks" },
          },
        ],
      ],
      [[], []],
    ] as const) {
      expect(
        isSealedCodeAdmitted({
          ...input,
          image: {
            ...input.image,
            serviceAuthorityDigest: serviceAuthorityDigest(bindings, reviews),
          },
        })
      ).toBe(false);
    }
    expect(isSealedCodeAdmitted(input)).toBe(true);
  });

  it("fails closed on missing facts, changed code, and a different executable image", () => {
    const { input } = fixture();
    for (const image of [
      null,
      { ...input.image, sourcePath: "workers/other" },
      { ...input.image, ev: "different-ev" },
      { ...input.image, execution: { executionDigest: "d".repeat(64) } },
      { ...input.image, serviceAuthorityDigest: undefined },
      { ...input.image, serviceAuthorityDigest: "bad" },
      { ...input.image, authority: { requests: [], provides: [] } },
    ]) {
      expect(isSealedCodeAdmitted({ ...input, image })).toBe(false);
    }
  });
});
