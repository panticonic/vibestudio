import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseUnitAuthorityManifest } from "@vibestudio/shared/authorityManifest";
import {
  extensionUnitManifestDescriptor,
  readAndValidateUnitManifest,
} from "@vibestudio/shared/unitManifest";
import { expect, it } from "vitest";
import { discoverPackageGraph } from "../../src/server/buildV2/packageGraph.js";
import {
  writeNativeApprovalModelProvider,
  writeNativeApprovalReviewExtension,
} from "./nativeApprovalModelProvider.js";

it("discovers the approval provider at the actual local-model extension identity", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-approval-source-"));
  try {
    const repoPath = writeNativeApprovalModelProvider(root);
    const reviewRepo = writeNativeApprovalReviewExtension(root);
    const graph = discoverPackageGraph(root);
    expect(graph.manifestIssueForPath(repoPath)).toBeUndefined();
    expect(graph.get("@workspace-extensions/local-models")).toMatchObject({
      relativePath: "extensions/local-models",
      kind: "extension",
      manifest: { extension: { activationEvents: ["onInvoke"] } },
    });
    const manifest = JSON.parse(fs.readFileSync(path.join(root, repoPath, "package.json"), "utf8"));
    expect(parseUnitAuthorityManifest(manifest.vibestudio.authority)).toEqual({
      requests: [
        {
          capability: "context.boundary",
          resource: { kind: "prefix", prefix: "" },
          tier: "critical",
          evidence: "intentional-broad",
        },
      ],
      serviceRequests: [],
      provides: [],
    });
    // Package-graph discovery and authority.requests parsing do not validate the
    // native method policy; this is the actual pre-approval owner boundary.
    for (const source of [repoPath, reviewRepo]) {
      const packagePath = path.join(root, source, "package.json");
      const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
      const validate = () =>
        readAndValidateUnitManifest(
          extensionUnitManifestDescriptor,
          packagePath,
          { unitName: pkg.name },
          fs.readFileSync
        );
      expect(validate()).toMatchObject({
        extension: { methodAuthority: pkg.vibestudio.extension.methodAuthority },
      });
      const method = Object.keys(pkg.vibestudio.extension.methodAuthority)[0]!;
      delete pkg.vibestudio.extension.methodAuthority[method].website;
      fs.writeFileSync(packagePath, JSON.stringify(pkg));
      expect(validate).toThrow("must contain one effect and an explicit website policy");
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("refuses to overwrite an existing local-model extension", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-approval-existing-"));
  try {
    const extensionRoot = path.join(root, "extensions/local-models");
    fs.mkdirSync(extensionRoot, { recursive: true });
    const original = '{"name":"@workspace-extensions/local-models","private":true}';
    fs.writeFileSync(path.join(extensionRoot, "package.json"), original);
    expect(() => writeNativeApprovalModelProvider(root)).toThrow("must not replace an existing");
    expect(fs.readFileSync(path.join(extensionRoot, "package.json"), "utf8")).toBe(original);
    expect(fs.readdirSync(extensionRoot)).toEqual(["package.json"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
