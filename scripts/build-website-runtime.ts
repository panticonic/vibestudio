import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { parse } from "@babel/parser";
import { execFileSync } from "node:child_process";
import { prepareUserlandDependencyProjection } from "./lib/userland-dependency-projection.js";
import { generateDtsBundle } from "dts-bundle-generator";
import { requireDevelopmentTemplateCheckout } from "../src/dev/developmentTemplateConfig.js";
import { discoverPackageGraph } from "../src/server/buildV2/packageGraph.js";
import { resolveExportSubpath } from "@vibestudio/typecheck/workspace";

const hostRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argument = (name: string) => {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  if (!process.argv[index + 1]) throw new Error(`${name} requires a value`);
  return process.argv[index + 1]!;
};
const workspaceRoot = path.resolve(
  argument("--workspace-root") ?? requireDevelopmentTemplateCheckout(hostRoot, "base")
);
const output = path.resolve(
  argument("--out-dir") ?? path.join(hostRoot, "dist", "website-runtime")
);
const entry = path.join(workspaceRoot, "packages/runtime/src/panel/index.ts");
const graph = discoverPackageGraph(workspaceRoot);
const hostConfig = JSON.parse(fs.readFileSync(path.join(hostRoot, "tsconfig.json"), "utf8"));
const paths: Record<string, string[]> = {};
for (const [specifier, targets] of Object.entries(
  hostConfig.compilerOptions.paths as Record<string, string[]>
))
  paths[specifier] = targets.map((target) => path.resolve(hostRoot, target));
