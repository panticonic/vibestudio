#!/usr/bin/env node
/** Adopt exact publication receipts for the authoring source and three runtime distributions. */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseBaseTemplateReleaseArtifact,
  DefaultWorkspaceTemplatesSchema,
} from "../packages/workspace/src/baseTemplateRelease.ts";
import { templatePublicationSchema } from "../packages/service-schemas/src/templates.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = path.join(root, "build-resources", "base-template-release.json");
const canonicalSourceUrl = "git+https://github.com/panticonic/vibestudio-workspace-base.git";
const roles = ["base", "personal", "system"];

function pinFromReceipt(receipt) {
  const publication = templatePublicationSchema.parse(receipt);
  return {
    url: publication.templateUrl,
    ref: publication.ref,
    commit: publication.commit,
  };
}

/** Source checkout identity and runtime distribution identities serve different consumers. */
export function adoptWorkspaceReleaseReceipts({ current, source, distributions }) {
  const artifact = current
    ? parseBaseTemplateReleaseArtifact(current)
    : { format: "vibestudio-base-release/1" };
  if (source) {
    const pin = pinFromReceipt(source);
    if (pin.url !== canonicalSourceUrl)
      throw new Error(
        `Source publication receipt targets ${pin.url}; expected ${canonicalSourceUrl}`
      );
    artifact.baseTemplate = pin;
  }
  if (distributions) {
    if (roles.some((role) => !distributions[role]))
      throw new Error("Adopt Base, Personal and System receipts together");
    artifact.workspaceTemplates = DefaultWorkspaceTemplatesSchema.parse(
      Object.fromEntries(roles.map((role) => [role, pinFromReceipt(distributions[role])]))
    );
  }
  const parsed = parseBaseTemplateReleaseArtifact(artifact);
  if (!parsed.workspaceTemplates)
    throw new Error(
      "Missing exact Base, Personal and System distribution pins; provide --base-receipt, --personal-receipt and --system-receipt before packaging"
    );
  return parsed;
}

export function generateWorkspaceRelease(args, output = destination) {
  const receipts = {};
  let check = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--check") {
      check = true;
      continue;
    }
    if (!["--receipt", ...roles.map((role) => `--${role}-receipt`)].includes(flag))
      throw new Error(`Unknown argument: ${flag}`);
    const input = args[++index];
    if (!input || input.startsWith("--"))
      throw new Error(`${flag} requires a publication receipt path`);
    if (receipts[flag]) throw new Error(`Duplicate argument: ${flag}`);
    receipts[flag] = JSON.parse(fs.readFileSync(path.resolve(input), "utf8"));
  }
  const hasDistribution = roles.some((role) => receipts[`--${role}-receipt`]);
  const hasReceipts = Object.keys(receipts).length > 0;
  if (check && hasReceipts) throw new Error("--check cannot adopt publication receipts");
  const artifact = adoptWorkspaceReleaseReceipts({
    current: fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, "utf8")) : undefined,
    source: receipts["--receipt"],
    distributions: hasDistribution
      ? Object.fromEntries(roles.map((role) => [role, receipts[`--${role}-receipt`]]))
      : undefined,
  });
  if (hasReceipts) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const temporary = `${output}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(artifact, null, 2)}\n`, { flag: "wx" });
      fs.renameSync(temporary, output);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
  return artifact;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const artifact = generateWorkspaceRelease(process.argv.slice(2));
  console.log(
    `Workspace release pins verified: ${roles.map((role) => `${role} ${artifact.workspaceTemplates[role].commit}`).join(", ")}`
  );
}
