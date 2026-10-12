import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import os from "node:os";
import { execFileSync } from "node:child_process";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Linux candidate checksums admit native package architecture names and reject incomplete sets", async () => {
  const workflow = await readWorkflow("linux-installer.yml");
  const command = workflow.jobs.candidate.steps
    .find((step) => step.name === "Generate installer checksums")
    .run.replaceAll("${{ inputs.arch }}", "x64");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "linux-candidate-checksums-"));
  try {
    const release = path.join(root, "release");
    await fs.mkdir(release);
    for (const architectures of [
      ["amd64", "x86_64", "x64"],
      ["arm64", "aarch64", "arm64"],
    ]) {
      const names = ["deb", "rpm", "pkg.tar.zst"].map(
        (extension, index) => `vibestudio-0.1.98-${architectures[index]}.${extension}`
      );
      for (const name of names) await fs.writeFile(path.join(release, name), name);
      execFileSync("bash", ["-euo", "pipefail", "-c", command], {
        cwd: root,
        env: { ...process.env, ARCH: "x64" },
      });
      execFileSync("sha256sum", ["--check", "SHA256SUMS-linux-x64"], { cwd: release });
      await fs.rm(path.join(release, names[0]));
      assert.throws(() =>
        execFileSync("bash", ["-euo", "pipefail", "-c", command], {
          cwd: root,
          env: { ...process.env, ARCH: "x64" },
        })
      );
      for (const name of names.slice(1)) await fs.rm(path.join(release, name));
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("release workflow shell steps never interpolate workflow inputs into script source", async () => {
  const files = [
    "release.yml",
    "ci.yml",
    "application-candidate.yml",
    "linux-installer.yml",
    "windows-installer.yml",
  ];
  for (const fileName of files) {
    const workflow = await readWorkflow(fileName);
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      for (const step of job.steps ?? []) {
        if (typeof step.run !== "string") continue;
        assert.doesNotMatch(
          step.run,
          /\$\{\{\s*inputs\./u,
          `${fileName}:${jobName}:${step.name ?? "unnamed"} must pass workflow inputs through env, not shell source`
        );
      }
    }
  }
});

async function readWorkflow(fileName) {
  const source = await fs.readFile(
    path.join(repositoryRoot, ".github/workflows", fileName),
    "utf8"
  );
  const workflow = parse(source, { uniqueKeys: true });
  assert.ok(workflow && typeof workflow.jobs === "object", `${fileName} must declare jobs`);
  return workflow;
}

async function readCiJobs() {
  const workflow = await readWorkflow("ci.yml");
  return workflow.jobs;
}

function dependenciesOf(job) {
  const needs = job?.needs;
  if (needs === undefined) return [];
  return Array.isArray(needs) ? needs : [needs];
}

function transitiveDependencies(jobs, name, visiting = new Set()) {
  assert.ok(jobs[name], `CI job ${name} must exist`);
  assert.ok(!visiting.has(name), `CI job dependency cycle includes ${name}`);
  const nextVisiting = new Set(visiting).add(name);
  const result = new Set();
  for (const dependency of dependenciesOf(jobs[name])) {
    assert.ok(jobs[dependency], `CI job ${name} depends on missing job ${dependency}`);
    result.add(dependency);
    for (const ancestor of transitiveDependencies(jobs, dependency, nextVisiting)) {
      result.add(ancestor);
    }
  }
  return result;
}

test("native artifact consumers wait for their exact producers without unrelated gates", async () => {
  const jobs = await readCiJobs();
  const producerJobs = [
    "native-input-linux-x64",
    "native-input-linux-arm64",
    "native-input-darwin-arm64",
  ];

  for (const [producer, target, runner] of [
    ["native-input-linux-x64", "linux-x64", "ubuntu-22.04"],
    ["native-input-linux-arm64", "linux-arm64", "ubuntu-22.04-arm"],
    ["native-input-darwin-arm64", "darwin-arm64", "macos-14"],
  ]) {
    assert.deepEqual(dependenciesOf(jobs[producer]), []);
    assert.equal(jobs[producer].uses, "./.github/workflows/native-input.yml");
    assert.equal(jobs[producer].with.target, target);
    assert.equal(jobs[producer].with.runner, runner);
  }

  for (const [candidate, producer, verifier, runner, arch] of [
    [
      "linux-installer-x64",
      "native-input-linux-x64",
      "native-isolation-linux-x64",
      "ubuntu-24.04",
      "x64",
    ],
    [
      "linux-installer-arm64",
      "native-input-linux-arm64",
      "native-isolation-linux-arm64",
      "ubuntu-24.04-arm",
      "arm64",
    ],
  ]) {
    const job = jobs[candidate];
    assert.deepEqual(dependenciesOf(job), [producer]);
    assert.equal(job.if, "\${{ vars.RELEASE_LINUX == 'true' && inputs.release-preparation }}");
    assert.equal(job.uses, "./.github/workflows/linux-installer.yml");
    assert.deepEqual(job.with, { runner, arch, "release-tag": "\${{ inputs.release-tag }}" });
    assert.ok(
      !transitiveDependencies(jobs, candidate).has(verifier),
      `${candidate} must not wait for its native verification job`
    );
  }

  const linuxInstaller = await readWorkflow("linux-installer.yml");
  assert.deepEqual(linuxInstaller.on.workflow_call.inputs, {
    runner: { type: "string", required: true },
    arch: { type: "string", required: true },
    "release-tag": { type: "string", default: "" },
  });
  const appJob = linuxInstaller.jobs.app;
  const formatJob = linuxInstaller.jobs.format;
  const candidateJob = linuxInstaller.jobs.candidate;
  assert.equal(appJob["runs-on"], "\${{ inputs.runner }}");
  assert.deepEqual(appJob.permissions, { contents: "read" });
  assert.equal(appJob.needs, undefined);
  assert.deepEqual(formatJob.needs, "app");
  assert.deepEqual(formatJob.strategy, {
    "max-parallel": 3,
    "fail-fast": false,
    matrix: { format: ["deb", "rpm", "pacman"] },
  });
  assert.deepEqual(candidateJob.needs, "format");

  const appSteps = appJob.steps;
  const linuxDownload = appSteps.find(
    (step) => step.name === "Download this architecture's tested MXC payload"
  );
  assert.equal(linuxDownload.with.name, "native-isolation-linux-\${{ inputs.arch }}-\${{ github.sha }}");
  assert.equal(
    linuxDownload.with.path,
    "native/isolation/artifacts/native-isolation-linux-\${{ inputs.arch }}"
  );
  const appDirectoryStep = appSteps.find(
    (step) => step.name === "Resolve electron-builder's application directory for this architecture"
  );
  assert.equal(
    appDirectoryStep.run,
    'app_directory=$(node scripts/package-desktop.mjs linux app-path "$ARCH")\necho "LINUX_APP_DIRECTORY=$app_directory" >> "$GITHUB_ENV"\n'
  );
  assert.equal(appDirectoryStep.env.ARCH, "\${{ inputs.arch }}");
  assert.match(
    appSteps.find(
      (step) => step.name === "Allow packaged MXC user namespaces for application preparation"
    ).run,
    /\$LINUX_APP_DIRECTORY\/resources/u
  );
  const buildAppStep = appSteps.find(
    (step) =>
      step.name === "Build exact Linux application and prepare its installed workspace release"
  );
  assert.equal(
    buildAppStep.run,
    'pnpm generate:workspace-template-release && pnpm build && node scripts/package-desktop.mjs linux app "$ARCH"'
  );
  const appUpload = appSteps.find(
    (step) => step.name === "Upload exact Linux application for independent format packaging"
  );
  assert.equal(appUpload.with.name, "vibestudio-linux-app-\${{ inputs.arch }}-\${{ github.sha }}");
  assert.equal(appUpload.with["compression-level"], 0);
  const archiveStep = appSteps.find(
    (step) => step.name === "Archive the immutable prepared application"
  );
  assert.match(archiveStep.run, /packages\/\*\/dist/u);
  assert.match(archiveStep.run, /tar -cf linux-app\.tar release\/linux-unpacked/u);
  assert.doesNotMatch(archiveStep.run, /--dereference|--hard-dereference/u);

  const formatSteps = formatJob.steps;
  const appArchiveDownload = formatSteps.find(
    (step) => step.name === "Download exact prepared Linux application"
  );
  assert.equal(
    appArchiveDownload.with.name,
    "vibestudio-linux-app-\${{ inputs.arch }}-\${{ github.sha }}"
  );
  const packageStep = formatSteps.find(
    (step) => step.name === "Package one installer from the prepared application"
  );
  assert.equal(
    packageStep.run,
    'node scripts/package-desktop.mjs linux format "$PACKAGE_FORMAT" release/linux-unpacked "$ARCH"'
  );
  assert.doesNotMatch(packageStep.run, /pnpm (?:build|dist:linux)/u);
  assert.doesNotMatch(JSON.stringify(formatSteps), /pnpm build:infrastructure/u);
  const formatUpload = formatSteps.find(
    (step) => step.name === "Upload one immutable Linux format candidate"
  );
  assert.equal(
    formatUpload.with.name,
    "vibestudio-linux-\${{ inputs.arch }}-\${{ github.sha }}-\${{ matrix.format }}"
  );
  assert.equal(formatUpload.with["compression-level"], 0);

  const candidateSteps = candidateJob.steps;
  const linuxUpload = candidateSteps.find(
    (step) => step.name === "Upload immutable Linux release candidate"
  );
  assert.equal(linuxUpload.with.name, "vibestudio-linux-\${{ inputs.arch }}-\${{ github.sha }}");
  assert.equal(linuxUpload.with["if-no-files-found"], "error");
  assert.equal(linuxUpload.with["retention-days"], 7);
  assert.deepEqual(candidateJob.permissions, { contents: "read" });
  assert.doesNotMatch(JSON.stringify(linuxInstaller), /\$\{\{\s*secrets\./);
  assert.doesNotMatch(JSON.stringify(linuxInstaller), /softprops\/action-gh-release/);

  for (const [verifier, producer, target, runner] of [
    ["native-isolation-linux-x64", "native-input-linux-x64", "linux-x64", "ubuntu-22.04"],
    ["native-isolation-linux-arm64", "native-input-linux-arm64", "linux-arm64", "ubuntu-22.04-arm"],
    ["native-isolation-darwin-arm64", "native-input-darwin-arm64", "darwin-arm64", "macos-26"],
  ]) {
    assert.deepEqual(
      dependenciesOf(jobs[verifier]),
      verifier === "native-isolation-darwin-arm64"
        ? [producer, "darwin-development-inputs"]
        : [producer]
    );
    assert.equal(jobs[verifier].uses, "./.github/workflows/native-verification.yml");
    assert.equal(jobs[verifier].with.target, target);
    assert.equal(jobs[verifier].with.runner, runner);
  }

  assert.deepEqual(dependenciesOf(jobs["darwin-production-host"]), ["native-input-darwin-arm64"]);
  assert.equal(
    jobs["darwin-production-host"].uses,
    "./.github/workflows/darwin-production-host.yml"
  );
  assert.deepEqual(jobs["darwin-production-host"].with, { runner: "macos-14" });
  assert.deepEqual(dependenciesOf(jobs["application-candidate-mac"]), ["darwin-production-host"]);
  assert.equal(
    jobs["application-candidate-mac"].uses,
    "./.github/workflows/application-candidate.yml"
  );
  assert.equal(jobs["application-candidate-mac"].with.target, "darwin-arm64");
  assert.equal(jobs["application-candidate-mac"].with.package, "mac");
  assert.deepEqual(dependenciesOf(jobs["darwin-development-inputs"]), ["darwin-production-host"]);
  assert.ok(
    !transitiveDependencies(jobs, "darwin-development-inputs").has("application-candidate-mac"),
    "source preparation must start from the production host artifact without waiting for app packaging"
  );
  assert.equal(
    jobs["darwin-development-inputs"].uses,
    "./.github/workflows/darwin-host-inputs.yml"
  );
  assert.deepEqual(jobs["darwin-development-inputs"].with, {
    runner: "macos-14",
    "base-ref": "${{ inputs.base-ref || 'main' }}",
  });
  assert.deepEqual(dependenciesOf(jobs["desktop-source-integration-macos-14"]), [
    "darwin-development-inputs",
  ]);
  assert.equal(
    jobs["desktop-source-integration-macos-14"].uses,
    "./.github/workflows/desktop-source-integration.yml"
  );
  assert.ok(
    !transitiveDependencies(jobs, "packaged-acceptance-macos-14").has("darwin-development-inputs"),
    "installed-app acceptance must not wait for unrelated development source integration"
  );
  assert.deepEqual(dependenciesOf(jobs["application-candidate-windows"]), []);
  assert.equal(
    jobs["application-candidate-windows"].uses,
    "./.github/workflows/application-candidate.yml"
  );
  assert.equal(jobs["application-candidate-windows"].with.target, "win32-x64");
  assert.equal(jobs["application-candidate-windows"].with.package, "windows");
  const windowsInstallerCandidate = jobs["windows-installer-candidate"];
  assert.deepEqual(dependenciesOf(windowsInstallerCandidate), ["application-candidate-windows"]);
  assert.equal(
    windowsInstallerCandidate.if,
    "\${{ vars.RELEASE_WINDOWS == 'true' && inputs.release-preparation }}"
  );
  assert.equal(windowsInstallerCandidate.uses, "./.github/workflows/windows-installer.yml");
  assert.deepEqual(windowsInstallerCandidate.with, {
    runner: "\${{ inputs.windows-runner || 'windows-2025' }}",
    "release-tag": "\${{ inputs.release-tag }}",
  });
  assert.ok(
    !transitiveDependencies(jobs, "windows-installer-candidate").has(
      "native-isolation-darwin-arm64"
    ),
    "the Windows installer must consume only its tested app candidate"
  );

  const windowsInstaller = await readWorkflow("windows-installer.yml");
  assert.deepEqual(windowsInstaller.on.workflow_call.inputs, {
    runner: { type: "string", required: true },
    "release-tag": { type: "string", default: "" },
  });
  const windowsPackageJob = windowsInstaller.jobs.package;
  const windowsAcceptanceJob = windowsInstaller.jobs.acceptance;
  assert.equal(windowsPackageJob["runs-on"], "\${{ inputs.runner }}");
  assert.deepEqual(windowsPackageJob.permissions, { contents: "read" });
  const windowsSteps = windowsPackageJob.steps;
  const windowsDownload = windowsSteps.find(
    (step) => step.name === "Download tested Windows application candidate"
  );
  assert.equal(windowsDownload.with.name, "packaged-app-win32-x64-\${{ github.sha }}");
  const windowsRestore = windowsSteps.find(
    (step) => step.name === "Restore the tested Windows application layout"
  );
  const windowsHookDependencies = windowsSteps.find(
    (step) => step.name === "Build infrastructure packages required by packaging hooks"
  );
  const windowsPackage = windowsSteps.find(
    (step) => step.name === "Package NSIS installer from the tested application"
  );
  assert.equal(windowsHookDependencies.run, "pnpm build:infrastructure");
  assert.ok(windowsSteps.indexOf(windowsDownload) < windowsSteps.indexOf(windowsRestore));
  assert.ok(windowsSteps.indexOf(windowsHookDependencies) < windowsSteps.indexOf(windowsPackage));
  assert.ok(windowsSteps.indexOf(windowsRestore) < windowsSteps.indexOf(windowsPackage));
  assert.match(windowsPackage.run, /--prepackaged release\/win-unpacked/);
  assert.doesNotMatch(windowsPackage.run, /pnpm build/);
  const windowsChecksum = windowsSteps.find((step) => step.name === "Generate installer checksums");
  const windowsUpload = windowsSteps.find(
    (step) => step.name === "Upload immutable Windows release candidate"
  );
  assert.ok(windowsSteps.indexOf(windowsPackage) < windowsSteps.indexOf(windowsChecksum));
  assert.ok(windowsSteps.indexOf(windowsChecksum) < windowsSteps.indexOf(windowsUpload));
  assert.match(windowsChecksum.run, /latest\.yml/);
  assert.match(windowsChecksum.run, /SHA256SUMS-windows/);
  assert.equal(windowsUpload.with.name, "vibestudio-windows-\${{ github.sha }}");
  assert.equal(windowsUpload.with["if-no-files-found"], "error");
  assert.doesNotMatch(JSON.stringify(windowsInstaller), /\$\{\{\s*secrets\./);
  assert.doesNotMatch(JSON.stringify(windowsInstaller), /softprops\/action-gh-release/);

  assert.deepEqual(dependenciesOf(windowsAcceptanceJob), ["package"]);
  assert.equal(windowsAcceptanceJob["runs-on"], "\${{ inputs.runner }}");
  assert.equal(windowsAcceptanceJob.if, undefined);
  assert.equal(windowsAcceptanceJob["timeout-minutes"], 30);
  const windowsAcceptanceSteps = windowsAcceptanceJob.steps;
  const acceptedInstallerDownload = windowsAcceptanceSteps.find(
    (step) => step.name === "Download immutable release candidate"
  );
  assert.equal(acceptedInstallerDownload.with.name, "vibestudio-windows-\${{ github.sha }}");
  const acceptedInstallerChecksum = windowsAcceptanceSteps.find(
    (step) => step.name === "Verify installer checksums"
  );
  const acceptedInstallerLaunch = windowsAcceptanceSteps.find(
    (step) => step.name === "Install and launch the NSIS release candidate"
  );
  assert.equal(acceptedInstallerChecksum.run, "sha256sum --check SHA256SUMS-windows");
  assert.ok(acceptedInstallerLaunch.run.includes("packaged-isolation-smoke.mjs"));
  assert.ok(
    windowsAcceptanceSteps.some((step) => step.name === "Upload acceptance diagnostics"),
    "Windows installer acceptance retains its diagnostics"
  );

  assert.deepEqual(dependenciesOf(jobs["npm-server-preflight"]), producerJobs);
  const npmDownloads = jobs["npm-server-preflight"].steps
    .filter((step) => step.uses?.startsWith("actions/download-artifact@"))
    .map((step) => step.with.name)
    .filter(
      (name) =>
        name?.startsWith("native-isolation-") || name?.startsWith("darwin-process-observers-")
    );
  assert.deepEqual(npmDownloads, [
    "native-isolation-linux-x64-${{ github.sha }}",
    "native-isolation-linux-arm64-${{ github.sha }}",
    "native-isolation-darwin-arm64-${{ github.sha }}",
    "darwin-process-observers-ci-${{ github.sha }}",
  ]);
  const npmPreflightSteps = jobs["npm-server-preflight"].steps;
  const candidateStepIndex = npmPreflightSteps.findIndex(
    (step) => step.name === "Build, stage, verify, and retain the npm candidate"
  );
  const uploadStepIndex = npmPreflightSteps.findIndex(
    (step) => step.name === "Upload verified npm candidate"
  );
  assert.ok(candidateStepIndex >= 0, "npm preflight must produce and verify its candidate");
  assert.ok(uploadStepIndex > candidateStepIndex, "only the verified candidate is uploaded");
  const candidateStep = npmPreflightSteps[candidateStepIndex];
  assert.equal(candidateStep.if, undefined, "candidate production must fail the preflight");
  assert.match(candidateStep.run, /pnpm publish:server-npm/);
  assert.match(candidateStep.run, /--dry-run-only/);
  assert.match(candidateStep.run, /--candidate-output.*npm-candidate/);
  assert.doesNotMatch(candidateStep.run, /npm pack/u, "the workflow must not repack the candidate");

  const uploadStep = npmPreflightSteps[uploadStepIndex];
  assert.equal(uploadStep.if, undefined, "candidate upload must be a required preflight result");
  assert.equal(uploadStep.uses, "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
  assert.equal(
    uploadStep.with.name,
    "vibestudio-server-npm-${{ github.sha }}-${{ github.run_attempt }}"
  );
  assert.match(uploadStep.with.path, /npm-candidate\/\*\.tgz/);
  assert.match(uploadStep.with.path, /candidate-receipt\.json/);
  assert.equal(uploadStep.with["if-no-files-found"], "error");
  assert.equal(uploadStep.with["compression-level"], 0);
  assert.equal(uploadStep.with["retention-days"], 14);

  const acceptanceJobs = [
    [
      "packaged-acceptance-macos-14",
      "application-candidate-mac",
      "macos-14",
      "darwin-arm64",
      "Vibestudio.app",
    ],
    [
      "packaged-acceptance-macos-26",
      "application-candidate-mac",
      "macos-26",
      "darwin-arm64",
      "Vibestudio.app",
    ],
    [
      "packaged-acceptance-windows",
      "application-candidate-windows",
      "${{ inputs.windows-runner || 'windows-2025' }}",
      "win32-x64",
      "Vibestudio.exe",
    ],
  ];
  for (const [jobName, candidate, runner, target, app] of acceptanceJobs) {
    assert.deepEqual(dependenciesOf(jobs[jobName]), [candidate]);
    assert.equal(jobs[jobName].uses, "./.github/workflows/packaged-acceptance.yml");
    assert.equal(
      jobs[jobName].if,
      `\${{ needs.${candidate}.result == 'success' }}`,
      "acceptance may consume only an artifact produced by its own successful candidate job"
    );
    assert.deepEqual(jobs[jobName].with, { runner, target, app });
    const ancestors = transitiveDependencies(jobs, jobName);
    assert.ok(
      !ancestors.has("application-candidate-mac") || candidate === "application-candidate-mac"
    );
    assert.ok(
      !ancestors.has("application-candidate-windows") ||
        candidate === "application-candidate-windows"
    );
  }

  const acceptanceWorkflow = await readWorkflow("packaged-acceptance.yml");
  const acceptanceSteps = acceptanceWorkflow.jobs.acceptance.steps;
  const downloadStep = acceptanceSteps.find(
    (step) => step.name === "Download application built in another job"
  );
  assert.ok(downloadStep, "acceptance must download the installed candidate artifact");
  assert.equal(downloadStep.with.name, "packaged-app-${{ inputs.target }}-${{ github.sha }}");
  assert.equal(downloadStep.with["if-no-artifact-found"], "error");
  assert.equal(downloadStep["continue-on-error"], undefined);
  assert.equal(
    downloadStep.if,
    undefined,
    "after the producer succeeds, acceptance must fail if its artifact is unexpectedly absent"
  );
  assert.ok(
    acceptanceSteps.some(
      (step) => step.name === "Launch installed desktop and workspace containment smoke"
    ),
    "each platform candidate must run the installed-app acceptance smoke"
  );

  for (const candidate of [
    "native-isolation-linux-x64",
    "native-isolation-linux-arm64",
    "application-candidate-mac",
    "application-candidate-windows",
    "windows-installer-candidate",
    "npm-server-preflight",
    ...acceptanceJobs.map(([name]) => name),
  ]) {
    const ancestors = transitiveDependencies(jobs, candidate);
    assert.ok(
      ![
        "native-isolation-linux-x64",
        "native-isolation-linux-arm64",
        "native-isolation-darwin-arm64",
      ].some((verification) => ancestors.has(verification)),
      `${candidate} must not wait for an independent native verification job`
    );
  }
  assert.ok(
    producerJobs.every((producer) =>
      transitiveDependencies(jobs, "npm-server-preflight").has(producer)
    ),
    "the universal npm candidate must consume all prepared platform inputs"
  );
  assert.ok(producerJobs.includes("native-input-darwin-arm64"));
  const releaseJobs = (await readWorkflow("release.yml")).jobs;
  assert.equal(releaseJobs["release-quality"].uses, "./.github/workflows/ci.yml");
  assert.match(
    JSON.stringify(releaseJobs["validate-release-input"]),
    /refs\/heads\/main/u,
    "release preparation is restricted to the protected main ref"
  );
  assert.deepEqual(dependenciesOf(releaseJobs["release-quality"]), ["validate-release-input"]);
  assert.equal(releaseJobs["release-quality"].with["release-preparation"], true);
  assert.deepEqual(releaseJobs["release-quality"].secrets, {
    LINUX_SIGNING_KEY: "\${{ secrets.LINUX_SIGNING_KEY }}",
    APPLE_CSC_LINK: "\${{ secrets.APPLE_CSC_LINK }}",
    APPLE_CSC_KEY_PASSWORD: "\${{ secrets.APPLE_CSC_KEY_PASSWORD }}",
    APPLE_ID: "\${{ secrets.APPLE_ID }}",
    APPLE_APP_SPECIFIC_PASSWORD: "\${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}",
    APPLE_TEAM_ID: "\${{ secrets.APPLE_TEAM_ID }}",
  });
  assert.deepEqual(dependenciesOf(releaseJobs["create-release-tag"]), ["release-quality"]);
  assert.deepEqual(dependenciesOf(releaseJobs["github-release"]), ["create-release-tag"]);
  assert.match(
    JSON.stringify(releaseJobs["create-release-tag"]),
    /git\/tags/u,
    "the workflow creates an annotated Git tag object"
  );
  assert.match(JSON.stringify(releaseJobs["create-release-tag"]), /verify_existing_tag/u);
  assert.match(JSON.stringify(releaseJobs["create-release-tag"]), /\.object\.type.*tag/u);
  assert.match(JSON.stringify(releaseJobs["create-release-tag"]), /\.object\.sha.*SOURCE_SHA/u);
  assert.doesNotMatch(JSON.stringify(releaseJobs["create-release-tag"]), /force/u);
  assert.equal(releaseJobs["mac-dmg"], undefined);
  assert.equal(releaseJobs["accept-macos-installer"], undefined);

  assert.equal(releaseJobs["linux-installers"], undefined);
  assert.deepEqual(dependenciesOf(releaseJobs["publish-linux"]), [
    "github-release",
    "release-quality",
  ]);
  assert.match(
    JSON.stringify(releaseJobs["publish-linux"]),
    /vibestudio-linux-release-/,
    "Linux publication consumes the pre-tag signed candidate"
  );
  assert.equal(releaseJobs["windows-installer"], undefined);
  assert.equal(releaseJobs["accept-windows-installer"], undefined);
  assert.deepEqual(dependenciesOf(releaseJobs["publish-windows"]), [
    "github-release",
    "release-quality",
  ]);

  const ciJobs = await readCiJobs();
  const linuxSigner = ciJobs["sign-linux-release-candidate"];
  assert.deepEqual(dependenciesOf(linuxSigner), ["linux-installer-x64", "linux-installer-arm64"]);
  assert.equal(linuxSigner.if, "\${{ inputs.release-preparation && vars.RELEASE_LINUX == 'true' }}");
  assert.match(JSON.stringify(linuxSigner.steps), /scripts\/publish\/sign-linux-installers\.sh/u);
  assert.match(JSON.stringify(linuxSigner.steps), /verify-rpm-signatures|SHA256SUMS-linux/u);
  assert.ok(linuxSigner.steps.some((step) => step.with?.name === "vibestudio-linux-release-\${{ github.sha }}"));
  assert.doesNotMatch(JSON.stringify(releaseJobs["publish-linux"]), /LINUX_SIGNING_KEY/u);
  assert.ok(
    releaseJobs["publish-linux"].steps.some(
      (step) => step.with?.name === "vibestudio-linux-release-\${{ inputs.source-sha }}"
    ),
    "the publisher consumes the signed pre-tag candidate"
  );
  const macJob = ciJobs["macos-release-candidate"];
  assert.deepEqual(dependenciesOf(macJob), ["application-candidate-mac"]);
  assert.equal(macJob.if, "\${{ inputs.release-preparation && vars.RELEASE_MAC == 'true' }}");
  const macSteps = macJob.steps;
  assert.ok(macSteps.some((step) => step.name === "Verify exact macOS app archive provenance"));
  assert.ok(macSteps.some((step) => /--prepackaged release\/Vibestudio\.app/u.test(step.run ?? "")));
  assert.ok(macSteps.some((step) => step.name === "Restore and verify the exact tested application"));
  assert.doesNotMatch(JSON.stringify(macSteps), /pnpm build(?:\s|$)/u);
  assert.ok(
    macSteps.some((step) => step.name === "Download source-attested Darwin process observers"),
    "the release candidate packages CI's source-attested observers"
  );

  assert.deepEqual(dependenciesOf(ciJobs["accept-macos-release-candidate"]), ["macos-release-candidate"]);
  assert.ok(
    !transitiveDependencies(ciJobs, "macos-release-candidate").has("quality"),
    "macOS installer production starts from the candidate without waiting for unrelated quality checks"
  );
  const macAncestors = transitiveDependencies(releaseJobs, "publish-macos");
  assert.ok(
    macAncestors.has("release-quality"),
    "publication remains behind all release candidate and acceptance gates"
  );

  for (const [publisher, producer, acceptance] of [
    ["publish-linux", "release-quality", undefined],
    ["publish-windows", "release-quality", undefined],
    ["publish-macos", "release-quality", undefined],
  ]) {
    const job = releaseJobs[publisher];
    const dependencies = dependenciesOf(job);
    assert.ok(
      dependencies.includes("github-release"),
      `${publisher} must wait for the validated draft`
    );
    assert.ok(
      dependencies.includes(producer),
      `${publisher} must wait for its exact immutable candidate`
    );
    if (acceptance) {
      assert.ok(
        dependencies.includes(acceptance),
        `${publisher} must wait for installed acceptance`
      );
    }
    assert.doesNotMatch(
      job.if ?? "",
      /always\(\)|!cancelled\(\)/,
      `${publisher} must skip when a required dependency fails or is cancelled`
    );
  }

  const releaseAncestors = transitiveDependencies(releaseJobs, "publish-release");
  assert.ok(
    releaseAncestors.has("release-quality"),
    "the public release must remain behind full quality validation"
  );
});

test("Darwin production and development host inputs are immutable producer artifacts", async () => {
  const hostWorkflow = await readWorkflow("darwin-production-host.yml");
  const hostJob = hostWorkflow.jobs["production-host"];
  const hostSteps = hostJob.steps;
  const hostIndex = (name) => {
    const index = hostSteps.findIndex((step) => step.name === name);
    assert.notEqual(index, -1, `Darwin host producer must include step: ${name}`);
    return index;
  };
  assert.equal(hostJob["timeout-minutes"], undefined);
  assert.ok(
    hostIndex("Build production application and headless host") <
      hostIndex("Check native execution and platform permissions")
  );
  assert.ok(
    hostIndex("Check native execution and platform permissions") <
      hostIndex("Verify and archive production host inputs")
  );
  assert.ok(
    hostIndex("Verify and archive production host inputs") <
      hostIndex("Upload production host inputs")
  );
  assert.equal(
    hostSteps[hostIndex("Build production application and headless host")].run,
    "pnpm build"
  );
  assert.equal(
    hostSteps[hostIndex("Check native execution and platform permissions")].run,
    "pnpm vitest run --config packages/process-adapter/vitest.native.config.ts --reporter=default --reporter=json --outputFile=.cache/native-acceptance.json"
  );
  assert.equal(
    hostSteps[hostIndex("Upload production host inputs")].with.name,
    "vibestudio-darwin-host-production-${{ github.sha }}"
  );
  assert.match(
    hostSteps[hostIndex("Verify and archive production host inputs")].run,
    /tar -cf .* native\/isolation\/artifacts\/native-isolation-darwin-arm64 /u,
    "host transport must include the original native input consumed by electron-builder"
  );

  const reusable = await readWorkflow("application-candidate.yml");
  const steps = reusable.jobs.candidate.steps;
  const indexOf = (name) => {
    const index = steps.findIndex((step) => step.name === name);
    assert.notEqual(index, -1, `application-candidates must include step: ${name}`);
    return index;
  };
  assert.equal(reusable.jobs.candidate["timeout-minutes"], undefined);
  assert.ok(
    indexOf("Download exact Darwin production host inputs") <
      indexOf("Restore and verify exact Darwin production host inputs")
  );
  assert.ok(
    indexOf("Restore and verify exact Darwin production host inputs") <
      indexOf("Package the application")
  );
  assert.match(
    steps[indexOf("Package the application")].if,
    /inputs\.target == 'darwin-arm64'.*steps\.native-check\.outcome == 'success'/
  );
  assert.equal(
    steps[indexOf("Restore and verify exact Darwin production host inputs")].id,
    "restore-host-inputs"
  );
  assert.match(steps[indexOf("Package the application")].if, /success\(\)/);
  assert.match(
    steps[indexOf("Package the application")].if,
    /steps\.restore-host-inputs\.outcome == 'success'/
  );
  assert.equal(
    steps.some((step) => step.name.includes("Desktop pairing")),
    false
  );
  assert.equal(
    steps.some(
      (step) => step.run === "pnpm build" && step.if === "${{ inputs.target == 'darwin-arm64' }}"
    ),
    false,
    "Darwin packaging must reuse the tested production host generation"
  );

  const sourceProducer = await readWorkflow("darwin-host-inputs.yml");
  const sourceSteps = sourceProducer.jobs.prepare.steps;
  assert.match(
    sourceSteps.find((step) => step.name === "Verify and archive portable development inputs").run,
    /tar -cf .* native\/isolation\/artifacts\/native-isolation-darwin-arm64 /u,
    "development transport must preserve the complete native input closure"
  );
  const sourceIndex = (name) => sourceSteps.findIndex((step) => step.name === name);
  assert.deepEqual(sourceProducer.on.workflow_call.inputs, {
    runner: { type: "string", required: true },
    "base-ref": { type: "string", default: "main" },
  });
  assert.ok(sourceIndex("Download exact production host inputs") >= 0);
  const pairedBase = sourceSteps[sourceIndex("Checkout paired Base template")];
  assert.equal(pairedBase.with.ref, "${{ inputs.base-ref }}");
  assert.equal(pairedBase.with.path, ".cache/template-checkouts/base");
  assert.ok(
    sourceIndex("Checkout paired Base template") < sourceIndex("Acquire exact template source set"),
    "the complete official template setup must preserve the caller's exact Base source input"
  );
  assert.ok(
    sourceIndex("Restore and verify production host inputs") <
      sourceIndex("Prepare development source host and canonical workspace release")
  );
  assert.equal(
    sourceSteps[sourceIndex("Build development source host generation")].env.NODE_ENV,
    "development"
  );
  assert.equal(
    sourceSteps[sourceIndex("Build development source host generation")].run,
    "node build.mjs --source-server-prereqs"
  );
  assert.ok(
    sourceIndex("Build development source host generation") <
      sourceIndex("Prepare development source host and canonical workspace release")
  );
  assert.ok(
    sourceSteps[sourceIndex("Verify and archive portable development inputs")].run.includes(
      "--source-mode development"
    )
  );
  assert.ok(
    sourceSteps[sourceIndex("Verify and archive portable development inputs")].run.includes(
      "--template-root"
    )
  );
  assert.ok(
    sourceSteps[sourceIndex("Verify and archive portable development inputs")].run.includes(
      ".cache/template-checkouts"
    )
  );
  assert.ok(
    sourceSteps[sourceIndex("Upload exact development source inputs")].with.name.includes(
      "${{ github.sha }}"
    )
  );
  assert.match(
    sourceSteps[sourceIndex("Verify and archive portable development inputs")].run,
    /host-generations\/.leases/
  );
  assert.match(
    sourceSteps[sourceIndex("Verify and archive portable development inputs")].run,
    /host-generations\/.lock/
  );
  assert.equal(sourceProducer.jobs.prepare["timeout-minutes"], undefined);

  const sourceConsumers = [
    ["native-verification.yml", "Restore and verify exact Darwin development inputs"],
    ["desktop-source-integration.yml", "Restore and verify exact source integration inputs"],
  ];
  for (const [workflowFile, restoreName] of sourceConsumers) {
    const workflow = await readWorkflow(workflowFile);
    const consumerJob =
      workflow.jobs[workflowFile === "native-verification.yml" ? "verify" : "smoke"];
    const consumerSteps = consumerJob.steps;
    assert.equal(consumerJob["timeout-minutes"], undefined);
    const restore = consumerSteps.find((step) => step.name === restoreName);
    assert.ok(restore, `${workflowFile} must verify the producer artifact`);
    assert.match(restore.run, /ci-host-build-inputs\.mjs verify/);
    assert.match(restore.run, /--source-mode development/);
    assert.match(restore.run, /--template-root/);
    if (workflowFile === "native-verification.yml") {
      const productionBuild = consumerSteps.find(
        (step) => step.name === "Build production application and headless host"
      );
      assert.equal(productionBuild.run, "pnpm build");
      assert.equal(productionBuild.if, "${{ inputs.target != 'darwin-arm64' }}");
    } else {
      assert.ok(
        !consumerSteps.some(
          (step) =>
            step.run === "pnpm build" || step.run === "node build.mjs --source-server-prereqs"
        ),
        `${workflowFile} must consume the prepared host artifact rather than recompiling it`
      );
    }
  }
});
