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
import type tsTypes from "typescript";
import { sha256Canonical } from "@vibestudio/shared/authority/invocationSnapshot";
import type {
  UnitAuthorityManifest,
  UserlandCapabilityDefinition,
} from "@vibestudio/shared/authorityManifest";
import type { ServiceMethodSchemas } from "@vibestudio/shared/typedServiceClient";

let ts: typeof import("typescript");

async function loadTypescript(): Promise<typeof import("typescript")> {
  return (ts ??= await import("typescript"));
}

export interface WorkspaceRpcMethodDoc {
  className: string;
  name: string;
  signature: string;
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
  access?: {
    principals?: string[];
    tier?: "open" | "gated" | "critical";
    sensitivity?: "read" | "write" | "admin" | "destructive";
    codeOnly?: boolean;
  };
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

function handleProductionOf(
  call: tsTypes.CallExpression,
  label: string
): { capability: string } | undefined {
  const object = call.arguments[0];
  if (!object || !ts.isObjectLiteralExpression(object)) return undefined;
  const property = object.properties.find((candidate) => propertyName(candidate) === "produces");
  if (!property) return undefined;
  if (!ts.isPropertyAssignment(property) || !ts.isObjectLiteralExpression(property.initializer)) {
    throw new Error(`${label} handle production must be a literal object`);
  }
  const source = property.initializer;
  const kindProperty = source.properties.find((candidate) => propertyName(candidate) === "kind");
  const capabilityProperty = source.properties.find(
    (candidate) => propertyName(candidate) === "capability"
  );
  const kind =
    kindProperty && ts.isPropertyAssignment(kindProperty)
      ? literalString(kindProperty.initializer)
      : null;
  const capability =
    capabilityProperty && ts.isPropertyAssignment(capabilityProperty)
      ? literalString(capabilityProperty.initializer)
      : null;
  if (
    source.properties.length !== 2 ||
    kind !== "opaque-handle" ||
    !capability ||
    capability.startsWith("rpc:")
  ) {
    throw new Error(`${label} has an invalid opaque-handle producer declaration`);
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
  method: tsTypes.MethodDeclaration
): { kind: "rpc" | "schemaRpc"; call: tsTypes.CallExpression } | null {
  const decorators = ts.canHaveDecorators(method) ? ts.getDecorators(method) : undefined;
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

function propertyName(node: tsTypes.ObjectLiteralElementLike): string | null {
  if (!ts.isPropertyAssignment(node) || !node.name) return null;
  if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) return node.name.text;
  return null;
}

function literalString(expression: tsTypes.Expression): string | null {
  return ts.isStringLiteralLike(expression) ? expression.text : null;
}

function effectResourceOf(
  object: tsTypes.ObjectLiteralExpression,
  label: string
): Extract<WorkspaceRpcMethodDoc["effect"], { kind: "userland-capability" }>["resource"] {
  const property = object.properties.find((candidate) => propertyName(candidate) === "resource");
  if (
    !property ||
    !ts.isPropertyAssignment(property) ||
    !ts.isObjectLiteralExpression(property.initializer)
  ) {
    throw new Error(`${label} protected effect must declare a literal resource selector`);
  }
  const resource = property.initializer;
  const kindProperty = resource.properties.find((candidate) => propertyName(candidate) === "kind");
  const kind =
    kindProperty && ts.isPropertyAssignment(kindProperty)
      ? literalString(kindProperty.initializer)
      : null;
  if (kind === "receiver-object" && resource.properties.length === 1) return { kind };
  if (kind === "opaque-handle") {
    const argumentProperty = resource.properties.find(
      (candidate) => propertyName(candidate) === "argument"
    );
    const argument =
      argumentProperty &&
      ts.isPropertyAssignment(argumentProperty) &&
      ts.isNumericLiteral(argumentProperty.initializer)
        ? Number(argumentProperty.initializer.text)
        : -1;
    if (resource.properties.length === 2 && Number.isSafeInteger(argument) && argument >= 0) {
      return { kind, argument };
    }
  }
  throw new Error(`${label} has an invalid literal resource selector`);
}

function accessOf(call: tsTypes.CallExpression): WorkspaceRpcMethodDoc["access"] {
  const object = call.arguments[0];
  if (!object || !ts.isObjectLiteralExpression(object)) return undefined;
  const access: NonNullable<WorkspaceRpcMethodDoc["access"]> = {};
  for (const property of object.properties) {
    const name = propertyName(property);
    if (!name || !ts.isPropertyAssignment(property)) continue;
    if (name === "principals" && ts.isArrayLiteralExpression(property.initializer)) {
      const values = property.initializer.elements
        .map((element) => literalString(element as tsTypes.Expression))
        .filter((value): value is string => value !== null);
      if (values.length === property.initializer.elements.length) access.principals = values;
    } else if (name === "tier") {
      const value = literalString(property.initializer);
      if (value === "open" || value === "gated" || value === "critical") access.tier = value;
    } else if (name === "sensitivity") {
      const value = literalString(property.initializer);
      if (value === "read" || value === "write" || value === "admin" || value === "destructive") {
        access.sensitivity = value;
      }
    } else if (name === "codeOnly") {
      if (property.initializer.kind === ts.SyntaxKind.TrueKeyword) access.codeOnly = true;
      if (property.initializer.kind === ts.SyntaxKind.FalseKeyword) access.codeOnly = false;
    }
  }
  return Object.keys(access).length > 0 ? access : undefined;
}

function effectOf(call: tsTypes.CallExpression, label: string): WorkspaceRpcMethodDoc["effect"] {
  const object = call.arguments[0];
  if (!object || !ts.isObjectLiteralExpression(object)) {
    throw new Error(`${label} must declare a literal RPC effect`);
  }
  const property = object.properties.find((candidate) => propertyName(candidate) === "effect");
  if (
    !property ||
    !ts.isPropertyAssignment(property) ||
    !ts.isObjectLiteralExpression(property.initializer)
  ) {
    throw new Error(`${label} must declare a literal RPC effect`);
  }
  const kindProperty = property.initializer.properties.find(
    (candidate) => propertyName(candidate) === "kind"
  );
  const kind =
    kindProperty && ts.isPropertyAssignment(kindProperty)
      ? literalString(kindProperty.initializer)
      : null;
  if (kind === "open") return { kind };
  if (kind === "userland-capability" || kind === "host-capability") {
    const capabilityProperty = property.initializer.properties.find(
      (candidate) => propertyName(candidate) === "capability"
    );
    const capability =
      capabilityProperty && ts.isPropertyAssignment(capabilityProperty)
        ? literalString(capabilityProperty.initializer)
        : null;
    if (capability && !capability.startsWith("rpc:")) {
      const resource = effectResourceOf(property.initializer, label);
      if (kind === "host-capability" && resource.kind !== "receiver-object") {
        throw new Error(`${label} host capability must select the receiver object`);
      }
      return kind === "host-capability"
        ? { kind, capability, resource: { kind: "receiver-object" } }
        : { kind, capability, resource };
    }
  }
  throw new Error(`${label} has an invalid literal RPC effect`);
}

function methodName(method: tsTypes.MethodDeclaration): string | null {
  if (ts.isIdentifier(method.name) || ts.isStringLiteral(method.name)) return method.name.text;
  return null;
}

function methodDescription(method: tsTypes.MethodDeclaration): string | undefined {
  for (const doc of ts.getJSDocCommentsAndTags(method)) {
    if (!ts.isJSDoc(doc)) continue;
    if (typeof doc.comment === "string" && doc.comment.trim()) return doc.comment.trim();
    if (Array.isArray(doc.comment)) {
      const rendered = doc.comment
        .map((part: tsTypes.JSDocComment) => part.text)
        .join("")
        .trim();
      if (rendered) return rendered;
    }
  }
  return undefined;
}

function signatureOf(method: tsTypes.MethodDeclaration, source: tsTypes.SourceFile): string {
  const typeParameters = method.typeParameters?.map((p) => p.getText(source)).join(", ");
  const params = method.parameters.map((p) => p.getText(source)).join(", ");
  const returns = method.type?.getText(source) ?? "unknown";
  return `${methodName(method) ?? "<computed>"}${typeParameters ? `<${typeParameters}>` : ""}(${params}): ${returns}`;
}

/** Extract `@rpc` public method docs from one exact materialized worker package. */
export async function collectWorkspaceRpcCatalog(
  workerSourcePath: string,
  input: {
    provider: string;
    authority: UnitAuthorityManifest;
    rpcSchemas?: Readonly<Record<string, ServiceMethodSchemas>>;
  }
): Promise<WorkspaceRpcMethodDoc[]> {
  await loadTypescript();
  const methods: WorkspaceRpcMethodDoc[] = [];
  for (const file of sourceFiles(workerSourcePath)) {
    const text = fs.readFileSync(file, "utf8");
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );
    const visit = (node: tsTypes.Node): void => {
      if (ts.isClassDeclaration(node) && node.name) {
        for (const member of node.members) {
          if (!ts.isMethodDeclaration(member)) continue;
          const decorator = rpcDecorator(member);
          const name = methodName(member);
          if (!decorator || !name) continue;
          const description = methodDescription(member);
          const label = `${path.relative(workerSourcePath, file)}:${name}`;
          let access: WorkspaceRpcMethodDoc["access"];
          let effect: WorkspaceRpcMethodDoc["effect"];
          let handleProduction: { capability: string } | undefined;
          if (decorator.kind === "schemaRpc") {
            const schema = input.rpcSchemas?.[node.name.text]?.[name];
            if (!schema) {
              throw new Error(
                `${input.provider}:${node.name.text}.${name} uses @schemaRpc without a manifest-bound typed receiver schema`
              );
            }
            if (
              !schema.authority ||
              !("principals" in schema.authority) ||
              !schema.tier ||
              !schema.access?.sensitivity ||
              !schema.directEffect
            ) {
              throw new Error(`${label} has an incomplete typed receiver authority declaration`);
            }
            access = {
              principals: [...schema.authority.principals],
              tier: schema.tier.tier,
              sensitivity: schema.access.sensitivity,
              ...(schema.tier.session === "codeOnly" ? { codeOnly: true } : {}),
            };
            effect = schema.directEffect;
          } else {
            access = accessOf(decorator.call);
            effect = effectOf(decorator.call, label);
            handleProduction = handleProductionOf(decorator.call, label);
          }
          methods.push({
            className: node.name.text,
            name,
            signature: signatureOf(member, source),
            inputContractDigest: sha256Canonical({
              signature: signatureOf(member, source),
            }),
            effect,
            ...(handleProduction ? { _handleCapability: handleProduction.capability } : {}),
            ...(description ? { description } : {}),
            ...(access ? { access } : {}),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const sorted = methods.sort(
    (a, b) => a.className.localeCompare(b.className) || a.name.localeCompare(b.name)
  );
  sealUserlandCapabilities(sorted, input);
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
        throw new Error(
          `${input.provider}:${method.className}.${method.name} produces undeclared userland capability ${method._handleCapability}`
        );
      }
      const current = producers.get(method._handleCapability) ?? [];
      current.push(method);
      producers.set(method._handleCapability, current);
    }
    if (method.effect.kind === "host-capability") {
      throw new Error(
        `${input.provider}:${method.className}.${method.name} cannot declare a host-owned capability`
      );
    }
    if (method.effect.kind === "open") {
      if (method.access?.tier !== "open") {
        throw new Error(
          `${input.provider}:${method.className}.${method.name} has an open effect but is not open-tier`
        );
      }
      continue;
    }
    const definition = definitions.get(method.effect.capability);
    if (!definition) {
      throw new Error(
        `${input.provider}:${method.className}.${method.name} references undeclared userland capability ${method.effect.capability}`
      );
    }
    if (
      method.access?.tier !== definition.tier ||
      method.access?.sensitivity !== definition.sensitivity
    ) {
      throw new Error(
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
      throw new Error(
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
      throw new Error(
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
