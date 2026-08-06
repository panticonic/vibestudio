import * as path from "node:path";
import ts from "typescript";

export type AbstractString =
  | { kind: "literals"; values: ReadonlySet<string> }
  | { kind: "symbolic"; valueId: string }
  | { kind: "unknown" };

export type SymbolicArgumentValue =
  | { kind: "literals"; values: ReadonlySet<string> }
  | { kind: "service-call-result"; producerCallId: string }
  | { kind: "unknown" };

export interface WorkspaceServiceCallFact {
  id: string;
  kind: "resolution" | "invocation";
  serviceQueries: AbstractString;
  methods: AbstractString;
  objectKeys: AbstractString | { kind: "not-applicable" };
  arguments: readonly SymbolicArgumentValue[];
  origin: {
    unitName: string;
    package?: {
      kind: "workspace" | "external";
      name: string;
      versionOrEffectiveVersion: string;
      contentDigest: string;
    };
    file: string;
    line: number;
    column: number;
  };
}

export interface AuthorityFoldUnit {
  name: string;
  relativePath: string;
  effectiveVersion?: string;
  packageDigest?: string;
  package?: {
    kind: "workspace" | "external";
    name: string;
    versionOrEffectiveVersion: string;
    contentDigest: string;
  };
}

export interface AnalyzeWorkspaceServiceCallsInput {
  program: ts.Program;
  sourceRoot: string;
  unitRelativePath: string;
  units: readonly AuthorityFoldUnit[];
  executableModules?: readonly {
    moduleId: string;
    contentDigest: string;
    package:
      | { kind: "first-party" }
      | { kind: "workspace"; name: string; effectiveVersion: string }
      | { kind: "external"; name: string; version: string; packageDigest: string };
    format: "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs";
    source: string;
  }[];
}

interface ServiceValue {
  queries: AbstractString;
  objectKeys: AbstractString | { kind: "not-applicable" };
  client: boolean;
}

const RESOLVER_NAMES = new Set(["resolveService"]);
const CLIENT_FACTORY_NAMES = new Set([
  "durableObjectService",
  "createDurableObjectServiceClient",
  "connectViaRpc",
]);
const RPC_METHOD_NAMES = new Set(["call", "stream", "streamReadable"]);

function unionString(a: AbstractString, b: AbstractString): AbstractString {
  if (a.kind === "unknown" || b.kind === "unknown") return { kind: "unknown" };
  if (a.kind === "symbolic" || b.kind === "symbolic") {
    if (a.kind === "symbolic" && b.kind === "symbolic" && a.valueId === b.valueId) return a;
    return { kind: "unknown" };
  }
  return { kind: "literals", values: new Set([...a.values, ...b.values]) };
}

function symbolKey(symbol: ts.Symbol | undefined): string | null {
  if (!symbol) return null;
  const declaration = symbol.declarations?.[0];
  return `${symbol.getName()}#${declaration?.getSourceFile().fileName ?? ""}:${declaration?.getStart() ?? -1}`;
}

