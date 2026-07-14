import ts from "typescript";

const EXTENSION_CONTEXT_FACADES = {
  approvals: "userlandApproval",
  extensions: "extensions",
  fs: "fs",
  git: "gitInterop",
  notifications: "notification",
  webhooks: "webhookIngress",
  workers: "workers",
  workspace: "workspace",
};

const EXTENSION_CONTEXT_DERIVED_METHODS = {
  "credentials.fetch": ["credentials.proxyFetch"],
  "credentials.forAudience": ["credentials.resolveCredential", "credentials.proxyFetch"],
  "credentials.gitHttp": ["credentials.proxyGitHttp"],
  "credentials.hookForUrl": ["credentials.proxyFetch"],
  "credentials.store": ["credentials.storeCredential"],
  "extensions.on": ["events.subscribe", "events.unsubscribe"],
  "extensions.use": ["extensions.invoke", "extensions.invokeStream", "extensions.streamingMethods"],
};

const HOSTED_RUNTIME_FACADES = {
  approvals: "userlandApproval",
  browserData: "browserData",
  credentials: "credentials",
  extensions: "extensions",
  fs: "fs",
  git: "gitInterop",
  notifications: "notification",
  vcs: "vcs",
  webhooks: "webhookIngress",
  workers: "workers",
  workspace: "workspace",
};

const HOSTED_RUNTIME_DERIVED_METHODS = {
  "extensions.use": ["extensions.invoke", "extensions.invokeStream", "extensions.streamingMethods"],
  "workspace.projects.findForPath": ["workspace.findUnitForPath"],
  "workspace.projects.list": ["workspace.sourceTree"],
  "workspace.switchTo": ["workspace.select"],
  "workspace.units.status": ["workspace.units.list"],
  "workspace.units.watch": ["workspace.units.list", "events.subscribe", "events.unsubscribe"],
};

const CONTEXT_RECEIVER = String.raw`(?:\bctx|\bthis\s*\.\s*ctx)`;

// These calls are emitted by childRuntime itself for every extension process,
// independent of the extension's source. `ready` is the activation handshake;
// `health` reports the initial activated state.
export const EXTENSION_RUNTIME_BASE_CAPABILITIES = Object.freeze([
  "service:extensions.health",
  "service:extensions.ready",
]);

/**
 * Build transitive capability edges declared by host-service methods. A unit
 * invoking a method must request every additional code capability in that
 * method's authority contract or dispatch would necessarily fail after the
 * method capability itself succeeds.
 */
export function declaredMethodCapabilityDependencies(matrix) {
  const dependencies = new Map();
  const includesCode = (requirement) => {
    if (!requirement || typeof requirement !== "object") return false;
    if (requirement.kind === "capability") return requirement.principal === "code";
    if (requirement.kind === "all" || requirement.kind === "any") {
      return Array.isArray(requirement.requirements) && requirement.requirements.some(includesCode);
    }
    return false;
  };
  for (const [service, entry] of Object.entries(matrix)) {
    for (const [method, declaration] of Object.entries(entry.methods ?? {})) {
      if (!declaration || declaration.inherits === true) continue;
      const required = new Set();
      for (const additional of declaration.additional ?? []) {
        if (typeof additional?.capability === "string" && includesCode(additional.requirement)) {
          required.add(additional.capability);
        }
      }
      if (required.size > 0) dependencies.set(`service:${service}.${method}`, required);
    }
  }
  return dependencies;
}

export function expandCapabilityDependencies(capabilities, dependencies) {
  const queue = [...capabilities];
  for (let index = 0; index < queue.length; index += 1) {
    for (const dependency of dependencies.get(queue[index]) ?? []) {
      if (capabilities.has(dependency)) continue;
      capabilities.add(dependency);
      queue.push(dependency);
    }
  }
  return capabilities;
}

/**
 * Find direct workspace-RPC method literals from actual call expressions.
 * Regexes cannot safely skip an arbitrary target expression (for example
 * `targetIdFor(handle)`), which previously dropped subscribeChannel from the
 * chat panel's manifest.
 */
