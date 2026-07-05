#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const sourceDir = path.join(repoRoot, "build-resources", "brand", "source");
const defaultLightSource = path.join(sourceDir, "vibestudio-light.png");
const defaultDarkSource = path.join(sourceDir, "vibestudio-dark.png");

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg?.startsWith("--")) {
    const key = arg.slice(2);
    const value = process.argv[i + 1]?.startsWith("--") ? "true" : process.argv[++i];
    args.set(key, value ?? "true");
  }
}

const lightInput = path.resolve(args.get("light") ?? defaultLightSource);
const darkInput = path.resolve(args.get("dark") ?? defaultDarkSource);
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

function convert(args) {
  run("convert", args);
}

function convertOut(args) {
  return run("convert", args, { capture: true }).trim();
}

function cropToLogoSquare(input, output) {
  const trim = convertOut([input, "-fuzz", "5%", "-trim", "-format", "%w %h %X %Y", "info:"]);
  const match = trim.match(/^(\d+)\s+(\d+)\s+([+-]\d+)\s+([+-]\d+)$/);
  if (!match) {
    throw new Error(`Could not detect trim bounds for ${input}: ${trim}`);
  }
  const [, wRaw, hRaw, xRaw, yRaw] = match;
  const w = Number(wRaw);
  const h = Number(hRaw);
  const x = Number(xRaw);
  const y = Number(yRaw);
  const sourceSize = Number(convertOut([input, "-format", "%w", "info:"]));
  const max = Math.max(w, h);
  const side = Math.min(sourceSize, Math.ceil(max * 1.17));
  const cx = x + w / 2;
  const cy = y + h / 2;
  const left = Math.max(0, Math.min(sourceSize - side, Math.round(cx - side / 2)));
  const top = Math.max(0, Math.min(sourceSize - side, Math.round(cy - side / 2)));
  convert([input, "-crop", `${side}x${side}+${left}+${top}`, "+repage", "-strip", output]);
}

function resizePng(input, output, size, extra = []) {
  ensureDir(path.dirname(output));
  convert([input, "-resize", `${size}x${size}`, ...extra, "-strip", "PNG32:" + output]);
}

function resizeOpaquePng(input, output, size, extra = []) {
  ensureDir(path.dirname(output));
  convert([
    input,
    "-resize",
    `${size}x${size}`,
    ...extra,
    "-background",
    topLeftPixel(input),
    "-alpha",
    "remove",
    "-alpha",
    "off",
    "-strip",
    "PNG24:" + output,
  ]);
}

