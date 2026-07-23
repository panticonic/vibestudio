#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const sourceDir = path.join(repoRoot, "build-resources", "brand", "source");
const canonicalSources = {
  logo: path.join(sourceDir, "vibestudio-logo.svg"),
  symbol: path.join(sourceDir, "vibestudio-symbol.svg"),
};
const lightBackground = "#F7F1FF";
const darkBackground = "#100B18";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg?.startsWith("--")) {
    const key = arg.slice(2);
    const value = process.argv[i + 1]?.startsWith("--") ? "true" : process.argv[++i];
    args.set(key, value ?? "true");
  }
}

const suppliedSources = {
  logo: path.resolve(args.get("logo") ?? canonicalSources.logo),
  symbol: path.resolve(args.get("symbol") ?? canonicalSources.symbol),
};
const shouldUpdateSource = args.has("update-source");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function run(command, commandArgs, options = {}) {
  return execFileSync(command, commandArgs, {
    cwd: repoRoot,
    stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: options.capture ? "utf8" : undefined,
  });
}

function requireCommand(command) {
  try {
    run("which", [command], { capture: true });
  } catch {
    throw new Error(`Required command not found: ${command}`);
  }
}

function convert(commandArgs) {
  run("convert", commandArgs);
}

function writeIco(entries, output) {
  const headerSize = 6 + entries.length * 16;
  let offset = headerSize;
  const buffers = entries.map(({ size, file }) => {
    const data = fs.readFileSync(file);
    const directory = Buffer.alloc(16);
    directory.writeUInt8(size >= 256 ? 0 : size, 0);
    directory.writeUInt8(size >= 256 ? 0 : size, 1);
    directory.writeUInt8(0, 2);
    directory.writeUInt8(0, 3);
    directory.writeUInt16LE(1, 4);
    directory.writeUInt16LE(32, 6);
    directory.writeUInt32LE(data.length, 8);
    directory.writeUInt32LE(offset, 12);
    offset += data.length;
    return { directory, data };
  });
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  fs.writeFileSync(
    output,
    Buffer.concat([
      header,
      ...buffers.map(({ directory }) => directory),
      ...buffers.map(({ data }) => data),
    ])
  );
}

function writeIcns(entries, output) {
  const chunks = entries.map(({ type, file }) => {
    const data = fs.readFileSync(file);
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, "ascii");
    header.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([header, data]);
  });
  const totalLength = 8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const header = Buffer.alloc(8);
  header.write("icns", 0, 4, "ascii");
  header.writeUInt32BE(totalLength, 4);
  fs.writeFileSync(output, Buffer.concat([header, ...chunks]));
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

function writeText(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, value);
}

function validateVectorSource(file, name) {
  if (!fs.existsSync(file)) throw new Error(`Missing ${name} source: ${file}`);
  const svg = fs.readFileSync(file, "utf8");
  if (!/<svg\b/.test(svg) || !/<path\b/.test(svg)) {
    throw new Error(`${name} must be an SVG containing vector paths: ${file}`);
  }
  if (/<image\b|data:image/i.test(svg)) {
    throw new Error(`${name} embeds raster artwork; provide a true vector SVG: ${file}`);
  }
}

function renderSvg(input, output, width, height = width) {
  ensureDir(path.dirname(output));
  run("rsvg-convert", [
    "--width",
    String(width),
    "--height",
    String(height),
    "--output",
    output,
    input,
  ]);
}

let tempAssetIndex = 0;
function makeSymbolTile(output, size, background) {
  ensureDir(path.dirname(output));
  const layer = path.join(tmp, `symbol-${size}-${tempAssetIndex++}.png`);
  renderSvg(sources.symbol, layer, size);
  convert([
    "-size",
    `${size}x${size}`,
    `xc:${background}`,
    layer,
    "-gravity",
    "center",
    "-composite",
    "-strip",
    "PNG24:" + output,
  ]);
}

