/**
 * Build-local RPC documentation for workspace workers.
 *
 * This is deliberately derived from the exact materialized source state being
 * built. It is not a product census and never grants or attests authority: the
 * receiver's live `@rpc` declaration remains the enforcement boundary. Its
 * sealed authority projection is additionally consumed by static build
 * diagnostics so unchanged consumers are rechecked when this contract changes.
 */
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript/unstable/ast";
import type { AuthorityRequirement } from "@vibestudio/rpc";
import { usingTypeScriptProject } from "@vibestudio/typecheck";
import { BuildDiagnosticsError, type BuildDiagnostic } from "./diagnostics.js";
import type { Project, Symbol as TypeScriptSymbol } from "typescript/unstable/sync";

/** A malformed authored declaration, distinct from parser/IO failures. */
class WorkspaceRpcDeclarationError extends Error {}
import { sha256Canonical } from "@vibestudio/shared/authority/invocationSnapshot";
import type {
  UnitAuthorityManifest,
  UserlandCapabilityDefinition,
} from "@vibestudio/shared/authorityManifest";
import type { ServiceMethodSchemas } from "@vibestudio/shared/typedServiceClient";

export type WorkspaceRpcSchemaMetadata = Pick<
  ServiceMethodSchemas[string],
  "website" | "authority" | "tier" | "access" | "directEffect" | "execution" | "crossWorkspace"
> & {
  argsSchema: Record<string, unknown>;
  returnsSchema?: Record<string, unknown>;
  description?: string;
};

function authorityPrincipals(
  authority: NonNullable<ServiceMethodSchemas[string]["authority"]>
): string[] {
  if ("principals" in authority) return [...authority.principals];
  const principals = new Set<string>();
  const visit = (requirement: AuthorityRequirement): void => {
    if (requirement.kind === "capability") {
      principals.add(requirement.principal);
      return;
    }
    if (requirement.kind === "all" || requirement.kind === "any") {
      for (const child of requirement.requirements) visit(child);
    }
  };
  visit(authority.requirement);
  return [...principals].sort();
}

export interface WorkspaceRpcMethodDoc {
  className: string;
  name: string;
  signature: string;
  argsSchema?: Record<string, unknown>;
  returnsSchema?: Record<string, unknown>;
  argumentNames?: string[];
  description?: string;
  effect:
    | { kind: "open" }
    | {
        kind: "userland-capability";
        capability: string;
        resource: { kind: "receiver-object" } | { kind: "opaque-handle"; argument: number };
      }
    | {
        kind: "host-capability";
        capability: string;
        resource: { kind: "receiver-object" };
      };
  website: import("@vibestudio/rpc").WebsiteMethodPolicy;
  access?: {
    principals?: string[];
    tier?: "open" | "gated" | "critical";
    sensitivity?: "read" | "write" | "admin" | "destructive";
    codeOnly?: boolean;
    crossWorkspace?: boolean;
  };
  execution?: { harness: "attested-system-test" };
  inputContractDigest: string;
  producesHandle?: {
    localName: string;
    canonicalCapability: string;
    definitionDigest: string;
    resourceType: string;
  };
  /** Extractor-only local name; removed before the sealed catalog is returned. */
  _handleCapability?: string;
  userlandCapability?: {
    localName: string;
    canonicalCapability: string;
    definitionDigest: string;
    resourceType: string;
    grantScopes: UserlandCapabilityDefinition["grantScopes"];
    title: string;
    action: string;
    description?: string;
  };
}

type PolicyFields = ReadonlyMap<string, ts.Node>;

/**
 * Reads one `@rpc` policy without running provider code. Each field is written
 * inline or names a module-level `const` in the same file (optionally with
 * `as const` or `satisfies`), and an object may spread such a constant.
 * Anything that is not statically resolvable is a declaration error, never a
 * silently omitted field.
 */
class StaticRpcPolicy {
  constructor(
    private readonly project: Project,
    private readonly source: ts.SourceFile,
    readonly label: string
  ) {}

