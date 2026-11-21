import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

/** Install an explicitly inspection-capable caller in a reviewed Base fixture.
 */
export function configureInspectionFixture(
  sourceRoot: string,
  panelSource: "panels/chat" | "about/new" = "panels/chat"
): void {
  const manifestPath = path.join(sourceRoot, panelSource, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.vibestudio.authority.requests.push({
    capability: "panel.inspect",
    resource: { kind: "prefix", prefix: "panel:tree/" },
    tier: "gated",
    evidence: "bounded-dynamic",
  });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const configPath = path.join(sourceRoot, "meta/vibestudio.yml");
  const config = YAML.parse(fs.readFileSync(configPath, "utf8"));
  config.initPanels = [{ source: panelSource }];
  fs.writeFileSync(configPath, YAML.stringify(config));
}
