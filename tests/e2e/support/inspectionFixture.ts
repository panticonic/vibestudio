import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

/** Install an explicitly inspection-capable caller in a projected Base source.
 * Production chat panels do not have cross-panel inspection authority. This
 * fixture is reviewed normally; it does not bypass the authority system.
 */
export function configureInspectionFixture(sourceRoot: string): void {
  const manifestPath = path.join(sourceRoot, "panels/chat/package.json");
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
  config.initPanels = [{ source: "panels/chat" }];
  fs.writeFileSync(configPath, YAML.stringify(config));
}