export function inferDirectRpcCapabilities(source, directCapabilities) {
  const capabilities = new Set();
  // The package source fold can contain both .ts and .tsx files. Parse both
  // ways and union the result: generic arrow functions such as `async <T>` are
  // ambiguous in TSX, while JSX is ambiguous in TS.
  const sourceFiles = [ts.ScriptKind.TS, ts.ScriptKind.TSX].map((scriptKind) =>
    ts.createSourceFile(
      scriptKind === ts.ScriptKind.TS ? "authority-source.ts" : "authority-source.tsx",
      source,
      ts.ScriptTarget.Latest,
      false,
      scriptKind
    )
  );
  const wrapperMethodArguments = new Map();

  const registerWrapper = (name, fn) => {
    const parameterIndexes = new Map();
    fn.parameters.forEach((parameter, index) => {
      if (ts.isIdentifier(parameter.name)) parameterIndexes.set(parameter.name.text, index);
    });
    if (parameterIndexes.size === 0 || !fn.body) return;
    const methodIndexes = new Set();
    const inspect = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        (node.expression.name.text === "call" || node.expression.name.text === "callDeferred")
      ) {
        for (const argument of node.arguments.slice(0, 2)) {
          if (!ts.isIdentifier(argument)) continue;
          const index = parameterIndexes.get(argument.text);
          if (index !== undefined) methodIndexes.add(index);
        }
      }
      ts.forEachChild(node, inspect);
    };
    inspect(fn.body);
    if (methodIndexes.size > 0) wrapperMethodArguments.set(name, methodIndexes);
  };

  const discoverWrappers = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      registerWrapper(node.name.text, node);
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      registerWrapper(node.name.text, node.initializer);
    }
    ts.forEachChild(node, discoverWrappers);
  };
  for (const sourceFile of sourceFiles) discoverWrappers(sourceFile);

  const addLiteral = (argument) => {
    if (!argument || !ts.isStringLiteralLike(argument)) return;
    const capability = `rpc:${argument.text}`;
    if (directCapabilities.has(capability)) capabilities.add(capability);
  };
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.name.text === "call" || node.expression.name.text === "callDeferred")
    ) {
      for (const argument of node.arguments.slice(0, 2)) addLiteral(argument);
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      for (const index of wrapperMethodArguments.get(node.expression.text) ?? []) {
        addLiteral(node.arguments[index]);
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const sourceFile of sourceFiles) visit(sourceFile);
  return capabilities;
}

/**
 * Resolve local package references from executable module syntax. Authority is
 * part of a built unit's transitive code, so the manifest generator must fold
 * every imported workspace package instead of maintaining a hand-written list
 * of libraries that happen to perform RPC today.
 */
