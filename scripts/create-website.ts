import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const value = (name: string) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const destination = value("--out-dir");
if (!destination) throw new Error("Usage: pnpm create:website --out-dir PATH [--sdk-dir PATH] [--name NAME]");
const target = path.resolve(destination);
const sdk = path.resolve(value("--sdk-dir") ?? path.join(root, "dist/website-runtime"));
const name = value("--name") ?? "workspace-enabled-website";
if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error("Website name must be lowercase letters, numbers and hyphens");
const manifest = JSON.parse(fs.readFileSync(path.join(sdk, "package.json"), "utf8"));
if (manifest.name !== "@vibestudio/runtime" || !/^0\.1\.0-website\.[a-f0-9]{16}$/.test(manifest.version))
  throw new Error("Build the standalone shared SDK with pnpm build:website-runtime first");
if (fs.existsSync(target)) throw new Error("Choose a new output directory; an existing project is never overwritten");
fs.mkdirSync(target, { recursive: true });
fs.cpSync(path.join(root, "resources/website-scaffold"), target, { recursive: true });
const vendor = path.join(target, "vendor");
fs.mkdirSync(vendor);
const packed = JSON.parse(execFileSync("npm", ["pack", sdk, "--pack-destination", vendor, "--json", "--ignore-scripts"], { encoding: "utf8" }));
const tarball = packed[0].filename as string;
if (path.basename(tarball) !== tarball) throw new Error("Invalid package artifact filename");
const sha256 = createHash("sha256").update(fs.readFileSync(path.join(vendor, tarball))).digest("hex");
const installedVersion = (dependency: string) => JSON.parse(fs.readFileSync(path.join(root, "node_modules", dependency, "package.json"), "utf8")).version as string;
fs.writeFileSync(path.join(target, "package.json"), JSON.stringify({ name, version: "0.1.0", private: true, type: "module",
  scripts: { build: "node build.mjs" },
  vibestudio: { displayName: name, entry: "index.tsx" },
  dependencies: { "@workspace/runtime": `file:vendor/${tarball}`, react: installedVersion("react"), "react-dom": installedVersion("react-dom") },
  devDependencies: { esbuild: installedVersion("esbuild") },
}, null, 2) + "\n");
fs.writeFileSync(path.join(target, "sdk.json"), JSON.stringify({ name: manifest.name, version: manifest.version, artifact: `vendor/${tarball}`, sha256 }, null, 2) + "\n");
fs.writeFileSync(path.join(target, ".gitignore"), "node_modules/\n");
execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: target, stdio: "inherit" });
console.log(JSON.stringify({ directory: target, sdkVersion: manifest.version, sdkSha256: sha256, build: "npm ci && npm run build" }));