function optimizePng(file) {
  try {
    run("pngquant", ["--force", "--skip-if-larger", "--ext", ".png", "256", file]);
  } catch {
    // pngquant is an optional optimizer. Keep ImageMagick output when it fails.
  }
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
    Buffer.concat([header, ...buffers.flatMap((b) => [b.directory]), ...buffers.map((b) => b.data)])
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

function brandMarkSvg(stroke = "currentColor") {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 904 904" fill="none">
  <path d="M116 805H788" stroke="${stroke}" stroke-width="32" stroke-linecap="round"/>
  <path d="M496 805V350L204 536" stroke="${stroke}" stroke-width="32" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M155 608L496 392" stroke="${stroke}" stroke-width="32" stroke-linecap="round"/>
  <path d="M280 238L414 372L179 519" stroke="${stroke}" stroke-width="32" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M302 184L430 312" stroke="${stroke}" stroke-width="32" stroke-linecap="round"/>
  <path d="M338 88L510 278" stroke="${stroke}" stroke-width="32" stroke-linecap="round"/>
  <path d="M265 127L291 153" stroke="${stroke}" stroke-width="32" stroke-linecap="round"/>
  <path d="M496 278L557 180C592 123 552 80 507 87C470 93 450 121 450 165V236" stroke="${stroke}" stroke-width="32" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M525 355L616 222C653 168 728 189 737 238C743 274 724 295 690 303L538 342L633 437" stroke="${stroke}" stroke-width="32" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M554 578V431L709 579V394" stroke="${stroke}" stroke-width="32" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;
}

function brandTileSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 904 904" fill="none">
  <rect width="904" height="904" fill="#0A0B0C"/>
  <g opacity="0.98">
${brandMarkSvg("#F8FAFC")
  .split("\n")
  .slice(1, -2)
  .map((line) => `    ${line}`)
  .join("\n")}
  </g>
</svg>
`;
}

function topLeftPixel(input) {
  return convertOut([input, "-format", "%[pixel:p{0,0}]", "info:"]);
}

function transparentMark(input, output, size) {
  const background = topLeftPixel(input);
  ensureDir(path.dirname(output));
  convert([
    input,
    "-alpha",
    "set",
    "-fuzz",
    "8%",
    "-transparent",
    background,
    "-resize",
    `${size}x${size}`,
    "-strip",
    "PNG32:" + output,
  ]);
  optimizePng(output);
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

if (!fs.existsSync(lightInput) || !fs.existsSync(darkInput)) {
  throw new Error(`Missing brand source(s): ${lightInput}, ${darkInput}`);
}

ensureDir(sourceDir);
if (shouldUpdateSource) {
  cropToLogoSquare(lightInput, defaultLightSource);
  cropToLogoSquare(darkInput, defaultDarkSource);
}

const lightSource = defaultLightSource;
const darkSource = defaultDarkSource;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-brand-"));

try {
  const brandDir = path.join(repoRoot, "build-resources", "brand");
  const linuxDir = path.join(repoRoot, "build-resources", "icons");
  const workspaceBrandAssetsPackageDir = path.join(
    repoRoot,
    "workspace",
    "packages",
    "brand-assets",
    "src"
  );
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
    workspaceBrandAssetsPackageDir,
    mobileWorkspaceAssets,
    mobileHostAssets,
    iosIconDir,
    iosLaunchLogoDir,
  ]) {
    ensureDir(dir);
  }

  fs.copyFileSync(lightSource, path.join(brandDir, "vibestudio-light.png"));
  fs.copyFileSync(darkSource, path.join(brandDir, "vibestudio-dark.png"));
  resizeOpaquePng(lightSource, path.join(brandDir, "vibestudio-light-512.png"), 512);
  resizeOpaquePng(darkSource, path.join(brandDir, "vibestudio-dark-512.png"), 512);
  resizeOpaquePng(darkSource, path.join(brandDir, "vibestudio-icon-1024.png"), 1024);
  resizeOpaquePng(darkSource, path.join(brandDir, "vibestudio-icon-512.png"), 512);
  transparentMark(lightSource, path.join(brandDir, "vibestudio-mark-on-light.png"), 1024);
  transparentMark(darkSource, path.join(brandDir, "vibestudio-mark-on-dark.png"), 1024);
  transparentMark(lightSource, path.join(brandDir, "vibestudio-mark-on-light-512.png"), 512);
  transparentMark(darkSource, path.join(brandDir, "vibestudio-mark-on-dark-512.png"), 512);
  writeText(path.join(brandDir, "vibestudio-mark.svg"), brandMarkSvg());
  writeText(path.join(brandDir, "vibestudio-mark-black.svg"), brandMarkSvg("#050506"));
  writeText(path.join(brandDir, "vibestudio-mark-white.svg"), brandMarkSvg("#F8FAFC"));
  writeText(path.join(brandDir, "favicon.svg"), brandTileSvg());

  for (const size of [16, 32, 48, 64, 128, 180, 192, 256, 512]) {
    resizeOpaquePng(darkSource, path.join(brandDir, `favicon-${size}.png`), size);
  }

  const icoEntries = [];
  for (const size of [16, 24, 32, 48, 64, 128, 256]) {
    const file = path.join(tmp, `ico-${size}.png`);
    resizeOpaquePng(darkSource, file, size);
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
    resizeOpaquePng(darkSource, file, size);
    icnsEntries.push({ type, file });
  }
  writeIcns(icnsEntries, path.join(repoRoot, "build-resources", "icon.icns"));

  for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
    resizeOpaquePng(darkSource, path.join(linuxDir, `${size}x${size}.png`), size);
  }

  resizeOpaquePng(lightSource, path.join(workspaceBrandAssetsPackageDir, "vibestudio-light.png"), 512);
  resizeOpaquePng(darkSource, path.join(workspaceBrandAssetsPackageDir, "vibestudio-dark.png"), 512);
  transparentMark(
    lightSource,
    path.join(workspaceBrandAssetsPackageDir, "vibestudio-mark-on-light.png"),
    512
  );
  transparentMark(
    darkSource,
    path.join(workspaceBrandAssetsPackageDir, "vibestudio-mark-on-dark.png"),
    512
  );
  writeText(path.join(workspaceBrandAssetsPackageDir, "vibestudio-mark.svg"), brandMarkSvg());
  writeText(
    path.join(workspaceBrandAssetsPackageDir, "vibestudio-mark-black.svg"),
    brandMarkSvg("#050506")
  );
  writeText(
    path.join(workspaceBrandAssetsPackageDir, "vibestudio-mark-white.svg"),
    brandMarkSvg("#F8FAFC")
  );
  writeText(path.join(workspaceBrandAssetsPackageDir, "favicon.svg"), brandTileSvg());

  for (const dir of [mobileWorkspaceAssets, mobileHostAssets]) {
    resizeOpaquePng(lightSource, path.join(dir, "vibestudio-light.png"), 512);
    resizeOpaquePng(darkSource, path.join(dir, "vibestudio-dark.png"), 512);
    transparentMark(lightSource, path.join(dir, "vibestudio-mark-on-light.png"), 512);
    transparentMark(darkSource, path.join(dir, "vibestudio-mark-on-dark.png"), 512);
  }

  const androidSizes = new Map([
    ["mipmap-mdpi", 48],
    ["mipmap-hdpi", 72],
    ["mipmap-xhdpi", 96],
    ["mipmap-xxhdpi", 144],
    ["mipmap-xxxhdpi", 192],
  ]);
  for (const [dir, size] of androidSizes) {
    resizeOpaquePng(darkSource, path.join(androidRes, dir, "ic_launcher.png"), size);
    resizeOpaquePng(darkSource, path.join(androidRes, dir, "ic_launcher_round.png"), size);
  }
  resizePng(
    path.join(brandDir, "vibestudio-mark-on-dark.png"),
    path.join(androidRes, "drawable", "splash_logo.png"),
    192
  );
  writeText(
    path.join(androidRes, "drawable", "launch_screen.xml"),
    `<?xml version="1.0" encoding="utf-8"?>\n<layer-list xmlns:android="http://schemas.android.com/apk/res/android">\n    <item android:drawable="@color/vibestudio_splash_background" />\n    <item>\n        <bitmap\n            android:gravity="center"\n            android:src="@drawable/splash_logo" />\n    </item>\n</layer-list>\n`
  );
  writeText(
    path.join(androidRes, "values", "colors.xml"),
    `<resources>\n    <color name="vibestudio_splash_background">#0A0B0C</color>\n</resources>\n`
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
    resizeOpaquePng(darkSource, path.join(iosIconDir, filename), size);
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

  resizePng(
    path.join(brandDir, "vibestudio-mark-on-dark.png"),
    path.join(iosLaunchLogoDir, "launch-logo.png"),
    96
  );
  resizePng(
    path.join(brandDir, "vibestudio-mark-on-dark.png"),
    path.join(iosLaunchLogoDir, "launch-logo@2x.png"),
    192
  );
  resizePng(
    path.join(brandDir, "vibestudio-mark-on-dark.png"),
    path.join(iosLaunchLogoDir, "launch-logo@3x.png"),
    288
  );
  writeJson(path.join(iosLaunchLogoDir, "Contents.json"), imageSetContents());

  convert([
    "-size",
    "660x420",
    "gradient:#111315-#050506",
    "(",
    darkSource,
    "-resize",
    "132x132",
    ")",
    "-gravity",
    "center",
    "-geometry",
    "+0-44",
    "-composite",
    "-gravity",
    "center",
    "-fill",
    "#f6f6f4",
    "-font",
    "DejaVu-Sans-Bold",
    "-pointsize",
    "28",
    "-annotate",
    "+0+74",
    "Vibestudio",
    "-fill",
    "#a8adb3",
    "-font",
    "DejaVu-Sans",
    "-pointsize",
    "13",
    "-annotate",
    "+0+102",
    "Agentic panel workspace",
    "-strip",
    "PNG24:" + path.join(repoRoot, "build-resources", "dmg-background.png"),
  ]);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("Generated Vibestudio brand assets.");
