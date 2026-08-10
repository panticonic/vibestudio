/**
 * Materialize the curated unit-icon catalog into the units that use it.
 *
 * The catalog is deliberately small. Lucide supplies semantic symbols; Simple
 * Icons supplies only truthful brand marks. Each unit receives one tiny local
 * SVG so builds never ship a sprite, an icon runtime, or a network dependency.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogRoot = path.join(root, "workspace/skills/workspace-dev/assets/icons");
const check = process.argv.includes("--check");

const semantic = (name, color) => ({ library: "lucide", name, color });
const brand = (name, color) => ({ library: "brands", name, color });

export const UNIT_ICONS = {
  "about/about": semantic("info", "#3B82F6"),
  "about/adblock": semantic("shield-ban", "#F59E0B"),
  "about/bookmarks": semantic("bookmark", "#8B5CF6"),
  "about/browser-import-inspector": semantic("luggage", "#06B6D4"),
  "about/collection": semantic("library", "#8B5CF6"),
  "about/credentials": semantic("key-round", "#F59E0B"),
  "about/downloads": semantic("download", "#3B82F6"),
  "about/help": semantic("circle-help", "#06B6D4"),
  "about/history": semantic("history", "#64748B"),
  "about/keyboard-shortcuts": semantic("keyboard", "#8B5CF6"),
  "about/new": semantic("square-plus", "#10B981"),
  "about/permissions": semantic("shield-check", "#10B981"),
  "about/server-logs": semantic("scroll-text", "#64748B"),
  "about/templates": semantic("layout-template", "#8B5CF6"),

  "panels/chat": semantic("messages-square", "#8B5CF6"),
  "panels/development": semantic("code-xml", "#3B82F6"),
  "panels/gad-browser": semantic("history", "#06B6D4"),
  "panels/hello-svelte": brand("svelte", "#FF3E00"),
  "panels/hello-vanilla": brand("javascript", "#F7DF1E"),
  "panels/local-models": semantic("cpu", "#8B5CF6"),
  "panels/news": semantic("newspaper", "#3B82F6"),
  "panels/spectrolite": semantic("sparkles", "#D946EF"),
  "panels/terminal": semantic("square-terminal", "#10B981"),
  "panels/testbench": semantic("flask-conical", "#F43F5E"),

  "workers/agent-worker": semantic("bot-message-square", "#8B5CF6"),
  "workers/explorer-agent": semantic("compass", "#06B6D4"),
  "workers/gmail-agent": brand("gmail", "#EA4335"),
  "workers/hello": semantic("hand", "#F59E0B"),
  "workers/linked-agent": semantic("link", "#3B82F6"),
  "workers/model-settings": semantic("sliders-horizontal", "#8B5CF6"),
  "workers/news-agent": semantic("newspaper", "#3B82F6"),
  "workers/pubsub-channel": semantic("radio-tower", "#06B6D4"),
  "workers/sample-do": semantic("database", "#F59E0B"),
  "workers/silent-agent-worker": semantic("volume-x", "#64748B"),
  "workers/system-agent": semantic("sparkles", "#D946EF"),
  "workers/system-test-runner": semantic("badge-check", "#10B981"),
  "workers/terminal-chat": semantic("square-terminal", "#10B981"),
  "workers/test-agent": semantic("flask-conical", "#F43F5E"),
  "workers/testkit-driver": semantic("plug", "#F59E0B"),
  "workers/workspace-source": semantic("folder-git-2", "#F05032"),

  "apps/remote-cli": semantic("square-terminal", "#10B981"),
  "apps/terminal-browser": semantic("panels-top-left", "#3B82F6"),

  "extensions/browser-data": semantic("database", "#3B82F6"),
  "extensions/claude-code": brand("claude", "#D97757"),
  "extensions/file-tools": semantic("folder-cog", "#F59E0B"),
  "extensions/git-bridge": brand("git", "#F05032"),
  "extensions/image-service": semantic("images", "#D946EF"),
  "extensions/local-models": semantic("cpu", "#8B5CF6"),
  "extensions/mobile-debug": semantic("bug", "#F43F5E"),
  "extensions/pdf-ingest": semantic("file-text", "#EF4444"),
  "extensions/shell": brand("gnubash", "#4EAA25"),
  "extensions/template-composer": semantic("layout-template", "#8B5CF6"),
  "extensions/test-runner": semantic("badge-check", "#10B981"),
  "extensions/typecheck-service": brand("typescript", "#3178C6"),
};

function renderedSvg(icon) {
  const sourcePath = path.join(catalogRoot, icon.library, `${icon.name}.svg`);
  let svg = fs.readFileSync(sourcePath, "utf8");
  if (icon.library === "lucide") return svg.replaceAll("currentColor", icon.color);
  return `<!-- Source: Simple Icons 16.27.1 (CC0 collection); brand rights remain with their owners. -->\n${svg.replace("<svg ", `<svg fill="${icon.color}" `)}`;
}

function updateFile(file, expected, stale) {
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  if (current === expected) return;
  stale.push(path.relative(root, file));
  if (!check) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, expected);
  }
}

const stale = [];
for (const [unit, icon] of Object.entries(UNIT_ICONS)) {
  const unitDir = path.join(root, "workspace", unit);
  updateFile(path.join(unitDir, "assets/icon.svg"), renderedSvg(icon), stale);

  const manifestPath = path.join(unitDir, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.vibestudio.icon = "./assets/icon.svg";
  updateFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, stale);
}

if (stale.length === 0) {
  console.log(`Unit icon catalog is current (${Object.keys(UNIT_ICONS).length} units).`);
} else if (check) {
  console.error(`Unit icon catalog is stale:\n${stale.map((file) => `  - ${file}`).join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`Updated ${stale.length} unit icon file(s).`);
}
