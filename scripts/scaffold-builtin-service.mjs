#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const [slug, className, protocol, builtinBecause] = process.argv.slice(2);
if (
  !slug ||
  !/^[a-z][a-z0-9-]*$/.test(slug) ||
  !className ||
  !/^[A-Z][A-Za-z0-9]*DO$/.test(className) ||
  !protocol ||
  !/^vibestudio\.[a-z0-9.-]+\.v1$/.test(protocol) ||
  !["feeds-authority", "durable-data", "recovery-path"].includes(builtinBecause)
) {
  console.error(
    "Usage: pnpm scaffold:builtin-service <kebab-name> <PascalDO> <vibestudio.protocol.v1> <feeds-authority|durable-data|recovery-path>"
  );
  process.exit(1);
}

const schemaIdentifier = `${slug.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())}Methods`;
const capability = `builtin.${slug}.use`;
const implementation = `@panticonic/builtin/${slug}`;
const directory = path.join(root, "packages", "builtin", slug);
const schemaPath = path.join(root, "packages", "service-schemas", "src", `${slug}.ts`);
if (fs.existsSync(directory) || fs.existsSync(schemaPath)) {
  throw new Error(`Builtin service ${slug} already exists`);
}

fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(
  path.join(directory, "index.ts"),
  `export { ${className} } from "./${className}.js";\n`
);
fs.writeFileSync(
  path.join(directory, `${className}.ts`),
  `import { DurableObjectBase, rpc, type DurableObjectContext } from "@vibestudio/durable";
import { ${schemaIdentifier} } from "@vibestudio/service-schemas/${slug}";

export class ${className} extends DurableObjectBase {
  static override rpcMethods = ${schemaIdentifier};

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);
    this.ensureReady();
  }

  protected createTables(): void {}

  @rpc({
    principals: ["host", "user", "code"],
    effect: { kind: "host-capability", capability: "${capability}", resource: { kind: "receiver-object" } },
    tier: "gated",
    sensitivity: "read",
  })
  ping(): { ok: true } {
    return { ok: true };
  }
}
`
);
fs.writeFileSync(
  schemaPath,
  `import { z } from "zod";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";

export const ${schemaIdentifier} = defineServiceMethods({
  ping: {
    description: "Verify that the builtin service is reachable.",
    args: z.tuple([]),
    returns: z.object({ ok: z.literal(true) }).strict(),
    capability: "${capability}",
    authority: { principals: ["host", "user", "code"] },
    tier: {
      tier: "gated",
      session: "family",
      rationale: "New builtin methods begin gated until their authority review is explicit.",
    },
    access: { sensitivity: "read" },
  },
});
`
);

const packagePath = path.join(root, "packages", "builtin", "package.json");
const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
packageJson.exports[`./${slug}`] = `./${slug}/index.ts`;
fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

const catalogPath = path.join(
  root,
  "packages",
  "service-schemas",
  "src",
  "productBuiltinServices.ts"
);
let catalog = fs.readFileSync(catalogPath, "utf8");
catalog = catalog.replace(
  "// BUILTIN_SCAFFOLD_IMPORTS",
  `import { ${schemaIdentifier} } from "./${slug}.js";\n// BUILTIN_SCAFFOLD_IMPORTS`
);
catalog = catalog.replace(
  "  // BUILTIN_SCAFFOLD_ENTRIES",
  `  {
    kind: "service",
    name: "${slug.replaceAll("-", ".")}",
    title: "${className.replace(/DO$/, "")}",
    description: "Use the product-owned ${slug} service.",
    action: "use ${slug}",
    presentation: { domain: "computer", verb: "manage" },
    principals: ["host", "user", "code"],
    protocol: "${protocol}",
    className: "${className}",
    implementation: "${implementation}",
    builtinBecause: "${builtinBecause}",
    methods: ${schemaIdentifier},
    durableObject: { keyVersion: 1, objectKey: "workspace", keyMode: "workspace-scoped" },
    workerd: {
      injectWorkspaceId: true,
      bootstrapPhase: "normal",
      staticAuthorityProjection: true,
      unsafeEval: false,
    },
    hostCapabilityRequests: [],
  },
  // BUILTIN_SCAFFOLD_ENTRIES`
);
fs.writeFileSync(catalogPath, catalog);

console.log(`Scaffolded ${slug}; review the generated capability and method contract.`);
console.log("Run pnpm generate:builtin-catalog && pnpm type-check:host.");