  /** One object's own fields, with spreads and constant references resolved. */
  fields(node: ts.Node | undefined, what: string): PolicyFields {
    const object = node ? this.expression(node) : undefined;
    if (!object || !ts.isObjectLiteralExpression(object)) {
      throw new WorkspaceRpcDeclarationError(`${this.label} ${what} must be a static object`);
    }
    const fields = new Map<string, ts.Node>();
    for (const property of object.properties) {
      if (ts.isSpreadAssignment(property)) {
        for (const [name, value] of this.fields(property.expression, what)) fields.set(name, value);
      } else if (ts.isShorthandPropertyAssignment(property)) {
        fields.set(property.name.getText(this.source), property);
      } else if (
        ts.isPropertyAssignment(property) &&
        (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
      ) {
        fields.set(property.name.text, property.initializer);
      } else {
        throw new WorkspaceRpcDeclarationError(
          `${this.label} ${what} has a member that is not statically resolvable`
        );
      }
    }
    return fields;
  }

  string(node: ts.Node | undefined): string | null {
    const value = node ? this.expression(node) : undefined;
    return value && ts.isStringLiteralLikeNode(value) ? value.text : null;
  }

  boolean(node: ts.Node | undefined): boolean | null {
    const value = node ? this.expression(node) : undefined;
    if (value?.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (value?.kind === ts.SyntaxKind.FalseKeyword) return false;
    return null;
  }

  integer(node: ts.Node | undefined): number | null {
    const value = node ? this.expression(node) : undefined;
    return value && ts.isNumericLiteral(value) ? Number(value.text) : null;
  }

  strings(node: ts.Node | undefined): string[] | null {
    const value = node ? this.expression(node) : undefined;
    if (!value || !ts.isArrayLiteralExpression(value)) return null;
    const strings = value.elements.map((element) => this.string(element));
    return strings.every((entry): entry is string => entry !== null) ? strings : null;
  }

  /** Strip value-preserving syntax and follow module-level constants. */
  private expression(node: ts.Node): ts.Node {
    const seen = new Set<number>();
    let current = node;
    for (;;) {
      if (
        ts.isParenthesizedExpression(current) ||
        ts.isAsExpression(current) ||
        ts.isSatisfiesExpression(current)
      ) {
        current = current.expression;
        continue;
      }
      if (!ts.isIdentifier(current) && !ts.isShorthandPropertyAssignment(current)) return current;
      const declaration = this.moduleConstant(current);
      if (seen.has(declaration.pos)) {
        throw new WorkspaceRpcDeclarationError(`${this.label} policy constants are circular`);
      }
      seen.add(declaration.pos);
      current = declaration.initializer!;
    }
  }

  private moduleConstant(
    reference: ts.Identifier | ts.ShorthandPropertyAssignment
  ): ts.VariableDeclaration {
    const checker = this.project.checker;
    const symbol: TypeScriptSymbol | undefined = ts.isShorthandPropertyAssignment(reference)
      ? checker.getShorthandAssignmentValueSymbol(reference)
      : checker.getSymbolAtLocation(reference);
    const declarations =
      symbol?.declarations.flatMap((handle) => {
        const declaration = handle.resolve(this.project);
        return declaration ? [declaration] : [];
      }) ?? [];
    const declaration = declarations.length === 1 ? declarations[0] : undefined;
    const list = declaration?.parent;
    if (
      declaration &&
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      list &&
      ts.isVariableDeclarationList(list) &&
      (list.flags & ts.NodeFlags.Const) !== 0 &&
      ts.isVariableStatement(list.parent) &&
      ts.isSourceFile(list.parent.parent) &&
      list.parent.parent.fileName === this.source.fileName
    ) {
      return declaration;
    }
    const name = ts.isShorthandPropertyAssignment(reference)
      ? reference.name.getText(this.source)
      : reference.getText(this.source);
    throw new WorkspaceRpcDeclarationError(
      `${this.label} references ${name}, which is not a module-level const in this file; ` +
        "RPC policy must be statically resolvable"
    );
  }
}

function handleProductionOf(
  policy: StaticRpcPolicy,
  fields: PolicyFields
): { capability: string } | undefined {
  const produces = fields.get("produces");
  if (!produces) return undefined;
  const source = policy.fields(produces, "handle production");
  const kind = policy.string(source.get("kind"));
  const capability = policy.string(source.get("capability"));
  const label = policy.label;
  if (
    source.size !== 2 ||
    kind !== "opaque-handle" ||
    !capability ||
    capability.startsWith("rpc:")
  ) {
    throw new WorkspaceRpcDeclarationError(
      `${label} has an invalid opaque-handle producer declaration`
    );
  }
  return { capability };
}

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const SKIPPED_FILE = /(?:^|\.|-)(?:test|spec)\.[cm]?tsx?$/u;

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (
        entry.isFile() &&
        SOURCE_EXTENSIONS.has(path.extname(entry.name)) &&
        !SKIPPED_FILE.test(entry.name) &&
        !entry.name.endsWith(".d.ts")
      ) {
        files.push(absolute);
      }
    }
  };
  visit(root);
  return files.sort();
}

