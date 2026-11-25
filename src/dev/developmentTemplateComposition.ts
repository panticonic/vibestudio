import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import { Ownership } from "@vibestudio/shared/ownership";
import { getProfileDataPath } from "@vibestudio/env-paths";
import { removeSealedTree } from "@vibestudio/shared/removeSealedTree";
import {
  mergeTemplateManifests,
  templateRepositoryOwners,
} from "@vibestudio/workspace/templateManifestMerge";
import {
  parseTemplateManifestContent,
  templateRepositories,
} from "@vibestudio/workspace/templateManifest";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";

export interface DevelopmentTemplateComposition {
  root: string;
  ownership: Ownership;
  release(): Promise<void>;
}

/**
 * Compose canonical template checkouts for development tooling exactly as an
 * installed workspace is composed: dependencies first, dependent last.
 * Source remains in its owning checkout; this temporary materialization is
 * discarded with the tool process.
 */
export async function composeDevelopmentTemplateCheckouts(
  sources: readonly { checkout: string; url: string }[],
  options: { ownership?: Ownership; profileDir?: string; keep?: boolean } = {}
): Promise<DevelopmentTemplateComposition> {
  if (sources.length === 0) throw new Error("Template composition needs at least one checkout");
  const roots = sources.map(({ checkout }) => fs.realpathSync(path.resolve(checkout)));
  const layers = roots.map((root, index) => ({
    label: sources[index]!.url,
    repositories: templateRepositories(sourceFiles(root)),
    manifest: parseTemplateManifestContent(
      fs.readFileSync(path.join(root, "meta", "vibestudio.yml"), "utf8"),
      WORKSPACE_SYSTEM_EPOCH
    ),
  }));
  const merged = mergeTemplateManifests(layers);
  const ownership =
    options.ownership ??
    (await Ownership.open({
      profileDir: options.profileDir ?? getProfileDataPath(),
      lifetime: "leased",
      meta: { role: "template-composition" },
    }));
  const keep = options.keep ?? process.env["VIBESTUDIO_KEEP_SCRATCH"] === "1";
  let target: string | undefined;
  let released: Promise<void> | undefined;
  const release = (): Promise<void> =>
    (released ??= (async () => {
      // A private composition owner joins its compiler groups before paths. With
      // an existing operation owner, callers join consumers before release and
      // its reaper remains the crash/cancellation backstop.
      if (!options.ownership) await ownership.release();
      else if (target && !keep) removeSealedTree(target);
    })());
  try {
    if (keep) {
      const parent = path.join(ownership.profileDir, "kept-scratch");
      fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
      target = fs.mkdtempSync(path.join(parent, "vibestudio-template-composition-"));
    } else target = await ownership.scratch("vibestudio-template-composition-");
    const owners = templateRepositoryOwners(layers);
    for (let index = 0; index < layers.length; index += 1) {
      const { repositories } = layers[index]!;
      const root = roots[index]!;
      for (const relative of repositories.filter((entry) => entry !== "meta")) {
        if (owners.get(relative)?.label !== layers[index]!.label) continue;
        const destination = path.join(target, relative);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.cpSync(path.join(root, relative), destination, { recursive: true });
      }
    }
    const meta = path.join(target, "meta");
    fs.mkdirSync(meta, { recursive: true });
    fs.writeFileSync(path.join(meta, "vibestudio.yml"), YAML.stringify(merged.document));
    return { root: target, ownership, release };
  } catch (error) {
    try {
      await release();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Template composition and retirement failed",
        { cause: error }
      );
    }
    throw error;
  }
}

function sourceFiles(root: string, relative = ""): string[] {
  return fs.readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === ".git" || entry.name === "node_modules") return [];
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    return entry.isDirectory() ? sourceFiles(root, child) : [child];
  });
}
