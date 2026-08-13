import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  parseUnitAuthorityManifest,
  type UnitAuthorityManifest,
} from "@vibestudio/shared/authorityManifest";
import {
  createCapabilityPresentationResolver,
  summarizeAuthorityManifest,
  type CapabilityRequesterKind,
} from "@vibestudio/shared/authorityPresentation";
import type { ServiceMethodSchemas } from "@vibestudio/shared/typedServiceClient";
import { collectWorkspaceRpcCatalog } from "../src/server/buildV2/workspaceRpcCatalog.js";
import { workspaceRpcSchema } from "../src/server/buildV2/workspaceRpcSchemas.js";

const userlandRootArgument = process.env.VIBESTUDIO_USERLAND_ROOT;
if (!userlandRootArgument) {
  throw new Error("VIBESTUDIO_USERLAND_ROOT must name the exact Base checkout to inspect");
}

const userlandRoot = path.resolve(userlandRootArgument);
const rootRealPath = fs.realpathSync(userlandRoot);

interface DurableClassDeclaration {
  className?: unknown;
  rpcSchema?: unknown;
}

interface PackageRecord {
  directory: string;
  label: string;
  provider: string;
  kind?: CapabilityRequesterKind;
  authority?: UnitAuthorityManifest;
  classes: DurableClassDeclaration[];
}

function packageManifests(directory: string): string[] {
  const manifests: string[] = [];
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) {
        continue;
      }
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name === "package.json") manifests.push(absolute);
    }
  };
  visit(directory);
  return manifests.sort();
}

const packages: PackageRecord[] = packageManifests(rootRealPath).map((manifestPath) => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    vibestudio?: {
      authority?: unknown;
      kind?: unknown;
      durable?: { classes?: DurableClassDeclaration[] };
    };
  };
  const directory = path.dirname(manifestPath);
  const relativePackagePath = path.relative(rootRealPath, path.dirname(manifestPath));
  const label = `${relativePackagePath || "."}/package.json`;
  const pathKind = relativePackagePath.split("/", 1)[0];
  const kind = (["apps", "panels", "workers", "extensions"] as const).includes(
    pathKind as "apps" | "panels" | "workers" | "extensions"
  )
    ? ({ apps: "app", panels: "panel", workers: "worker", extensions: "extension" } as const)[
        pathKind as "apps" | "panels" | "workers" | "extensions"
      ]
    : undefined;
  return {
    directory,
    label,
    provider: relativePackagePath || ".",
    ...(kind ? { kind } : {}),
    ...(manifest.vibestudio?.authority === undefined
      ? {}
      : { authority: parseUnitAuthorityManifest(manifest.vibestudio.authority, label) }),
    classes: Array.isArray(manifest.vibestudio?.durable?.classes)
      ? manifest.vibestudio.durable.classes
      : [],
  };
});

const config = parseYaml(
  fs.readFileSync(path.join(rootRealPath, "meta", "vibestudio.yml"), "utf8")
) as {
  services?: Array<{
    name: string;
    title?: string;
    action?: string;
    description?: string;
    presentation?: { domain: string; verb: string };
    notability?: "headline" | "everyday";
    source?: string;
  }>;
};
const describeCapability = createCapabilityPresentationResolver(
  () => config.services ?? [],
  () =>
    packages.flatMap((entry) =>
      (entry.authority?.provides ?? []).map((definition) => ({
        provider: entry.provider,
        definition,
      }))
    )
);

let reviewedManifestCount = 0;
for (const entry of packages) {
  if (!entry.authority) continue;
  summarizeAuthorityManifest(entry.authority, { requests: [], provides: [] }, describeCapability);
  reviewedManifestCount += 1;
}

let packageCount = 0;
let methodCount = 0;
for (const entry of packages) {
  if (entry.classes.length === 0) continue;
  if (!entry.authority) throw new Error(`${entry.label} durable package has no authority manifest`);
  const rpcSchemas: Record<string, ServiceMethodSchemas> = {};

  for (const declaration of entry.classes) {
    if (typeof declaration.className !== "string" || declaration.className.length === 0) {
      throw new Error(`${entry.label} has a durable class without a className`);
    }
    if (declaration.rpcSchema === undefined) continue;
    if (typeof declaration.rpcSchema !== "string" || declaration.rpcSchema.length === 0) {
      throw new Error(
        `${entry.label} durable class ${declaration.className} has an invalid rpcSchema`
      );
    }
    const schema = workspaceRpcSchema(declaration.rpcSchema);
    if (!schema) {
      throw new Error(
        `${entry.label} durable class ${declaration.className} binds unknown RPC schema ${declaration.rpcSchema}`
      );
    }
    rpcSchemas[declaration.className] = schema;
  }

  const catalog = await collectWorkspaceRpcCatalog(entry.directory, {
    provider: entry.provider,
    authority: entry.authority,
    rpcSchemas,
  });
  packageCount += 1;
  methodCount += catalog.length;
}

console.log(
  `Validated ${reviewedManifestCount} authority presentations and ${methodCount} RPC methods across ${packageCount} exact Base Durable Object packages.`
);
