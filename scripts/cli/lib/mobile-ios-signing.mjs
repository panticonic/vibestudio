import fs from "node:fs";
import path from "node:path";

export function readIosSigningConfig(iosDir, env = process.env) {
  const file = path.join(iosDir, "Signing.local.xcconfig");
  const exists = fs.existsSync(file);
  const values = {};
  if (exists) {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = /^\s*([A-Za-z0-9_.$()[\]-]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (match) values[match[1]] = match[2];
    }
  }
  const first = (...entries) =>
    entries.find((value) => typeof value === "string" && value.trim()) ?? "";
  return {
    exists,
    teamId: first(
      env.VIBESTUDIO_IOS_TEAM_ID,
      values.VIBESTUDIO_IOS_TEAM_ID,
      values.DEVELOPMENT_TEAM
    ),
    bundleId:
      first(
        env.VIBESTUDIO_IOS_BUNDLE_ID,
        values.VIBESTUDIO_IOS_BUNDLE_ID,
        values.PRODUCT_BUNDLE_IDENTIFIER
      ) || "app.vibestudio.mobile",
    apsEnvironment: first(env.VIBESTUDIO_IOS_APS_ENV, values.VIBESTUDIO_IOS_APS_ENV),
  };
}
