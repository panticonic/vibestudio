import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import YAML from "yaml";
import {
  mergeTemplateManifests,
  templateRepositoryOwners,
} from "@vibestudio/workspace/templateManifestMerge";
import { parseTemplateManifestContent } from "@vibestudio/workspace/templateManifest";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";

export interface DevelopmentTemplateComposition {
  root: string;
  release(): void;
}

/**
 * Compose canonical template checkouts for development tooling exactly as an
 * installed workspace is composed: dependencies first, dependent last.
 * Source remains in its owning checkout; this temporary materialization is
 * discarded with the tool process.
 */
export function composeDevelopmentTemplateCheckouts(
  sources: readonly { checkout: string; url: string }[]
): DevelopmentTemplateComposition {
  if (sources.length === 0) throw new Error("Template composition needs at least one checkout");
  const roots = sources.map(({ checkout }) => fs.realpathSync(path.resolve(checkout)));
  const layers = roots.map((root, index) => ({
    label: sources[index]!.url,
    manifest: parseTemplateManifestContent(
      fs.readFileSync(path.join(root, "meta", "vibestudio.yml"), "utf8"),
      WORKSPACE_SYSTEM_EPOCH
    ),
  }));
  const merged = mergeTemplateManifests(layers);
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-template-composition-"));
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    fs.rmSync(target, { recursive: true, force: true });
  };
  try {
    const owners = templateRepositoryOwners(layers);
    for (let index = 0; index < layers.length; index += 1) {
      const { manifest } = layers[index]!;
      const root = roots[index]!;
      for (const relative of [
        ...manifest.inventory.repositories.filter((entry) => entry !== "meta"),
      ]) {
        if (owners.get(relative)?.label !== layers[index]!.label) continue;
        const destination = path.join(target, relative);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.cpSync(path.join(root, relative), destination, { recursive: true });
      }
    }
    const meta = path.join(target, "meta");
    fs.mkdirSync(meta, { recursive: true });
    fs.writeFileSync(path.join(meta, "vibestudio.yml"), YAML.stringify(merged.document));
    return { root: target, release };
  } catch (error) {
    release();
    throw error;
  }
}