function rpcDecorator(
  method: ts.MethodDeclaration
): { kind: "rpc" | "schemaRpc"; call: ts.CallExpression } | null {
  const decorators = method.modifiers?.filter(ts.isDecorator);
  for (const decorator of decorators ?? []) {
    if (!ts.isCallExpression(decorator.expression)) continue;
    const callee = decorator.expression.expression;
    const name = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : null;
    if (name === "rpc" || name === "schemaRpc") {
      return { kind: name, call: decorator.expression };
    }
  }
  return null;
}

function effectResourceOf(
  policy: StaticRpcPolicy,
  effect: PolicyFields
): Extract<WorkspaceRpcMethodDoc["effect"], { kind: "userland-capability" }>["resource"] {
  const label = policy.label;
  const node = effect.get("resource");
  if (!node) {
    throw new WorkspaceRpcDeclarationError(
      `${label} protected effect must declare a static resource selector`
    );
  }
  const resource = policy.fields(node, "effect resource selector");
  const kind = policy.string(resource.get("kind"));
  if (kind === "receiver-object" && resource.size === 1) return { kind };
  if (kind === "opaque-handle") {
    const argument = policy.integer(resource.get("argument")) ?? -1;
    if (resource.size === 2 && Number.isSafeInteger(argument) && argument >= 0) {
      return { kind, argument };
    }
  }
  throw new WorkspaceRpcDeclarationError(`${label} has an invalid static resource selector`);
}

function websitePolicyOf(
  policy: StaticRpcPolicy,
  fields: PolicyFields
): WorkspaceRpcMethodDoc["website"] {
  const label = policy.label;
  const node = fields.get("website");
  if (!node) {
    throw new WorkspaceRpcDeclarationError(`${label} requires a static website exposure decision`);
  }
  const website = policy.fields(node, "website exposure decision");
  const kind = policy.string(website.get("kind"));
  const reason = policy.string(website.get("reason"));
  const rationale = policy.string(website.get("rationale"));
  if (kind === "closed" && reason?.trim()) return { kind, reason };
  if (kind === "eligible" && rationale?.trim()) return { kind, rationale };
  throw new WorkspaceRpcDeclarationError(
    `${label} requires an explained website exposure decision`
  );
}

const RPC_TIERS = ["open", "gated", "critical"] as const;
const RPC_SENSITIVITIES = ["read", "write", "admin", "destructive"] as const;

function accessOf(policy: StaticRpcPolicy, fields: PolicyFields): WorkspaceRpcMethodDoc["access"] {
  const label = policy.label;
  const access: NonNullable<WorkspaceRpcMethodDoc["access"]> = {};
  if (fields.has("principals")) {
    const principals = policy.strings(fields.get("principals"));
    if (!principals) {
      throw new WorkspaceRpcDeclarationError(
        `${label} principals must be a static array of principal names`
      );
    }
    access.principals = principals;
  }
  if (fields.has("requires")) {
    if (access.principals) {
      throw new WorkspaceRpcDeclarationError(
        `${label} declares both principals and requires; declare exactly one`
      );
    }
  }
  if (fields.has("tier")) {
    const tier = policy.string(fields.get("tier"));
    if (!RPC_TIERS.includes(tier as never)) {
      throw new WorkspaceRpcDeclarationError(`${label} tier must be a static RPC tier`);
    }
    access.tier = tier as (typeof RPC_TIERS)[number];
  }
  if (fields.has("sensitivity")) {
    const sensitivity = policy.string(fields.get("sensitivity"));
    if (!RPC_SENSITIVITIES.includes(sensitivity as never)) {
      throw new WorkspaceRpcDeclarationError(`${label} sensitivity must be a static sensitivity`);
    }
    access.sensitivity = sensitivity as (typeof RPC_SENSITIVITIES)[number];
  }
  for (const flag of ["crossWorkspace", "codeOnly"] as const) {
    if (!fields.has(flag)) continue;
    const value = policy.boolean(fields.get(flag));
    if (value === null) {
      throw new WorkspaceRpcDeclarationError(`${label} ${flag} must be a static boolean`);
    }
    access[flag] = value;
  }
  return Object.keys(access).length > 0 ? access : undefined;
}