function symbolOnBackgroundSvg(input, background, radius = 220) {
  const source = fs.readFileSync(input, "utf8");
  const viewBox = source.match(/viewBox=["']([^"']+)["']/)?.[1];
  const contents = source.replace(/^\s*<svg\b[^>]*>\s*/, "").replace(/\s*<\/svg>\s*$/, "");
  if (!viewBox) throw new Error(`SVG is missing a viewBox: ${input}`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">\n  <rect width="1024" height="1024" rx="${radius}" fill="${background}"/>\n  <svg width="1024" height="1024" viewBox="${viewBox}">\n${contents}\n  </svg>\n</svg>\n`;
}

function imageSetContents() {
  return {
    images: [
      { idiom: "universal", scale: "1x", filename: "launch-logo.png" },
      { idiom: "universal", scale: "2x", filename: "launch-logo@2x.png" },
      { idiom: "universal", scale: "3x", filename: "launch-logo@3x.png" },
    ],
    info: { version: 1, author: "xcode" },
  };
}

requireCommand("convert");
requireCommand("rsvg-convert");
for (const [name, file] of Object.entries(suppliedSources)) validateVectorSource(file, name);

ensureDir(sourceDir);
if (shouldUpdateSource) {
  for (const [name, input] of Object.entries(suppliedSources)) {
    const destination = canonicalSources[name];
    if (input !== destination) fs.copyFileSync(input, destination);
  }
}

const sources = shouldUpdateSource ? canonicalSources : suppliedSources;
for (const rasterMaster of ["vibestudio-logo.png", "vibestudio-symbol.png"]) {
  fs.rmSync(path.join(sourceDir, rasterMaster), { force: true });
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-brand-"));

try {
  const brandDir = path.join(repoRoot, "build-resources", "brand");
  const linuxDir = path.join(repoRoot, "build-resources", "icons");
  const workspaceUiAssetsDir = path.join(repoRoot, "workspace", "packages", "ui", "src", "assets");
  const mobileWorkspaceAssets = path.join(repoRoot, "workspace", "apps", "mobile", "src", "assets");
  const mobileHostAssets = path.join(repoRoot, "apps", "mobile", "assets");
  const androidRes = path.join(repoRoot, "apps", "mobile", "android", "app", "src", "main", "res");
  const iosIconDir = path.join(
    repoRoot,
    "apps",
    "mobile",
    "ios",
    "Vibestudio",
    "Images.xcassets",
    "AppIcon.appiconset"
  );
  const iosLaunchLogoDir = path.join(
    repoRoot,
    "apps",
    "mobile",
    "ios",
    "Vibestudio",
    "Images.xcassets",
    "LaunchLogo.imageset"
  );

  for (const dir of [
    brandDir,
    linuxDir,
    workspaceUiAssetsDir,
    mobileWorkspaceAssets,
    mobileHostAssets,
    iosIconDir,
    iosLaunchLogoDir,
  ]) {
    ensureDir(dir);
  }

  for (const file of [
    "vibestudio-light.png",
    "vibestudio-light-512.png",
    "vibestudio-dark.png",
    "vibestudio-dark-512.png",
    "vibestudio-icon-1024.png",
    "vibestudio-icon-512.png",
    "vibestudio-mark.svg",
    "vibestudio-mark-black.svg",
    "vibestudio-mark-white.svg",
    "vibestudio-mark-on-light.png",
    "vibestudio-mark-on-light-512.png",
    "vibestudio-mark-on-dark.png",
    "vibestudio-mark-on-dark-512.png",
  ]) {
    fs.rmSync(path.join(brandDir, file), { force: true });
  }
  for (const dir of [workspaceUiAssetsDir, mobileWorkspaceAssets, mobileHostAssets]) {
    for (const file of [
      "vibestudio-light.png",
      "vibestudio-dark.png",
      "vibestudio-mark-on-light.png",
      "vibestudio-mark-on-dark.png",
    ]) {
      fs.rmSync(path.join(dir, file), { force: true });
    }
  }
  for (const file of [
    "vibestudio-logo.png",
    "vibestudio-symbol.png",
    "vibestudio-symbol-on-light.png",
    "vibestudio-symbol-on-dark.png",
  ]) {
    fs.rmSync(path.join(workspaceUiAssetsDir, file), { force: true });
  }

  fs.copyFileSync(sources.logo, path.join(brandDir, "vibestudio-logo.svg"));
  fs.copyFileSync(sources.symbol, path.join(brandDir, "vibestudio-symbol.svg"));
  fs.rmSync(path.join(brandDir, "vibestudio-symbol-small.svg"), { force: true });
  writeText(
    path.join(brandDir, "vibestudio-symbol-on-light.svg"),
    symbolOnBackgroundSvg(sources.symbol, lightBackground)
  );
  writeText(
    path.join(brandDir, "vibestudio-symbol-on-dark.svg"),
    symbolOnBackgroundSvg(sources.symbol, darkBackground)
  );
  writeText(
    path.join(brandDir, "favicon.svg"),
    symbolOnBackgroundSvg(sources.symbol, darkBackground)
  );

  renderSvg(sources.logo, path.join(brandDir, "vibestudio-logo.png"), 1024, 1536);
  renderSvg(sources.logo, path.join(brandDir, "vibestudio-logo-512.png"), 341, 512);
  renderSvg(sources.symbol, path.join(brandDir, "vibestudio-symbol.png"), 1024);
  renderSvg(sources.symbol, path.join(brandDir, "vibestudio-symbol-512.png"), 512);
  makeSymbolTile(path.join(brandDir, "vibestudio-symbol-on-light.png"), 1024, lightBackground);
  makeSymbolTile(path.join(brandDir, "vibestudio-symbol-on-dark.png"), 1024, darkBackground);
  makeSymbolTile(path.join(brandDir, "vibestudio-symbol-on-light-512.png"), 512, lightBackground);
  makeSymbolTile(path.join(brandDir, "vibestudio-symbol-on-dark-512.png"), 512, darkBackground);

  for (const size of [16, 24, 32, 48, 64, 128, 180, 192, 256, 512]) {
    makeSymbolTile(path.join(brandDir, `favicon-${size}.png`), size, darkBackground);
  }

  const icoEntries = [];
  for (const size of [16, 24, 32, 48, 64, 128, 256]) {
    const file = path.join(tmp, `ico-${size}.png`);
    makeSymbolTile(file, size, darkBackground);
    icoEntries.push({ size, file });
  }
  writeIco(icoEntries, path.join(repoRoot, "build-resources", "icon.ico"));
  writeIco(
    icoEntries.filter((entry) => [16, 32, 48, 64].includes(entry.size)),
    path.join(brandDir, "favicon.ico")
  );

  const icnsMap = [
    [16, "icp4"],
    [32, "icp5"],
    [64, "icp6"],
    [128, "ic07"],
    [256, "ic08"],
    [512, "ic09"],
    [1024, "ic10"],
  ];
  const icnsEntries = [];
  for (const [size, type] of icnsMap) {
    const file = path.join(tmp, `icns-${size}.png`);
    makeSymbolTile(file, size, darkBackground);
    icnsEntries.push({ type, file });
  }
  writeIcns(icnsEntries, path.join(repoRoot, "build-resources", "icon.icns"));

  for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
    makeSymbolTile(path.join(linuxDir, `${size}x${size}.png`), size, darkBackground);
  }

  fs.copyFileSync(sources.logo, path.join(workspaceUiAssetsDir, "vibestudio-logo.svg"));
  fs.copyFileSync(sources.symbol, path.join(workspaceUiAssetsDir, "vibestudio-symbol.svg"));
  fs.rmSync(path.join(workspaceUiAssetsDir, "vibestudio-symbol-small.svg"), { force: true });
  writeText(
    path.join(workspaceUiAssetsDir, "vibestudio-symbol-on-light.svg"),
    symbolOnBackgroundSvg(sources.symbol, lightBackground)
  );
  writeText(
    path.join(workspaceUiAssetsDir, "vibestudio-symbol-on-dark.svg"),
    symbolOnBackgroundSvg(sources.symbol, darkBackground)
  );
  for (const dir of [mobileWorkspaceAssets, mobileHostAssets]) {
    renderSvg(sources.logo, path.join(dir, "vibestudio-logo.png"), 341, 512);
    renderSvg(sources.symbol, path.join(dir, "vibestudio-symbol.png"), 512);
    makeSymbolTile(path.join(dir, "vibestudio-symbol-on-light.png"), 512, lightBackground);
    makeSymbolTile(path.join(dir, "vibestudio-symbol-on-dark.png"), 512, darkBackground);
  }

  const androidSizes = new Map([
    ["mipmap-mdpi", 48],
    ["mipmap-hdpi", 72],
    ["mipmap-xhdpi", 96],
    ["mipmap-xxhdpi", 144],
    ["mipmap-xxxhdpi", 192],
  ]);
  for (const [dir, size] of androidSizes) {
    makeSymbolTile(path.join(androidRes, dir, "ic_launcher.png"), size, darkBackground);
    makeSymbolTile(path.join(androidRes, dir, "ic_launcher_round.png"), size, darkBackground);
  }
  renderSvg(sources.symbol, path.join(androidRes, "drawable", "splash_logo.png"), 192);
  writeText(
    path.join(androidRes, "drawable", "launch_screen.xml"),
    `<?xml version="1.0" encoding="utf-8"?>\n<layer-list xmlns:android="http://schemas.android.com/apk/res/android">\n    <item android:drawable="@color/vibestudio_splash_background" />\n    <item>\n        <bitmap\n            android:gravity="center"\n            android:src="@drawable/splash_logo" />\n    </item>\n</layer-list>\n`
  );
  writeText(
    path.join(androidRes, "values", "colors.xml"),
    `<resources>\n    <color name="vibestudio_splash_background">${darkBackground}</color>\n</resources>\n`
  );

  const iosEntries = [
    ["iphone", "20x20", "2x", 40, "AppIcon-20x20@2x.png"],
    ["iphone", "20x20", "3x", 60, "AppIcon-20x20@3x.png"],
    ["iphone", "29x29", "2x", 58, "AppIcon-29x29@2x.png"],
    ["iphone", "29x29", "3x", 87, "AppIcon-29x29@3x.png"],
    ["iphone", "40x40", "2x", 80, "AppIcon-40x40@2x.png"],
    ["iphone", "40x40", "3x", 120, "AppIcon-40x40@3x.png"],
    ["iphone", "60x60", "2x", 120, "AppIcon-60x60@2x.png"],
    ["iphone", "60x60", "3x", 180, "AppIcon-60x60@3x.png"],
    ["ipad", "20x20", "1x", 20, "AppIcon-20x20@1x.png"],
    ["ipad", "20x20", "2x", 40, "AppIcon-20x20@2x.png"],
    ["ipad", "29x29", "1x", 29, "AppIcon-29x29@1x.png"],
    ["ipad", "29x29", "2x", 58, "AppIcon-29x29@2x.png"],
    ["ipad", "40x40", "1x", 40, "AppIcon-40x40@1x.png"],
    ["ipad", "40x40", "2x", 80, "AppIcon-40x40@2x.png"],
    ["ipad", "76x76", "1x", 76, "AppIcon-76x76@1x.png"],
    ["ipad", "76x76", "2x", 152, "AppIcon-76x76@2x.png"],
    ["ipad", "83.5x83.5", "2x", 167, "AppIcon-83_5x83_5@2x.png"],
    ["ios-marketing", "1024x1024", "1x", 1024, "AppIcon-1024x1024.png"],
  ];
  const writtenIosIcons = new Set();
  for (const [, , , size, filename] of iosEntries) {
    if (writtenIosIcons.has(filename)) continue;
    makeSymbolTile(path.join(iosIconDir, filename), size, darkBackground);
    writtenIosIcons.add(filename);
  }
  writeJson(path.join(iosIconDir, "Contents.json"), {
    images: iosEntries.map(([idiom, size, scale, , filename]) => ({
      idiom,
      size,
      scale,
      filename,
    })),
    info: { version: 1, author: "xcode" },
  });

  renderSvg(sources.symbol, path.join(iosLaunchLogoDir, "launch-logo.png"), 96);
  renderSvg(sources.symbol, path.join(iosLaunchLogoDir, "launch-logo@2x.png"), 192);
  renderSvg(sources.symbol, path.join(iosLaunchLogoDir, "launch-logo@3x.png"), 288);
  writeJson(path.join(iosLaunchLogoDir, "Contents.json"), imageSetContents());

  const dmgLogo = path.join(tmp, "dmg-logo.png");
  renderSvg(sources.logo, dmgLogo, 107, 160);
  convert([
    "-size",
    "660x420",
    `gradient:#21122F-${darkBackground}`,
    dmgLogo,
    "-gravity",
    "center",
    "-geometry",
    "+0-120",
    "-composite",
    "-fill",
    "#C7B9D8",
    "-font",
    "DejaVu-Sans",
    "-pointsize",
    "13",
    "-annotate",
    "+0+148",
    "Agentic panel workspace",
    "-strip",
    "PNG24:" + path.join(repoRoot, "build-resources", "dmg-background.png"),
  ]);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("Generated Vibestudio brand assets from true vector masters.");
