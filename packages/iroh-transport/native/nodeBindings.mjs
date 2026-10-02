import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runIn, sha256 } from "./patchedSource.mjs";

// These tools belong to the Node distribution used by the native builder.
// Invoking their JavaScript entry points also works on Windows without a shell.
function nodeTool(packageName, entry) {
  return join(
    dirname(process.execPath),
    process.platform === "win32" ? "node_modules" : "../lib/node_modules",
    packageName,
    entry
  );
}

/** Generate, package, install, and check the complete Node API from this Rust build. */
export function buildNodePackages({
  output,
  source,
  cargoTarget,
  target,
  descriptor,
  targets,
  version,
  scope,
}) {
  if (process.env.NAPI_RS_NATIVE_LIBRARY_PATH) {
    throw new Error("A release build cannot inherit a native-library override");
  }
  const project = join(source, "iroh-js");
  const manifestPath = join(project, "package.json");
  const upstream = JSON.parse(readFileSync(manifestPath, "utf8"));
  const env = {
    CARGO_TARGET_DIR: cargoTarget,
    COREPACK_HOME: join(output, "corepack"),
    YARN_ENABLE_GLOBAL_CACHE: "false",
    YARN_CACHE_FOLDER: join(output, "yarn-cache"),
    npm_config_cache: join(output, "npm-cache"),
  };
  const yarn = (...args) =>
    runIn(
      process.execPath,
      [nodeTool("corepack", "dist/corepack.js"), "yarn", ...args],
      project,
      env
    );
  const npm = (cwd, ...args) =>
    runIn(process.execPath, [nodeTool("npm", "bin/npm-cli.js"), ...args], cwd, env, true);
  yarn("install", "--immutable");
  // Stamp release metadata only after installing the unchanged locked workspace.
  upstream.version = version;
  writeFileSync(manifestPath, `${JSON.stringify(upstream, null, 2)}\n`);
  const generated = join(output, "generated");
  const rootName = `${scope}/iroh`;
  yarn(
    "napi",
    "build",
    "--platform",
    "--target",
    target,
    "--release",
    "--strip",
    "--package",
    "number0_iroh",
    "--output-dir",
    generated,
    "--js-package-name",
    rootName,
    "--js",
    "index.js",
    "--dts",
    "index.d.ts",
    "--",
    "--locked"
  );

  const artifactName = `iroh.${descriptor.platform}.node`;
  const platformDirectory = join(output, "package");
  mkdirSync(platformDirectory, { recursive: true });
  copyFileSync(join(generated, artifactName), join(platformDirectory, artifactName));
  const platformManifest = {
    name: `${scope}/iroh-${descriptor.platform}`,
    version,
    os: [descriptor.os],
    cpu: [descriptor.cpu],
    main: artifactName,
    files: [artifactName],
    license: upstream.license,
    engines: upstream.engines,
    repository: upstream.repository,
    ...(descriptor.libc ? { libc: [descriptor.libc] } : {}),
  };
  writeFileSync(
    join(platformDirectory, "package.json"),
    `${JSON.stringify(platformManifest, null, 2)}\n`
  );
  const rootDirectory = join(output, "root-package");
  mkdirSync(join(rootDirectory, "iroh-js"), { recursive: true });
  for (const file of ["index.js", "index.d.ts"]) {
    copyFileSync(join(generated, file), join(rootDirectory, "iroh-js", file));
  }
  const rootManifest = {
    name: rootName,
    version,
    type: "commonjs",
    main: "iroh-js/index.js",
    types: "iroh-js/index.d.ts",
    files: ["iroh-js/index.js", "iroh-js/index.d.ts"],
    license: upstream.license,
    engines: upstream.engines,
    repository: upstream.repository,
    optionalDependencies: Object.fromEntries(
      Object.values(targets).map((entry) => [`${scope}/iroh-${entry.platform}`, version])
    ),
  };
  writeFileSync(join(rootDirectory, "package.json"), `${JSON.stringify(rootManifest, null, 2)}\n`);

  const tarballs = join(output, "tarballs");
  mkdirSync(tarballs);
  const pack = (directory) =>
    JSON.parse(npm(directory, "pack", "--json", "--pack-destination", tarballs))[0].filename;
  const platformTarball = join(tarballs, pack(platformDirectory));
  const rootTarball = join(tarballs, pack(rootDirectory));
  const consumer = join(output, "consumer");
  mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), '{"private":true}\n');
  npm(
    consumer,
    "install",
    "--offline",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
    rootTarball,
    platformTarball
  );
  const probe =
    `const { Endpoint, DialAttempt, Connection, BiStreamOpenAttempt } = require(${JSON.stringify(rootName)});\n` +
    `if (typeof DialAttempt !== 'function' || typeof Endpoint.prototype.beginConnect !== 'function') throw new Error('Installed dial API is incomplete');\n` +
    `if (typeof BiStreamOpenAttempt !== 'function' || typeof Connection.prototype.beginOpenBi !== 'function') throw new Error('Installed stream opening API is incomplete');\n`;
  runIn(process.execPath, ["-e", probe], consumer, env);
  runIn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { Endpoint, DialAttempt, Connection, BiStreamOpenAttempt } from ${JSON.stringify(rootName)};\n` +
        `if (typeof DialAttempt !== 'function' || typeof Endpoint.prototype.beginConnect !== 'function') throw new Error('Installed ESM dial API is incomplete');\n` +
        `if (typeof BiStreamOpenAttempt !== 'function' || typeof Connection.prototype.beginOpenBi !== 'function') throw new Error('Installed ESM stream opening API is incomplete');\n`,
    ],
    consumer,
    env
  );
  writeFileSync(
    join(consumer, "probe.ts"),
    `import { Endpoint, EndpointAddr, DialAttempt, Connection, BiStreamOpenAttempt, BiStream } from ${JSON.stringify(rootName)};\n` +
      `export const begin = (endpoint: Endpoint, addr: EndpointAddr): DialAttempt => endpoint.beginConnect(addr, [1]);\n` +
      `export const cancel = (attempt: DialAttempt): Promise<void> => attempt.cancel();\n` +
      `export const connect = (attempt: DialAttempt): Promise<Connection> => attempt.connect();\n` +
      `export const beginOpen = (connection: Connection): BiStreamOpenAttempt => connection.beginOpenBi();\n` +
      `export const open = (attempt: BiStreamOpenAttempt): Promise<BiStream> => attempt.open();\n` +
      `export const cancelOpen = (attempt: BiStreamOpenAttempt): Promise<void> => attempt.cancel();\n`
  );
  runIn(
    process.execPath,
    [
      join(project, "node_modules/typescript/bin/tsc"),
      "--strict",
      "--noEmit",
      "--module",
      "node16",
      "--target",
      "es2022",
      "probe.ts",
    ],
    consumer,
    env
  );
  // Run the unchanged upstream/regression suites beside the installed loader.
  // Their relative imports now exercise the shipped root API and its declared
  // platform dependency, with no test-only native-library selection.
  const tests = [
    "endpoint.mjs",
    "stream-cancellation.mjs",
    "dial-cancellation.mjs",
    "stream-open-cancellation.mjs",
  ];
  const installedTests = join(consumer, "node_modules", rootName, "iroh-js", "test");
  mkdirSync(installedTests);
  for (const test of tests) copyFileSync(join(project, "test", test), join(installedTests, test));
  runIn(
    process.execPath,
    ["--test", ...tests.map((test) => join(installedTests, test))],
    consumer,
    env
  );
  return {
    manifest: platformManifest,
    packageDirectory: platformDirectory,
    artifactName,
    rootPackage: rootName,
    rootTarball,
    platformTarball,
    javascriptSha256: sha256(readFileSync(join(rootDirectory, "iroh-js/index.js"))),
    declarationsSha256: sha256(readFileSync(join(rootDirectory, "iroh-js/index.d.ts"))),
    validation: [
      "Installed root and platform tarballs expose native dial and stream opening APIs",
      "Generated declarations typecheck dial and stream opening ownership",
      "Installed package endpoint, stream, dial, and stream opening cancellation suites",
    ],
  };
}
