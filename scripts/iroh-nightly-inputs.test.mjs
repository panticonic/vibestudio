import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Android nightly smoke uses its source-server producer entrypoint", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/iroh-e2e-nightly.yml"),
    "utf8"
  );
  const androidJob = workflow.slice(workflow.indexOf("  android-iroh-smoke:"));
  const scripts = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).scripts;

  assert.match(androidJob, /script: pnpm test:iroh-mobile-e2e/u);
  assert.doesNotMatch(androidJob, /pnpm build/u);
  assert.equal(
    scripts["test:iroh-mobile-e2e"],
    "pnpm build:infrastructure && node scripts/cli/mobile-smoke.mjs --platform android"
  );
  assert.doesNotMatch(scripts["test:iroh-mobile-e2e"], /pnpm build(?!:infrastructure)/u);
});

test("desktop nightly smoke installs its native keyring and display runtime", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/iroh-e2e-nightly.yml"),
    "utf8"
  );
  const action = fs.readFileSync(
    path.join(root, ".github/actions/setup-linux-source-runtime/action.yml"),
    "utf8"
  );
  const desktopJob = workflow.slice(
    workflow.indexOf("  iroh-remote-e2e:"),
    workflow.indexOf("  android-iroh-smoke:")
  );
  const androidJob = workflow.slice(workflow.indexOf("  android-iroh-smoke:"));
  const ci = fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  const qualityJob = ci.slice(ci.indexOf("  quality:"), ci.indexOf("  mac-portability:"));

  assert.match(action, /packages=\(bubblewrap gnome-keyring dbus-x11\)/u);
  assert.match(action, /packages\+=\(xvfb\)/u);
  assert.match(
    action,
    /profile vibestudio_mxc_lxc_exec "\$GITHUB_WORKSPACE\/dist\/mxc\/linux-x64\/lxc-exec" flags=\(unconfined\)/u
  );
  assert.match(action, /userns,/u);
  assert.match(action, /apparmor_parser -r \/etc\/apparmor\.d\/vibestudio-mxc-lxc-exec/u);
  assert.match(qualityJob, /uses: \.\/\.github\/actions\/setup-linux-source-runtime/u);
  assert.match(
    desktopJob,
    /uses: \.\/\.github\/actions\/setup-linux-source-runtime[\s\S]*?desktop: "true"/u
  );
  assert.match(androidJob, /uses: \.\/\.github\/actions\/setup-linux-source-runtime\n/u);
  assert.doesNotMatch(androidJob, /desktop: "true"/u);
});

test("public Vitest Iroh entrypoints prepare the development desktop host", () => {
  const scripts = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).scripts;
  for (const name of ["test:iroh", "test:iroh-e2e", "test:watch"]) {
    assert.match(
      scripts[name],
      /^NODE_ENV=development node scripts\/ensure-host-build\.mjs && /u,
      `${name} must prepare the host before starting Vitest`
    );
  }
});
