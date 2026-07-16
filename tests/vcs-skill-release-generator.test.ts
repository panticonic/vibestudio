import { describe, expect, it } from "vitest";

import { vcsMethods } from "../packages/service-schemas/src/vcs.js";
import {
  buildContentManifest,
  buildGeneratedArtifacts,
  buildPublicContract,
  runReleaseGate,
  validateRepositoryReleaseGate,
  validateSchemaFixtures,
} from "../scripts/generate-vcs-skill-release.mjs";

describe("VCS skill release generator", () => {
  it("keeps the generated contract and compact skill package manifest fresh", () => {
    expect(() => runReleaseGate({ checkOnly: true })).not.toThrow();
  });

  it("derives exactly the small public contract from the sole registry", () => {
    const contract = buildPublicContract();
    expect(Object.keys(contract.methods)).toEqual(Object.keys(vcsMethods));
    expect(Object.keys(contract.methods)).toHaveLength(18);
    expect(contract.methods.move.description).toContain("stable file or repository identities");
    expect(contract.methods.copy.description).toContain("immediate coordinate provenance");
    expect(contract.methods.commit.description).toContain("complete local application chain");

    const exactSchema = JSON.stringify(contract.exactSchema);
    expect(exactSchema).toContain("VcsPublicContract");
    expect(exactSchema).toContain("RevisionChanged");
    expect(exactSchema).toContain("applicationId");
    expect(exactSchema).not.toContain("sourceBasisId");
    expect(exactSchema).not.toContain("frontierId");
  });

  it("validates focused call shapes and the canonical skill", () => {
    expect(() => validateSchemaFixtures()).not.toThrow();
    expect(() => validateRepositoryReleaseGate()).not.toThrow();
  });

  it("hashes the actual skill package without a recursive repository inventory", () => {
    const artifacts = buildGeneratedArtifacts();
    const manifest = JSON.parse(
      artifacts.get("workspace/skills/vibestudio-vcs/content-manifest.json")!
    ) as ReturnType<typeof buildContentManifest>;

    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.packageDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.files).toContainEqual(
      expect.objectContaining({ path: "SKILL.md", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })
    );
    expect(manifest.files.map(({ path }) => path)).not.toContain("content-manifest.json");
    expect(manifest.files.map(({ path }) => path)).not.toContain(
      "instruction-surface-inventory.json"
    );
  });
});
