#!/usr/bin/env node
/** Validate, or explicitly adopt, the exact Base pin from a verified publication receipt. */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = path.join(root, "build-resources", "base-template-release.json");
const receiptFlag = process.argv.indexOf("--receipt");
const receiptPath = receiptFlag >= 0 ? process.argv[receiptFlag + 1] : undefined;

const { parseBaseTemplateReleaseArtifact } = await import(
  path.join(root, "packages/workspace/src/baseTemplateRelease.ts")
);

if (receiptFlag >= 0 && !receiptPath) {
  throw new Error("--receipt requires a verified Base publication receipt path");
}

let artifact;
if (receiptPath) {
  const receipt = JSON.parse(fs.readFileSync(path.resolve(receiptPath), "utf8"));
  if (receipt?.format !== "vibestudio-template-publication/1" || !receipt?.baseTemplate) {
    throw new Error("The supplied file is not a verified Base publication receipt");
  }
  if (receipt.verified !== true || receipt.readbackVerified !== true || receipt.pairVerified !== true) {
    throw new Error("Base publication receipt lacks verification/readback/pair evidence");
  }
  artifact = parseBaseTemplateReleaseArtifact({
    format: "vibestudio-base-release/1",
    baseTemplate: receipt.baseTemplate,
  });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  console.log(`Adopted verified Base ${artifact.baseTemplate.commit}`);
} else {
  if (!fs.existsSync(destination)) {
    throw new Error("Missing host Base release pointer; adopt a verified publication receipt");
  }
  artifact = parseBaseTemplateReleaseArtifact(JSON.parse(fs.readFileSync(destination, "utf8")));
  console.log(`Base release pointer is current (${artifact.baseTemplate.commit}).`);
}