for (const unit of graph.allNodes()) {
  if (unit.kind === "template") continue;
  const manifest = JSON.parse(fs.readFileSync(path.join(unit.path, "package.json"), "utf8"));
  for (const subpath of typeof manifest.exports === "string"
    ? ["."]
    : Object.keys(manifest.exports ?? {})) {
    if (subpath !== "." && !subpath.startsWith("./")) continue;
    const target = resolveExportSubpath(manifest.exports, subpath, [
      "browser",
      "import",
      "default",
    ]);
    if (target)
      paths[subpath === "." ? unit.name : `${unit.name}/${subpath.slice(2)}`] = [
        path.resolve(unit.path, target),
      ];
  }
}
const cache = path.join(hostRoot, ".cache");
fs.mkdirSync(cache, { recursive: true });
const temporary = fs.mkdtempSync(path.join(cache, "website-runtime-"));
const projection = await prepareUserlandDependencyProjection({ appRoot: hostRoot, workspaceRoot });
try {
  for (const name of Object.keys(projection.dependencies)) {
    paths[name] ??= [path.join(projection.nodeModulesDir, name)];
    paths[`${name}/*`] ??= [path.join(projection.nodeModulesDir, name, "*")];
  }
  const configPath = path.join(temporary, "tsconfig.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      compilerOptions: {
        ...hostConfig.compilerOptions,
        paths,
        rootDir: "/",
        declaration: true,
        noEmit: false,
        types: ["node"],
        typeRoots: [path.join(hostRoot, "node_modules/@types")],
        noUnusedLocals: false,
        noUnusedParameters: false,
      },
      files: [entry],
    })
  );
  const result = await build({
    entryPoints: [entry],
    outfile: path.join(output, "index.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    sourcemap: false,
    tsconfig: configPath,
    conditions: ["browser", "import"],
    nodePaths: [projection.nodeModulesDir, path.join(hostRoot, "node_modules")],
    write: false,
    metafile: true,
  });
  if (
    Object.values(result.metafile!.outputs).some((file) =>
      file.imports.some((item) => item.external)
    )
  )
    throw new Error("Website runtime bundle contains an unresolved external dependency");
  const [declaration] = generateDtsBundle(
    [
      {
        filePath: entry,
        libraries: {
          inlinedLibraries: [
            "zod",
            ...graph.allNodes().map((unit) => unit.name),
            ...fs.readdirSync(path.join(hostRoot, "packages")).flatMap((name) => {
              const file = path.join(hostRoot, "packages", name, "package.json");
              return fs.existsSync(file)
                ? [JSON.parse(fs.readFileSync(file, "utf8")).name as string]
                : [];
            }),
          ],
          importedLibraries: [],
          allowedTypesLibraries: [],
        },
        output: { noBanner: true, exportReferencedTypes: false },
      },
    ],
    { preferredConfigPath: configPath }
  );
  if (!declaration) throw new Error("Website runtime declarations are empty");
  const imports = new Set<string>();
  const inspect = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    const source = node["type"] === "TSImportType" ? node["argument"] : node["source"];
    if (
      source &&
      typeof source === "object" &&
      typeof (source as { value?: unknown }).value === "string"
    )
      imports.add((source as { value: string }).value);
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) child.forEach(inspect);
      else if (child && typeof child === "object") inspect(child);
    }
  };
  inspect(parse(declaration, { sourceType: "module", plugins: ["typescript"] }));
  if (imports.size)
    throw new Error(
      `Website runtime declarations have external imports: ${[...imports].join(", ")}`
    );
  const standaloneTypes = path.join(temporary, "index.d.ts");
  fs.writeFileSync(standaloneTypes, declaration);
  const validationConfig = path.join(temporary, "validation.json");
  fs.writeFileSync(
    validationConfig,
    JSON.stringify({
      compilerOptions: {
        target: "es2022",
        module: "esnext",
        moduleResolution: "bundler",
        lib: ["es2022", "dom", "dom.iterable"],
        noEmit: true,
        strict: true,
        types: [],
        skipLibCheck: false,
      },
      files: [standaloneTypes, path.join(temporary, "connection.d.ts")],
    })
  );
  const code = result.outputFiles![0]!.contents;
  const digest = createHash("sha256").update(code).update(declaration).digest("hex");
  const runtimeVersion = `0.1.0-website.${digest.slice(0, 16)}`;
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, "index.js"), code);
  fs.writeFileSync(path.join(output, "index.d.ts"), declaration);
  fs.writeFileSync(
    path.join(output, "package.json"),
    JSON.stringify(
      {
        name: "@vibestudio/runtime",
        version: runtimeVersion,
        type: "module",
        description: "The shared Vibestudio panel and connected website runtime",
        exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
        license: JSON.parse(fs.readFileSync(path.join(hostRoot, "package.json"), "utf8")).license,
        files: ["index.js", "index.d.ts", "README.md", "THIRD_PARTY_NOTICES.txt"],
      },
      null,
      2
    ) + "\n"
  );
  const notices = new Map<string, string>();
  for (const input of Object.keys(result.metafile!.inputs)) {
    let directory = path.dirname(path.resolve(hostRoot, input));
    if (!directory.includes(`${path.sep}node_modules${path.sep}`)) continue;
    while (directory !== path.dirname(directory)) {
      const manifestPath = path.join(directory, "package.json");
      if (fs.existsSync(manifestPath)) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        const licenseFile = fs
          .readdirSync(directory)
          .find((name) => /^licen[cs]e(?:\.|$)/i.test(name));
        if (licenseFile)
          notices.set(
            `${manifest.name}@${manifest.version}`,
            fs.readFileSync(path.join(directory, licenseFile), "utf8")
          );
        break;
      }
      directory = path.dirname(directory);
    }
  }
  fs.writeFileSync(
    path.join(output, "THIRD_PARTY_NOTICES.txt"),
    [...notices]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, text]) => `${name}\n\n${text}`)
      .join("\n\n")
  );
  fs.writeFileSync(
    path.join(output, "README.md"),
    "# Vibestudio runtime\n\nThe shared API for installed panels and connected websites; no rendered controls. Call `connectWorkspace()` directly from a user action; `workspaceConnection` exposes `available`, `connected`, `status`, `error` and `subscribe`. Never auto-connect or retry. The page connects to its containing workspace inside Vibestudio; ordinary browsers have no bridge. Workspace operations fail while disconnected. For the standard React control use the separately packaged `@workspace/react/connection` entry.\n"
  );

  // Package the focused React entry independently. Its runtime and React stay
  // external: the application supplies both, so there is only one connection.
  const reactEntry = path.join(workspaceRoot, "packages/react/src/WorkspaceConnection.tsx");
  const reactOutput = path.join(output, "react");
  const reactResult = await build({
    entryPoints: [reactEntry],
    outfile: path.join(reactOutput, "connection.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    jsx: "automatic",
    tsconfig: configPath,
    external: ["@workspace/runtime", "react", "react/jsx-runtime"],
    write: false,
    metafile: true,
  });
  const allowedReactImports = new Set(["@workspace/runtime", "react", "react/jsx-runtime"]);
  if (Object.keys(reactResult.metafile!.inputs).length !== 1)
    throw new Error("Website React control unexpectedly bundled a dependency");
  for (const file of Object.values(reactResult.metafile!.outputs)) {
    if (file.imports.some((item) => !item.external || !allowedReactImports.has(item.path)))
      throw new Error("Website React control must depend only on the shared runtime and React");
  }
  // The JS peer is external. Resolve its types from the same authoring toolchain
  // used by create:website, rather than the production-only dependency projection.
  const reactConfigPath = path.join(temporary, "react-tsconfig.json");
  fs.writeFileSync(
    reactConfigPath,
    JSON.stringify({
      extends: configPath,
      compilerOptions: {
        paths: {
          ...paths,
          react: [path.join(hostRoot, "node_modules/@types/react")],
          "react/*": [path.join(hostRoot, "node_modules/@types/react/*")],
        },
      },
      files: [reactEntry],
    })
  );
  const [reactDeclaration] = generateDtsBundle(
    [
      {
        filePath: reactEntry,
        libraries: { importedLibraries: ["react"], allowedTypesLibraries: [] },
        output: { noBanner: true, exportReferencedTypes: false },
      },
    ],
    { preferredConfigPath: reactConfigPath }
  );
  if (!reactDeclaration) throw new Error("Website React declarations are empty");
  fs.writeFileSync(path.join(temporary, "connection.d.ts"), reactDeclaration);
  execFileSync(path.join(hostRoot, "node_modules/typescript/bin/tsc"), ["-p", validationConfig], {
    stdio: "inherit",
  });
  const reactCode = reactResult.outputFiles![0]!.contents;
  const reactDigest = createHash("sha256")
    .update(reactCode)
    .update(reactDeclaration)
    .update(runtimeVersion)
    .digest("hex");
  fs.mkdirSync(reactOutput, { recursive: true });
  fs.writeFileSync(path.join(reactOutput, "connection.js"), reactCode);
  fs.writeFileSync(path.join(reactOutput, "connection.d.ts"), reactDeclaration);
  fs.writeFileSync(
    path.join(reactOutput, "package.json"),
    JSON.stringify(
      {
        name: "@vibestudio/react",
        version: `0.1.0-website.${reactDigest.slice(0, 16)}`,
        type: "module",
        description: "Vibestudio React connection control for standalone websites",
        exports: { "./connection": { types: "./connection.d.ts", default: "./connection.js" } },
        peerDependencies: { "@workspace/runtime": runtimeVersion, react: "^19.0.0" },
        license: JSON.parse(fs.readFileSync(path.join(hostRoot, "package.json"), "utf8")).license,
        files: ["connection.js", "connection.d.ts", "README.md"],
      },
      null,
      2
    ) + "\n"
  );
  fs.writeFileSync(
    path.join(reactOutput, "README.md"),
    "# Vibestudio React connection\n\nInstall this package as `@workspace/react` alongside the matching runtime package installed as `@workspace/runtime` and your application's React 19. Import `{ WorkspaceConnection }` from `@workspace/react/connection`. This focused entry uses the application's runtime and React, never bundled copies. It renders connection status and explicit Connect/Disconnect actions; approval remains host-owned. Mounting does not connect and unmounting does not disconnect.\n"
  );
  console.log(
    JSON.stringify({
      directory: output,
      digest,
      bytes: code.length,
      declarationBytes: Buffer.byteLength(declaration),
    })
  );
} finally {
  projection.release();
  fs.rmSync(temporary, { recursive: true, force: true });
}