function effectOf(policy: StaticRpcPolicy, fields: PolicyFields): WorkspaceRpcMethodDoc["effect"] {
  const label = policy.label;
  const node = fields.get("effect");
  if (!node) throw new WorkspaceRpcDeclarationError(`${label} must declare a static RPC effect`);
  const effect = policy.fields(node, "RPC effect");
  const kind = policy.string(effect.get("kind"));
  if (kind === "open") return { kind };
  if (kind === "userland-capability" || kind === "host-capability") {
    const capability = policy.string(effect.get("capability"));
    if (capability && !capability.startsWith("rpc:")) {
      const resource = effectResourceOf(policy, effect);
      if (kind === "host-capability" && resource.kind !== "receiver-object") {
        throw new WorkspaceRpcDeclarationError(
          `${label} host capability must select the receiver object`
        );
      }
      return kind === "host-capability"
        ? { kind, capability, resource: { kind: "receiver-object" } }
        : { kind, capability, resource };
    }
  }
  throw new WorkspaceRpcDeclarationError(`${label} has an invalid static RPC effect`);
}

function methodName(method: ts.MethodDeclaration): string | null {
  if (ts.isIdentifier(method.name) || ts.isStringLiteral(method.name)) return method.name.text;
  return null;
}

function methodDescription(method: ts.MethodDeclaration): string | undefined {
  for (const doc of method.jsDoc ?? []) {
    if (!ts.isJSDoc(doc)) continue;
    const rendered = ts.getTextOfJSDocComment(doc.comment)?.trim();
    if (rendered) return rendered;
  }
  return undefined;
}

function signatureOf(method: ts.MethodDeclaration, source: ts.SourceFile): string {
  const typeParameters = method.typeParameters?.map((p) => p.getText(source)).join(", ");
  const params = method.parameters.map((p) => p.getText(source)).join(", ");
  const returns = method.type?.getText(source) ?? "unknown";
  return `${methodName(method) ?? "<computed>"}${typeParameters ? `<${typeParameters}>` : ""}(${params}): ${returns}`;
}

/**
 * The entry points whose value exports are module-level runtime clients, bound
 * to the initialized panel, plain worker, or eval runtime. A Durable Object
 * must use its own instance clients (`this.rpc`, `this.fs`, …), which carry the
 * object's identity and the current invocation's authority.
 */
const MODULE_RUNTIME_ENTRIES = new Set(["@workspace/runtime", "@workspace/runtime/worker"]);

/** A value (not type-only) import or re-export from a module-level runtime entry. */
function moduleRuntimeValueImport(
  statement: ts.Statement
): { node: ts.Node; specifier: string } | null {
  const found = (node: ts.Node | undefined, specifier: string) =>
    node ? { node, specifier } : null;
  if (ts.isImportDeclaration(statement)) {
    const specifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(specifier) || !MODULE_RUNTIME_ENTRIES.has(specifier.text)) return null;
    const clause = statement.importClause;
    // A bare `import "@workspace/runtime"` initializes the module runtime.
    if (!clause || clause.name) return found(statement, specifier.text);
    if (clause.phaseModifier === ts.SyntaxKind.TypeKeyword || !clause.namedBindings) return null;
    if (!ts.isNamedImports(clause.namedBindings)) return found(statement, specifier.text);
    return found(
      clause.namedBindings.elements.find((element) => !element.isTypeOnly),
      specifier.text
    );
  }
  if (ts.isExportDeclaration(statement)) {
    const specifier = statement.moduleSpecifier;
    if (
      !specifier ||
      !ts.isStringLiteral(specifier) ||
      !MODULE_RUNTIME_ENTRIES.has(specifier.text) ||
      statement.isTypeOnly
    ) {
      return null;
    }
    const clause = statement.exportClause;
    if (!clause || !ts.isNamedExports(clause)) return found(statement, specifier.text);
    return found(
      clause.elements.find((element) => !element.isTypeOnly),
      specifier.text
    );
  }
  return null;
}

