import * as fs from "fs";
import * as path from "path";
import type { DetectedProfile } from "../types.js";

/**
 * Parse Firefox profiles.ini to enumerate profiles.
 *
 * The profiles.ini file contains sections like:
 *   [Profile0]
 *   Name=default-release
 *   IsRelative=1
 *   Path=xxxxxxxx.default-release
 *   Default=1
 *
 * For Firefox family browsers, the profiles.ini is in the parent of the Profiles dir
 * on macOS/Windows, or directly in the data dir on Linux.
 */
export function detectFirefoxProfiles(dataDir: string): DetectedProfile[] {
  // profiles.ini could be in dataDir itself (Linux) or its parent (macOS/Windows Profiles dir)
  let iniPath = path.join(dataDir, "profiles.ini");
  let baseDir = dataDir;

  if (!fs.existsSync(iniPath)) {
    // Try parent directory (macOS/Windows: dataDir is .../Profiles/)
    const parentDir = path.dirname(dataDir);
    const parentIni = path.join(parentDir, "profiles.ini");
    if (fs.existsSync(parentIni)) {
      iniPath = parentIni;
      baseDir = parentDir;
    } else {
      return [];
    }
  }

  const content = fs.readFileSync(iniPath, "utf-8");
  return parseProfilesIni(content, baseDir);
}

interface IniSection {
  [key: string]: string;
}

function parseProfilesIni(content: string, baseDir: string): DetectedProfile[] {
  const sections = new Map<string, IniSection>();
  let currentSection: string | null = null;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;

    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1]!;
      sections.set(currentSection, {});
      continue;
    }

    if (currentSection) {
      const eqIdx = line.indexOf("=");
      if (eqIdx !== -1) {
        const key = line.slice(0, eqIdx).trim();
        const value = line.slice(eqIdx + 1).trim();
        sections.get(currentSection)![key] = value;
      }
    }
  }

  // Also parse installs.ini for default profile hints
  const installDefaults = new Set<string>();
  const installsIniPath = path.join(baseDir, "installs.ini");
  if (fs.existsSync(installsIniPath)) {
    const installsContent = fs.readFileSync(installsIniPath, "utf-8");
    for (const rawLine of installsContent.split("\n")) {
      const line = rawLine.trim();
      if (line.startsWith("Default=")) {
        installDefaults.add(line.slice("Default=".length).trim());
      }
    }
  }

  const profiles: DetectedProfile[] = [];

  for (const [sectionName, section] of sections) {
    if (!sectionName.startsWith("Profile")) continue;

    const name = section["Name"];
    const profilePath = section["Path"];
    if (!name || !profilePath) continue;

    const isRelative = section["IsRelative"] === "1";
    const fullPath = isRelative ? path.join(baseDir, profilePath) : profilePath;

    if (!fs.existsSync(fullPath)) continue;

    // `installs.ini` records the profile this installation actually launches and
    // supersedes the legacy `Default=1` flag in profiles.ini. Honouring both at
    // once marked two profiles default, which made an abandoned profile claim it
    // would reopen on launch.
    const isDefault =
      installDefaults.size > 0 ? installDefaults.has(profilePath) : section["Default"] === "1";

    profiles.push({
      id: profilePath,
      displayName: name,
      path: fullPath,
      isDefault,
    });
  }

  // If no profile is marked default, mark the first one
  if (profiles.length > 0 && !profiles.some((p) => p.isDefault)) {
    profiles[0]!.isDefault = true;
  }

  return profiles;
}