export function inferWorkspacePackageReferences(source, workspacePackageNames) {
  const known = new Set(workspacePackageNames);
  const references = new Set();
  const sourceFiles = [ts.ScriptKind.TS, ts.ScriptKind.TSX].map((scriptKind) =>
    ts.createSourceFile(
      scriptKind === ts.ScriptKind.TS ? "package-references.ts" : "package-references.tsx",
      source,
      ts.ScriptTarget.Latest,
      false,
      scriptKind
    )
  );

  const addSpecifier = (specifier) => {
    if (!specifier || !ts.isStringLiteralLike(specifier)) return;
    const parts = specifier.text.split("/");
    const packageName = specifier.text.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
    if (known.has(packageName)) references.add(packageName);
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addSpecifier(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node)) {
      const reference = node.moduleReference;
      if (ts.isExternalModuleReference(reference)) addSpecifier(reference.expression);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      addSpecifier(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  for (const sourceFile of sourceFiles) visit(sourceFile);
  return references;
}

/**
 * Map the connectionless hosted-runtime facade back to its exact host methods.
 * Some public methods (notably `extensions.use`) construct a proxy and fan out
 * to several transport methods, so scanning for quoted RPC strings cannot see
 * the authority the caller actually exercises.
 */
export function inferHostedRuntimeCapabilities(source, hostCapabilities) {
  const capabilities = new Set();
  for (const [facade, service] of Object.entries(HOSTED_RUNTIME_FACADES)) {
    const pattern = new RegExp(
      `\\b${facade}\\s*\\.\\s*([A-Za-z_$][\\w$]*(?:\\s*\\.\\s*[A-Za-z_$][\\w$]*)*)\\s*\\(`,
      "g"
    );
    for (const match of source.matchAll(pattern)) {
      const methodPath = match[1].replace(/\\s+/g, "");
      const facadeCall = `${facade}.${methodPath}`;
      const serviceMethods = HOSTED_RUNTIME_DERIVED_METHODS[facadeCall] ?? [
        `${service}.${methodPath}`,
      ];
      for (const serviceMethod of serviceMethods) {
        const capability = `service:${serviceMethod}`;
        if (hostCapabilities.has(capability)) capabilities.add(capability);
      }
    }
  }
  return capabilities;
}

/**
 * Infer the exact host capabilities reached through the public
 * ExtensionContext facade. The facade deliberately hides transport method
 * names (for example `ctx.approvals.request` calls
 * `userlandApproval.request`), so raw RPC-literal scanning cannot discover
 * these calls.
 *
 * Unknown facade methods are rejected instead of silently producing an
 * incomplete manifest. Adding a new ExtensionContext method therefore makes
 * the authority model fail closed until its transport mapping is declared.
 */
export function inferExtensionContextCapabilities(source, hostCapabilities) {
  const capabilities = new Set();
  const unresolved = [];
  const facades = [...Object.keys(EXTENSION_CONTEXT_FACADES), "credentials"];

  for (const facade of facades) {
    const callPattern = new RegExp(
      `${CONTEXT_RECEIVER}\\s*\\.\\s*${facade}\\s*(?:\\?\\.|\\.)\\s*([A-Za-z_$][\\w$]*)`,
      "g"
    );
    for (const match of source.matchAll(callPattern)) {
      const method = match[1];
      const facadeCall = `${facade}.${method}`;
      const derived = EXTENSION_CONTEXT_DERIVED_METHODS[facadeCall];
      const serviceMethods = derived ?? [
        `${facade === "credentials" ? "credentials" : EXTENSION_CONTEXT_FACADES[facade]}.${method}`,
      ];
      const supported = serviceMethods.filter((serviceMethod) =>
        hostCapabilities.has(`service:${serviceMethod}`)
      );
      if (supported.length !== serviceMethods.length) {
        unresolved.push(facadeCall);
        continue;
      }
      for (const serviceMethod of supported) capabilities.add(`service:${serviceMethod}`);
    }
  }

  const contextualRuntimeCalls = [
    {
      pattern: new RegExp(`${CONTEXT_RECEIVER}\\s*\\.\\s*emit\\s*\\(`, "g"),
      serviceMethod: "extensions.emit",
    },
    {
      pattern: new RegExp(`${CONTEXT_RECEIVER}\\s*\\.\\s*health\\s*\\.`, "g"),
      serviceMethod: "extensions.health",
    },
    {
      pattern: new RegExp(`${CONTEXT_RECEIVER}\\s*\\.\\s*log\\s*\\.`, "g"),
      serviceMethod: "extensions.log",
    },
  ];
  for (const { pattern, serviceMethod } of contextualRuntimeCalls) {
    if (!pattern.test(source)) continue;
    const capability = `service:${serviceMethod}`;
    if (!hostCapabilities.has(capability)) unresolved.push(serviceMethod);
    else capabilities.add(capability);
  }

  if (unresolved.length > 0) {
    throw new Error(
      `ExtensionContext authority inference has no host mapping for: ${[...new Set(unresolved)]
        .sort()
        .join(", ")}`
    );
  }

  return capabilities;
}