function unalias(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): ts.Symbol | undefined {
  if (!symbol) return undefined;
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function literalStrings(
  checker: ts.TypeChecker,
  expression: ts.Expression
): ReadonlySet<string> | null {
  const type = checker.getTypeAtLocation(expression);
  const types = type.isUnion() ? type.types : [type];
  const values = new Set<string>();
  for (const member of types) {
    if ((member.flags & ts.TypeFlags.StringLiteral) !== 0) {
      values.add((member as ts.StringLiteralType).value);
      continue;
    }
    return null;
  }
  return values.size > 0 ? values : null;
}

function isRuntimeImportDeclaration(declaration: ts.Node): boolean {
  if (!ts.isImportSpecifier(declaration) && !ts.isImportClause(declaration)) return false;
  let importDeclaration: ts.Node | undefined = declaration.parent;
  while (importDeclaration && !ts.isImportDeclaration(importDeclaration)) {
    importDeclaration = importDeclaration.parent;
  }
  if (!ts.isImportDeclaration(importDeclaration)) return false;
  const specifier = importDeclaration.moduleSpecifier;
  return (
    ts.isStringLiteralLike(specifier) && /(?:^|\/)(?:runtime|workerd)(?:\/|$)/u.test(specifier.text)
  );
}

function isWorkspaceServiceImportDeclaration(declaration: ts.Node): boolean {
  if (!ts.isImportSpecifier(declaration) && !ts.isImportClause(declaration)) return false;
  let importDeclaration: ts.Node | undefined = declaration.parent;
  while (importDeclaration && !ts.isImportDeclaration(importDeclaration)) {
    importDeclaration = importDeclaration.parent;
  }
  if (!ts.isImportDeclaration(importDeclaration)) return false;
  const specifier = importDeclaration.moduleSpecifier;
  return (
    ts.isStringLiteralLike(specifier) &&
    (/(?:^|\/)workspaceServiceRpc$/u.test(specifier.text) ||
      /(?:^|\/)pubsub(?:\/|$)/u.test(specifier.text))
  );
}

function isPublicNamespace(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  expectedName: "workers" | "rpc" | "runtime"
): boolean {
  const rawSymbol = checker.getSymbolAtLocation(expression);
  if (rawSymbol?.declarations?.some(isRuntimeImportDeclaration)) return true;
  const symbol = unalias(checker, rawSymbol);
  if (!symbol || symbol.getName() !== expectedName) return false;
  const declarations = symbol.declarations ?? [];
  if (declarations.some(isRuntimeImportDeclaration)) return true;
  // Ambient declarations are how exact build tests and generated type
  // surfaces describe the runtime bridge. A local object literal with the
  // same spelling is intentionally not accepted.
  return declarations.some(
    (declaration) => ts.isVariableDeclaration(declaration) && !declaration.initializer
  );
}

function propertyCall(
  checker: ts.TypeChecker,
  call: ts.CallExpression,
  name: string
): ts.PropertyAccessExpression | null {
  if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== name) {
    return null;
  }
  return call.expression;
}

function callCalleeName(call: ts.CallExpression): string | null {
  if (ts.isIdentifier(call.expression)) return call.expression.text;
  if (ts.isPropertyAccessExpression(call.expression)) return call.expression.name.text;
  return null;
}

function isAwaitOrTransparent(expression: ts.Expression): ts.Expression {
  let current = expression;
  for (;;) {
    if (ts.isAwaitExpression(current)) current = current.expression;
    else if (ts.isParenthesizedExpression(current)) current = current.expression;
    else if (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)) {
      current = current.expression;
    } else if (ts.isNonNullExpression(current)) current = current.expression;
    else return current;
  }
}

function sourceCoordinate(
  sourceFile: ts.SourceFile,
  node: ts.Node
): { line: number; column: number } {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: position.line + 1, column: position.character + 1 };
}

function sourceUnitForFile(
  sourceRoot: string,
  fileName: string,
  units: readonly AuthorityFoldUnit[]
): AuthorityFoldUnit | undefined {
  const absolute = path.resolve(fileName);
  return [...units]
    .sort((a, b) => b.relativePath.length - a.relativePath.length)
    .find((unit) =>
      absolute.startsWith(`${path.resolve(sourceRoot, unit.relativePath)}${path.sep}`)
    );
}

/**
 * Walk a TypeScript AST without consuming the JavaScript call stack.
 *
 * Workspace authority analysis runs over the complete transitive source
 * closure. Generated or heavily nested userland code can be deeper than the
 * recursion limit even though TypeScript parsed it successfully. The
 * analyzer's result depends on visiting every node, so an explicit stack is
 * the correct boundary here rather than treating a stack overflow as an
 * un-analyzable consumer.
 */
function walkNodes(
  root: ts.Node,
  visit: (node: ts.Node) => void,
  shouldDescend: (node: ts.Node) => boolean = () => true
): void {
  const pending: ts.Node[] = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    visit(node);
    if (!shouldDescend(node)) continue;
    const children: ts.Node[] = [];
    ts.forEachChild(node, (child) => {
      children.push(child);
    });
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push(children[index]!);
    }
  }
}