/** Extract `@rpc` public method docs from one exact materialized worker package. */
export function collectWorkspaceRpcCatalog(
  workerSourcePath: string,
  input: {
    provider: string;
    authority: UnitAuthorityManifest;
    rpcSchemas?: Readonly<Record<string, Readonly<Record<string, WorkspaceRpcSchemaMetadata>>>>;
    /**
     * The package declares Durable Object classes. Its sources must not use
     * module-level runtime clients, which are not bound to an object.
     */
    durableObjects?: boolean;
  },
  tsserverPath?: string
): WorkspaceRpcMethodDoc[] {
  const absoluteWorkerSourcePath = path.resolve(workerSourcePath);
  const methods: WorkspaceRpcMethodDoc[] = [];
  const diagnostics: BuildDiagnostic[] = [];
  const files = sourceFiles(absoluteWorkerSourcePath);
  const sources = files.map((file) => ({ fileName: file, content: fs.readFileSync(file, "utf8") }));
  usingTypeScriptProject(
    sources,
    (project) => {
      for (const file of files) {
        const source = project.program.getSourceFile(file);
        if (!source) throw new Error(`TypeScript did not parse ${file}`);
        if (input.durableObjects) {
          for (const statement of source.statements) {
            const offending = moduleRuntimeValueImport(statement);
            if (!offending) continue;
            const position = source.getLineAndCharacterOfPosition(offending.node.getStart(source));
            diagnostics.push({
              source: "authority",
              severity: "error",
              file,
              line: position.line + 1,
              column: position.character + 1,
              message: `${input.provider} declares Durable Object classes but imports a module-level runtime client from "${offending.specifier}"; those clients are bound to a panel, plain worker, or eval runtime, not to this object.`,
              suggestion:
                "Use the object's own clients (this.rpc, this.fs, this.credentials, this.notifications, this.blobstore) and the PanelDurableObjectBase instance methods. Import base classes from @workspace/runtime/worker/kernel, /worker/durable-base, or /worker/panel-durable-base; type-only imports are fine. See skills/workspace-dev/WORKERS.md.",
            });
          }
        }
        const visit = (node: ts.Node): void => {
          if (ts.isClassDeclaration(node) && node.name) {
            for (const member of node.members) {
              if (!ts.isMethodDeclaration(member)) continue;
              const decorator = rpcDecorator(member);
              const name = methodName(member);
              if (!decorator || !name) continue;
              const description = methodDescription(member);
              const label = `${path.relative(absoluteWorkerSourcePath, file)}:${name}`;
              let access: WorkspaceRpcMethodDoc["access"];
              let website: WorkspaceRpcMethodDoc["website"];
              let effect: WorkspaceRpcMethodDoc["effect"];
              let execution: WorkspaceRpcMethodDoc["execution"];
              let handleProduction: { capability: string } | undefined;
              let schemaContract: WorkspaceRpcSchemaMetadata | undefined;
              const collectDeclaration = <T>(
                read: () => T,
                suggestion?: string
              ): { value: T } | null => {
                try {
                  return { value: read() };
                } catch (error) {
                  if (!(error instanceof WorkspaceRpcDeclarationError)) throw error;
                  const position = source.getLineAndCharacterOfPosition(member.getStart(source));
                  diagnostics.push({
                    source: "schema",
                    severity: "error",
                    file,
                    line: position.line + 1,
                    column: position.character + 1,
                    message: error.message,
                    ...(suggestion ? { suggestion } : {}),
                  });
                  return null;
                }
              };
              try {
                if (decorator.kind === "schemaRpc") {
                  const schema = input.rpcSchemas?.[node.name.text]?.[name];
                  if (!schema) {
                    throw new WorkspaceRpcDeclarationError(
                      `${input.provider}:${node.name.text}.${name} uses @schemaRpc without a manifest-bound typed receiver schema`
                    );
                  }
                  schemaContract = schema;
                  const principals = schema.authority ? authorityPrincipals(schema.authority) : [];
                  if (
                    principals.length === 0 ||
                    !schema.tier ||
                    !schema.access?.sensitivity ||
                    !schema.directEffect
                  ) {
                    throw new WorkspaceRpcDeclarationError(
                      `${label} has an incomplete typed receiver authority declaration`
                    );
                  }
                  access = {
                    principals,
                    tier: schema.tier.tier,
                    sensitivity: schema.access.sensitivity,
                    ...(schema.tier.session === "codeOnly" ? { codeOnly: true } : {}),
                    ...(schema.crossWorkspace === true ? { crossWorkspace: true } : {}),
                  };
                  website = schema.website;
                  effect = schema.directEffect;
                  execution = schema.execution;
                } else {
                  // These fields are independent. Diagnose each, but never publish
                  // a partial method contract or infer an exposure/effect decision.
                  const policy = new StaticRpcPolicy(project, source, label);
                  const fieldsResult = collectDeclaration(() =>
                    policy.fields(decorator.call.arguments[0], "RPC policy")
                  );
                  if (!fieldsResult) continue;
                  const fields = fieldsResult.value;
                  const websiteResult = collectDeclaration(
                    () => websitePolicyOf(policy, fields),
                    'Declare a static website policy: { kind: "closed", reason: "..." } or { kind: "eligible", rationale: "..." }, inline or as a module-level const. Choose the exposure intentionally; see skills/workspace-dev/WORKERS.md.'
                  );
                  const accessResult = collectDeclaration(() => accessOf(policy, fields));
                  const effectResult = collectDeclaration(
                    () => effectOf(policy, fields),
                    'Declare a static effect: { kind: "open" } for a method with no protected effect, or { kind: "userland-capability", capability: "...", resource: ... } matching authority.provides. This does not replace service-target authorization; see skills/workspace-dev/WORKERS.md.'
                  );
                  const handleResult = collectDeclaration(() => handleProductionOf(policy, fields));
                  if (!websiteResult || !accessResult || !effectResult || !handleResult) continue;
                  website = websiteResult.value;
                  access = accessResult.value;
                  effect = effectResult.value;
                  handleProduction = handleResult.value;
                }
                methods.push({
                  website,
                  className: node.name.text,
                  name,
                  signature: signatureOf(member, source),
                  inputContractDigest: sha256Canonical({
                    signature: signatureOf(member, source),
                    ...(schemaContract ? { argsSchema: schemaContract.argsSchema } : {}),
                  }),
                  ...(schemaContract
                    ? {
                        argsSchema: schemaContract.argsSchema,
                        ...(schemaContract.returnsSchema
                          ? { returnsSchema: schemaContract.returnsSchema }
                          : {}),
                        ...(member.parameters.every((parameter) => ts.isIdentifier(parameter.name))
                          ? {
                              argumentNames: member.parameters.map((parameter) =>
                                parameter.name.getText(source)
                              ),
                            }
                          : {}),
                      }
                    : {}),
                  effect,
                  ...(handleProduction ? { _handleCapability: handleProduction.capability } : {}),
                  ...((schemaContract?.description ?? description)
                    ? { description: schemaContract?.description ?? description }
                    : {}),
                  ...(access ? { access } : {}),
                  ...(execution ? { execution } : {}),
                });
              } catch (error) {
                if (!(error instanceof WorkspaceRpcDeclarationError)) throw error;
                const position = source.getLineAndCharacterOfPosition(member.getStart(source));
                diagnostics.push({
                  source: "schema",
                  severity: "error",
                  file,
                  line: position.line + 1,
                  column: position.character + 1,
                  message: error.message,
                });
              }
            }
          }
        };
        // Provider packages can contain generated expressions with thousands of
        // nested syntax nodes. Recursive descent makes catalog extraction depend
        // on the JavaScript call-stack limit even though TypeScript parsed the
        // file successfully. Walk the same tree iteratively so exact authority
        // analysis remains total for valid source.
        const pending: ts.Node[] = [source];
        while (pending.length > 0) {
          const node = pending.pop()!;
          visit(node);
          const children: ts.Node[] = [];
          node.forEachChild((child) => {
            children.push(child);
          });
          for (let index = children.length - 1; index >= 0; index -= 1) {
            pending.push(children[index]!);
          }
        }
      }
    },
    { tsserverPath }
  );
  if (diagnostics.length > 0) {
    throw new BuildDiagnosticsError(
      `${diagnostics[0]!.message}${diagnostics.length > 1 ? `; ${diagnostics.length - 1} additional declaration errors` : ""}`,
      diagnostics
    );
  }
  const sorted = methods.sort(
    (a, b) => a.className.localeCompare(b.className) || a.name.localeCompare(b.name)
  );
  try {
    sealUserlandCapabilities(sorted, input);
  } catch (error) {
    if (!(error instanceof WorkspaceRpcDeclarationError)) throw error;
    throw new BuildDiagnosticsError(error.message, [
      {
        source: "authority",
        severity: "error",
        file: path.join(absoluteWorkerSourcePath, "package.json"),
        line: 1,
        column: 1,
        message: error.message,
      },
    ]);
  }
  return sorted;
}

