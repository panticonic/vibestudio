#!/usr/bin/env node
/** Validate, or explicitly adopt, the exact Base pin from the publisher's Git-readback receipt. */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = path.join(root, "build-resources", "base-template-release.json");
const canonicalBaseUrl = "git+https://github.com/panticonic/vibestudio-workspace-base.git";
const receiptFlag = process.argv.indexOf("--receipt");
const receiptPath = receiptFlag >= 0 ? process.argv[receiptFlag + 1] : undefined;

const { parseBaseTemplateReleaseArtifact } = await import(
  path.join(root, "packages/workspace/src/baseTemplateRelease.ts")
);
const { templatePublicationSchema } = await import(
  path.join(root, "packages/service-schemas/src/templates.ts")
);

if (receiptFlag >= 0 && !receiptPath) {
  throw new Error("--receipt requires a verified Base publication receipt path");
}

let artifact;
if (receiptPath) {
  const publication = templatePublicationSchema.parse(
    JSON.parse(fs.readFileSync(path.resolve(receiptPath), "utf8"))
  );
  if (publication.templateUrl !== canonicalBaseUrl) {
    throw new Error(
      `Base publication receipt targets ${publication.templateUrl}; expected ${canonicalBaseUrl}`
    );
  }
  artifact = parseBaseTemplateReleaseArtifact({
    format: "vibestudio-base-release/1",
    baseTemplate: {
      url: publication.templateUrl,
      ref: publication.ref,
      commit: publication.commit,
      snapshot: publication.snapshot,
    },
  });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  console.log(`Adopted published Base ${artifact.baseTemplate.commit}`);
} else {
  if (!fs.existsSync(destination)) {
    throw new Error("Missing host Base release pointer; adopt a verified publication receipt");
  }
  artifact = parseBaseTemplateReleaseArtifact(JSON.parse(fs.readFileSync(destination, "utf8")));
  console.log(`Base release pointer is structurally valid (${artifact.baseTemplate.commit}).`);
}