function abstractString(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  resolve: (expression: ts.Expression, seen: Set<string>) => AbstractString,
  seen = new Set<string>()
): AbstractString {
  const current = isAwaitOrTransparent(expression);
  if (ts.isStringLiteralLike(current)) {
    return { kind: "literals", values: new Set([current.text]) };
  }
  const finite = literalStrings(checker, current);
  if (finite) return { kind: "literals", values: finite };
  return resolve(current, seen);
}

/**
 * Extract provider-independent service facts from the exact TypeScript
 * program. No provider catalog, capability definition, or resource identity
 * is consulted here, so this result remains valid when a provider changes.
 */
export function analyzeWorkspaceServiceCalls(
  input: AnalyzeWorkspaceServiceCallsInput
): WorkspaceServiceCallFact[] {
  const checker = input.program.getTypeChecker();
  const sourceFiles = input.program.getSourceFiles().filter((sourceFile) => {
    if (sourceFile.isDeclarationFile) return false;
    const file = path.resolve(sourceFile.fileName);
    return input.units.some((unit) => {
      const root = `${path.resolve(input.sourceRoot, unit.relativePath)}${path.sep}`;
      return file.startsWith(root);
    });
  });

  const declarationInitializers = new Map<string, ts.Expression>();
  const declarationFunctions = new Map<string, ts.FunctionLikeDeclaration>();
  for (const sourceFile of sourceFiles) {
    walkNodes(sourceFile, (node) => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const symbol = checker.getSymbolAtLocation(node.name);
        const key = symbolKey(unalias(checker, symbol));
        if (key) declarationInitializers.set(key, node.initializer);
        if (
          ts.isIdentifier(node.name) &&
          (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
        ) {
          if (key) declarationFunctions.set(key, node.initializer);
        }
      } else if (ts.isFunctionDeclaration(node) && node.name) {
        const symbol = checker.getSymbolAtLocation(node.name);
        const key = symbolKey(unalias(checker, symbol));
        if (key) declarationFunctions.set(key, node);
      }
    });
  }

  const serviceMemo = new Map<string, ServiceValue | null>();
  const serviceVisiting = new Set<string>();
  const functionVisiting = new Set<string>();
  const factsByNode = new Map<ts.CallExpression, WorkspaceServiceCallFact>();
  const allCalls: ts.CallExpression[] = [];
  for (const sourceFile of sourceFiles) {
    walkNodes(sourceFile, (node) => {
      if (ts.isCallExpression(node)) allCalls.push(node);
    });
  }

  const isResolverCall = (call: ts.CallExpression): boolean => {
    const property = propertyCall(checker, call, "resolveService");
    if (!property || !RESOLVER_NAMES.has(property.name.text)) return false;
    const receiver = property.expression;
    return (
      isPublicNamespace(checker, receiver, "workers") ||
      (ts.isPropertyAccessExpression(receiver) &&
        receiver.name.text === "workers" &&
        isPublicNamespace(checker, receiver.expression, "runtime"))
    );
  };

  const isFactoryCall = (call: ts.CallExpression): boolean => {
    const name = callCalleeName(call);
    if (!name || !CLIENT_FACTORY_NAMES.has(name)) return false;
    if (name === "connectViaRpc") return true;
    if (
      name === "durableObjectService" &&
      ts.isPropertyAccessExpression(call.expression) &&
      (isPublicNamespace(checker, call.expression.expression, "workers") ||
        (ts.isPropertyAccessExpression(call.expression.expression) &&
          call.expression.expression.name.text === "workers" &&
          isPublicNamespace(checker, call.expression.expression.expression, "runtime")))
    ) {
      return true;
    }
    const rawSymbol = checker.getSymbolAtLocation(call.expression);
    if (
      rawSymbol?.declarations?.some(
        (declaration) =>
          isRuntimeImportDeclaration(declaration) ||
          isWorkspaceServiceImportDeclaration(declaration)
      )
    ) {
      return true;
    }
    const symbol = unalias(checker, rawSymbol);
    if (!symbol) return false;
    return (
      symbol.declarations?.some(
        (declaration) =>
          isRuntimeImportDeclaration(declaration) ||
          isWorkspaceServiceImportDeclaration(declaration)
      ) ?? false
    );
  };

  const serviceValue = (
    expression: ts.Expression,
    seen = new Set<string>()
  ): ServiceValue | null => {
    const current = isAwaitOrTransparent(expression);
    if (ts.isCallExpression(current)) {
      if (isResolverCall(current)) {
        return {
          queries: abstractString(checker, current.arguments[0] ?? current, resolveString, seen),
          objectKeys:
            current.arguments.length > 1
              ? abstractString(checker, current.arguments[1]!, resolveString, seen)
              : { kind: "not-applicable" },
          client: false,
        };
      }
      if (isFactoryCall(current)) {
        if (callCalleeName(current) === "connectViaRpc") {
          const options = current.arguments[0];
          if (!options || !ts.isObjectLiteralExpression(options)) return null;
          const protocolProperty = options.properties.find(
            (candidate) =>
              ts.isPropertyAssignment(candidate) &&
              ts.isIdentifier(candidate.name) &&
              candidate.name.text === "protocol"
          );
          const channelProperty = options.properties.find(
            (candidate) =>
              ts.isPropertyAssignment(candidate) &&
              ts.isIdentifier(candidate.name) &&
              candidate.name.text === "channel"
          );
          return {
            queries:
              protocolProperty && ts.isPropertyAssignment(protocolProperty)
                ? abstractString(checker, protocolProperty.initializer, resolveString, seen)
                : { kind: "unknown" },
            objectKeys:
              channelProperty && ts.isPropertyAssignment(channelProperty)
                ? abstractString(checker, channelProperty.initializer, resolveString, seen)
                : { kind: "not-applicable" },
            client: true,
          };
        }
        const first = current.arguments[0];
        return {
          queries: abstractString(checker, first ?? current, resolveString, seen),
          objectKeys:
            current.arguments.length > 1
              ? abstractString(checker, current.arguments[1]!, resolveString, seen)
              : { kind: "not-applicable" },
          client: true,
        };
      }
      if (ts.isIdentifier(current.expression)) {
        const symbol = unalias(checker, checker.getSymbolAtLocation(current.expression));
        const key = symbolKey(symbol);
        const fn = key ? declarationFunctions.get(key) : undefined;
        if (fn && fn.body && key && !functionVisiting.has(key)) {
          functionVisiting.add(key);
          const returns: ServiceValue[] = [];
          try {
            // Returns nested inside a function declaration/expression belong to
            // that nested function, not to this one. Skipping nested function
            // bodies also keeps a recursive helper from expanding indefinitely.
            walkNodes(
              fn.body,
              (node) => {
                if (ts.isReturnStatement(node) && node.expression) {
                  const value = serviceValue(node.expression, seen);
                  if (value) returns.push(value);
                }
              },
              (node) => node === fn.body || !ts.isFunctionLike(node)
            );
          } finally {
            functionVisiting.delete(key);
          }
          if (returns.length > 0) {
            return returns.reduce((combined, value) => ({
              queries: unionString(combined.queries, value.queries),
              objectKeys:
                combined.objectKeys.kind === "not-applicable" ||
                value.objectKeys.kind === "not-applicable"
                  ? { kind: "not-applicable" }
                  : unionString(combined.objectKeys, value.objectKeys),
              client: combined.client || value.client,
            }));
          }
        }
      }
    }
    if (ts.isPropertyAccessExpression(current) && current.name.text === "targetId") {
      return serviceValue(current.expression, seen);
    }
    if (ts.isIdentifier(current)) {
      const symbol = unalias(checker, checker.getSymbolAtLocation(current));
      const key = symbolKey(symbol);
      if (!key || seen.has(key) || serviceVisiting.has(key)) return null;
      const memo = serviceMemo.get(key);
      if (memo !== undefined) return memo;
      const initializer = declarationInitializers.get(key);
      if (!initializer) return null;
      serviceVisiting.add(key);
      const value = serviceValue(initializer, new Set([...seen, key]));
      serviceVisiting.delete(key);
      serviceMemo.set(key, value);
      return value;
    }
    return null;
  };

  const resolveString = (
    expression: ts.Expression,
    seen: Set<string> = new Set<string>()
  ): AbstractString => {
    const current = isAwaitOrTransparent(expression);
    if (ts.isConditionalExpression(current)) {
      return unionString(
        abstractString(checker, current.whenTrue, resolveString, seen),
        abstractString(checker, current.whenFalse, resolveString, seen)
      );
    }
    if (ts.isIdentifier(current)) {
      const symbol = unalias(checker, checker.getSymbolAtLocation(current));
      const key = symbolKey(symbol);
      if (!key || seen.has(key)) return { kind: "unknown" };
      const initializer = declarationInitializers.get(key);
      if (initializer)
        return abstractString(checker, initializer, resolveString, new Set([...seen, key]));
      return { kind: "symbolic", valueId: key };
    }
    return { kind: "unknown" };
  };

  const argumentValue = (expression: ts.Expression): SymbolicArgumentValue => {
    const producerFor = (candidate: ts.Expression, seen = new Set<string>()): string | null => {
      const current = isAwaitOrTransparent(candidate);
      const direct = factsByNode.get(current as ts.CallExpression);
      if (direct) return direct.id;
      if (!ts.isIdentifier(current)) return null;
      const symbol = unalias(checker, checker.getSymbolAtLocation(current));
      const key = symbolKey(symbol);
      if (!key || seen.has(key)) return null;
      const initializer = declarationInitializers.get(key);
      return initializer ? producerFor(initializer, new Set([...seen, key])) : null;
    };
    const producerCallId = producerFor(expression);
    if (producerCallId) return { kind: "service-call-result", producerCallId };
    const current = isAwaitOrTransparent(expression);
    const strings = abstractString(checker, current, resolveString);
    return strings.kind === "literals" ? strings : { kind: "unknown" };
  };

  const factFor = (
    call: ts.CallExpression,
    kind: "resolution" | "invocation",
    service: ServiceValue,
    method: ts.Node | undefined
  ): WorkspaceServiceCallFact => {
    const sourceFile = call.getSourceFile();
    const unit = sourceUnitForFile(input.sourceRoot, sourceFile.fileName, input.units);
    const coordinate = sourceCoordinate(sourceFile, method ?? call);
    const packageUnit = unit && unit.relativePath !== input.unitRelativePath ? unit : undefined;
    const originPackage =
      unit?.package ??
      (packageUnit
        ? {
            kind: "workspace" as const,
            name: packageUnit.name,
            versionOrEffectiveVersion: packageUnit.effectiveVersion ?? "unknown",
            contentDigest: packageUnit.packageDigest ?? "unknown",
          }
        : undefined);
    const methodValue = method
      ? ts.isIdentifier(method) || ts.isStringLiteralLike(method)
        ? method.text
        : null
      : null;
    const abstractMethod = method
      ? methodValue !== null
        ? { kind: "literals" as const, values: new Set([methodValue]) }
        : abstractString(checker, method as ts.Expression, resolveString)
      : { kind: "literals" as const, values: new Set<string>() };
    const fact: WorkspaceServiceCallFact = {
      id: `${sourceFile.fileName}:${call.getStart(sourceFile)}:${kind}`,
      kind,
      serviceQueries: service.queries,
      methods: abstractMethod,
      objectKeys: service.objectKeys,
      arguments: [],
      origin: {
        unitName: unit?.name ?? input.unitRelativePath,
        ...(originPackage ? { package: originPackage } : {}),
        file: path.relative(input.sourceRoot, sourceFile.fileName).replace(/\\/gu, "/"),
        line: coordinate.line,
        column: coordinate.column,
      },
    };
    factsByNode.set(call, fact);
    return fact;
  };

  for (const call of allCalls) {
    if (isResolverCall(call)) {
      const value = serviceValue(call);
      if (value) factFor(call, "resolution", value, undefined);
      continue;
    }
    if (isFactoryCall(call)) {
      const value = serviceValue(call);
      if (value) factFor(call, "resolution", value, undefined);
      continue;
    }
    const property = ts.isPropertyAccessExpression(call.expression) ? call.expression : null;
    if (!property) continue;
    const directRpc =
      RPC_METHOD_NAMES.has(property.name.text) && call.arguments.length >= 2
        ? serviceValue(call.arguments[0]!)
        : null;
    const receiverValue = directRpc ?? serviceValue(property.expression);
    if (!receiverValue) continue;
    const method = directRpc
      ? call.arguments[1]
      : property.name.text === "call" ||
          property.name.text === "stream" ||
          property.name.text === "streamReadable"
        ? call.arguments[0]
        : property.name;
    if (directRpc) {
      if (!method) continue;
      const fact = factFor(call, "invocation", receiverValue, method);
      fact.arguments = call.arguments.slice(2).map(argumentValue);
    } else if (
      property.name.text === "call" ||
      property.name.text === "stream" ||
      property.name.text === "streamReadable"
    ) {
      if (!method) continue;
      const fact = factFor(call, "invocation", receiverValue, method);
      fact.arguments = call.arguments.slice(1).map(argumentValue);
    } else if (receiverValue.client) {
      const fact = factFor(call, "invocation", receiverValue, method);
      fact.arguments = call.arguments.map(argumentValue);
    }
  }

  for (const fact of factsByNode.values()) {
    if (fact.kind === "resolution") {
      fact.arguments = [];
    }
  }
  const facts = [...factsByNode.values()];
  for (const module of input.executableModules ?? []) {
    const virtualFile = path.isAbsolute(module.moduleId)
      ? module.moduleId
      : path.resolve(input.sourceRoot, module.moduleId);
    const options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      allowJs: true,
      checkJs: false,
      skipLibCheck: true,
    };
    const host = ts.createCompilerHost(options, true);
    const originalGetSourceFile = host.getSourceFile.bind(host);
    host.fileExists = (fileName) => fileName === virtualFile || ts.sys.fileExists(fileName);
    host.readFile = (fileName) =>
      fileName === virtualFile ? module.source : ts.sys.readFile(fileName);
    host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) =>
      fileName === virtualFile
        ? ts.createSourceFile(
            fileName,
            module.source,
            languageVersion,
            true,
            module.format === "tsx" || module.format === "jsx"
              ? ts.ScriptKind.TSX
              : module.format === "js" || module.format === "mjs" || module.format === "cjs"
                ? ts.ScriptKind.JS
                : ts.ScriptKind.TS
          )
        : originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    const externalProgram = ts.createProgram([virtualFile], options, host);
    facts.push(
      ...analyzeWorkspaceServiceCalls({
        program: externalProgram,
        sourceRoot: path.dirname(virtualFile),
        unitRelativePath: ".",
        units: [
          {
            name: module.package.kind === "external" ? module.package.name : "external-module",
            relativePath: ".",
            package:
              module.package.kind === "external"
                ? {
                    kind: "external",
                    name: module.package.name,
                    versionOrEffectiveVersion: module.package.version,
                    contentDigest: module.package.packageDigest,
                  }
                : module.package.kind === "workspace"
                  ? {
                      kind: "workspace",
                      name: module.package.name,
                      versionOrEffectiveVersion: module.package.effectiveVersion,
                      contentDigest: module.contentDigest,
                    }
                  : undefined,
          },
        ],
      })
    );
  }
  return facts.sort((a, b) => a.id.localeCompare(b.id));
}