function sealUserlandCapabilities(
  methods: WorkspaceRpcMethodDoc[],
  input: { provider: string; authority: UnitAuthorityManifest }
): void {
  const definitions = new Map(
    input.authority.provides.map((definition) => [definition.name, definition])
  );
  const bindings = new Map<string, WorkspaceRpcMethodDoc[]>();
  const producers = new Map<string, WorkspaceRpcMethodDoc[]>();
  for (const method of methods) {
    if (method._handleCapability) {
      if (!definitions.has(method._handleCapability)) {
        throw new WorkspaceRpcDeclarationError(
          `${input.provider}:${method.className}.${method.name} produces undeclared userland capability ${method._handleCapability}`
        );
      }
      const current = producers.get(method._handleCapability) ?? [];
      current.push(method);
      producers.set(method._handleCapability, current);
    }
    if (method.effect.kind === "host-capability") {
      throw new WorkspaceRpcDeclarationError(
        `${input.provider}:${method.className}.${method.name} cannot declare a host-owned capability`
      );
    }
    if (method.effect.kind === "open") {
      if (method.access?.tier !== "open") {
        throw new WorkspaceRpcDeclarationError(
          `${input.provider}:${method.className}.${method.name} has an open effect but is not open-tier`
        );
      }
      continue;
    }
    const definition = definitions.get(method.effect.capability);
    if (!definition) {
      throw new WorkspaceRpcDeclarationError(
        `${input.provider}:${method.className}.${method.name} references undeclared userland capability ${method.effect.capability}`
      );
    }
    if (
      method.access?.tier !== definition.tier ||
      method.access?.sensitivity !== definition.sensitivity
    ) {
      throw new WorkspaceRpcDeclarationError(
        `${input.provider}:${method.className}.${method.name} authority does not match ` +
          `the sealed ${definition.name} definition`
      );
    }
    const current = bindings.get(definition.name) ?? [];
    current.push(method);
    bindings.set(definition.name, current);
  }
  for (const definition of input.authority.provides) {
    const bound = bindings.get(definition.name);
    if (!bound || bound.length === 0) {
      throw new WorkspaceRpcDeclarationError(
        `${input.provider} provides ${definition.name}, but no production RPC method binds it`
      );
    }
    const producing = producers.get(definition.name) ?? [];
    if (
      producing.length > 0 &&
      !bound.some(
        (method) =>
          method.effect.kind === "userland-capability" &&
          method.effect.resource.kind === "opaque-handle"
      )
    ) {
      throw new WorkspaceRpcDeclarationError(
        `${input.provider} produces handles for ${definition.name}, but no RPC method consumes them`
      );
    }
    const definitionDigest = sha256Canonical({
      definition,
      bindings: bound.map((method) => ({
        className: method.className,
        method: method.name,
        resource: method.effect.kind === "userland-capability" ? method.effect.resource : null,
        inputContractDigest: method.inputContractDigest,
      })),
      producers: producing.map((method) => ({
        className: method.className,
        method: method.name,
        inputContractDigest: method.inputContractDigest,
      })),
    });
    const canonicalCapability = `userland:${input.provider}/${definition.name}#${definitionDigest}`;
    for (const method of bound) {
      method.userlandCapability = {
        localName: definition.name,
        canonicalCapability,
        definitionDigest,
        resourceType: definition.resourceType,
        grantScopes: definition.grantScopes,
        title: definition.title,
        action: definition.action,
        ...(definition.description ? { description: definition.description } : {}),
      };
    }
    for (const method of producing) {
      method.producesHandle = {
        localName: definition.name,
        canonicalCapability,
        definitionDigest,
        resourceType: definition.resourceType,
      };
    }
  }
  for (const method of methods) delete method._handleCapability;
}
