import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { excludedNativePackages, packageDesktop } from "./package-desktop.mjs";
import { getNodeModuleFileMatcher } from "app-builder-lib/out/fileMatcher.js";

const roots = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-package-test-"));
  roots.push(root);
  for (const [name, cpu] of [
    ["workerd-linux-64", "x64"],
    ["workerd-linux-arm64", "arm64"],
  ]) {
    const dir = path.join(root, "node_modules/@cloudflare", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: `@cloudflare/${name}`, os: ["linux"], cpu: [cpu] })
    );
  }
  fs.writeFileSync(
    path.join(root, "electron-builder.yml"),
    `directories:\n  output: release\nfiles: ["dist/**/*", "node_modules/**/*"]\nlinux:\n  target:\n    - target: deb\n      arch: [x64, arm64]\n`
  );
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test("selects one native architecture using the packager's real file matcher", () => {
  const root = fixture();
  const names = excludedNativePackages(root, "linux", "x64");
  assert.deepEqual(names, ["@cloudflare/workerd-linux-arm64"]);
  const files = names.map((name) => `!node_modules/${name}{,/**/*}`);
  const matcher = getNodeModuleFileMatcher(
    root,
    "/out",
    (value) => value,
    {},
    { config: { files }, debugLogger: { isEnabled: false } }
  );
  const filter = matcher.createFilter();
  for (const [name, kept] of [
    ["workerd-linux-64", true],
    ["workerd-linux-arm64", false],
  ]) {
    const file = path.join(root, "node_modules/@cloudflare", name, "package.json");
    assert.equal(filter(file, fs.statSync(file)), kept);
  }
});

test("selects the glibc runtime required by desktop Linux", () => {
  const root = fixture();
  for (const libc of ["glibc", "musl"]) {
    const name = `@native/runtime-${libc}`;
    const directory = path.join(root, "node_modules", name);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, "package.json"),
      JSON.stringify({ name, os: ["linux"], cpu: ["x64"], libc: [libc] })
    );
  }
  const excluded = excludedNativePackages(root, "linux", "x64");
  assert.ok(excluded.includes("@native/runtime-musl"));
  assert.ok(!excluded.includes("@native/runtime-glibc"));
});

test("promotes final installers and retires each joined staging tree", async () => {
  const root = fixture();
  const seen = [];
  const outputs = await packageDesktop("linux", {
    appRoot: root,
    runBuild: async ({ config: configPath, targets }) => {
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      const arch = [...targets.values()][0].keys().next().value;
      seen.push(config.files.filter((file) => file.startsWith("!")));
      fs.mkdirSync(path.join(config.directories.output, "linux-unpacked"));
      const installer = path.join(config.directories.output, `installer-${arch}.deb`);
      fs.writeFileSync(installer, "verified final artifact");
      return [installer];
    },
  });
  assert.equal(outputs.length, 2);
  assert.ok(seen[0][0].includes("arm64"));
  assert.ok(seen[1][0].includes("linux-64"));
  assert.deepEqual(fs.readdirSync(path.join(root, "release")).sort(), [
    "installer-1.deb",
    "installer-3.deb",
  ]);
});

test("retires failed packaging scratch while preserving inherited release products", async () => {
  const root = fixture();
  fs.mkdirSync(path.join(root, "release"));
  fs.writeFileSync(path.join(root, "release", "previous.deb"), "previous release");
  const failure = new Error("native packaging failed");
  await assert.rejects(
    packageDesktop("linux", {
      appRoot: root,
      runBuild: async () => {
        throw failure;
      },
    }),
    (error) => error === failure
  );
  assert.deepEqual(fs.readdirSync(path.join(root, "release")), ["previous.deb"]);
});
