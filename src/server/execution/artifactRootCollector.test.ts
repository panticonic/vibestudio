import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256 } from "@vibestudio/shared/execution/identity";
import { collectArtifactRetentionRoots } from "./artifactRootCollector.js";

const roots: string[] = [];
afterEach(() =>
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }))
);

describe("artifact root collector", () => {
  it("collects active, transition, rollback, exact-grant, and bootstrap roots", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-roots-"));
    roots.push(root);
    const digests = Array.from({ length: 6 }, (_, index) => sha256(`artifact-${index}`));
    fs.writeFileSync(
      path.join(root, "runtime-incarnations.json"),
      JSON.stringify({
        version: 1,
        active: { entity: "inc-active" },
        incarnations: [
          { incarnationId: "inc-active", artifact: { executionDigest: digests[0] } },
          { incarnationId: "inc-next", artifact: { executionDigest: digests[1] } },
        ],
        transitions: [
          { transitionId: "transition", toIncarnationId: "inc-next", status: "awaiting-adoption" },
        ],
      })
    );
    fs.mkdirSync(path.join(root, "units", "app"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "units", "app", "registry.json"),
      JSON.stringify({
        unitKind: "app",
        entries: [
          {
            name: "shell",
            activeExecutionDigest: digests[2],
            previousVersions: [{ activeExecutionDigest: digests[3] }],
          },
        ],
      })
    );
    fs.writeFileSync(
      path.join(root, "capability-grants.json"),
      JSON.stringify({
        version: 2,
        grants: [
          {
            capability: "fs.write",
            effect: "allow",
            binding: { kind: "exact-execution", executionDigest: digests[4] },
          },
          {
            capability: "fs.write",
            effect: "deny",
            binding: { kind: "exact-execution", executionDigest: sha256("denied") },
          },
        ],
      })
    );
    fs.writeFileSync(
      path.join(root, "product-boot-manifest.json"),
      JSON.stringify({ artifacts: [{ id: "workspace-substrate", executionDigest: digests[5] }] })
    );

    const collected = collectArtifactRetentionRoots(root);
    expect(collected.map((item) => item.executionDigest)).toEqual(expect.arrayContaining(digests));
    expect(collected.map((item) => item.kind)).toEqual(
      expect.arrayContaining([
        "active-incarnation",
        "upgrade-transition",
        "app-version",
        "code-grant",
        "bootstrap-manifest",
      ])
    );
    expect(collected).toHaveLength(6);
  });

  it("fails closed on a truncated security root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-roots-"));
    roots.push(root);
    fs.writeFileSync(
      path.join(root, "capability-grants.json"),
      JSON.stringify({
        version: 2,
        grants: [
          {
            capability: "fs.write",
            effect: "allow",
            binding: { kind: "exact-execution", executionDigest: "short" },
          },
        ],
      })
    );
    expect(() => collectArtifactRetentionRoots(root)).toThrow("full lowercase SHA-256");
  });
});
