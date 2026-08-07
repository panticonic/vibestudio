import ts from "typescript";

const EXTENSION_CONTEXT_FACADES = {
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
  "extensions.on": ["events.watch"],
  "extensions.use": ["extensions.invoke", "extensions.invokeStream", "extensions.streamingMethods"],
};

const HOSTED_RUNTIME_FACADES = {
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
  "extensions.on": ["events.watch"],
  "workspace.projects.findForPath": ["workspace.findUnitForPath"],
  "workspace.projects.list": ["workspace.sourceTree"],
  "workspace.switchTo": ["workspace.select"],
};

const WORKSPACE_SERVICE_CLIENT_CONSTRUCTORS = {
  createBrowserDataClient: "browser.data",
  createGadClient: "gad.workspace",
};

const HOSTED_RUNTIME_WORKSPACE_SERVICE_FACADES = {
  browserData: "browser.data",
  gad: "gad.workspace",
};

const CONTEXT_RECEIVER = String.raw`(?:\bctx|\bthis\s*\.\s*ctx)`;

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
    for (const [method, methodCensus] of Object.entries(entry.methods ?? {})) {
      const declaration = methodCensus?.authority ?? methodCensus;
      const required = new Set();
      for (const approval of methodCensus?.access?.approval ?? []) {
        if (
          typeof approval?.capability === "string" &&
          (approval.tier === "gated" || approval.tier === "critical")
        ) {
          required.add(approval.capability);
        }
      }
      for (const additional of declaration && declaration.inherits !== true
        ? (declaration.additional ?? [])
        : []) {
        if (typeof additional?.capability === "string" && includesCode(additional.requirement)) {
          required.add(additional.capability);
        }
      }
      for (const leaf of declaration && declaration.inherits !== true
        ? (declaration.prepared?.leaves ?? [])
        : []) {
        const admitsCode =
          leaf?.requirement?.kind === "selected"
            ? leaf.requirement.principals?.includes("code")
            : includesCode(leaf?.requirement);
        if (typeof leaf?.capability === "string" && admitsCode) {
          required.add(leaf.capability);
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
  const directMethodCalls = new Set(["call", "stream", "streamReadable"]);
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
        directMethodCalls.has(node.expression.name.text)
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
      directMethodCalls.has(node.expression.name.text)
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
 * Effects exposed by typed workspace API methods. Unlike transport literals in
 * an implementation module, these are charged only at actual call sites in the
 * executable module graph.
 */
/**
 * EventsClient selects its service name in the constructor and performs the
 * eventual RPC through a dynamic method variable. Infer that typed wrapper at
 * the construction site so callers cannot silently receive an empty sealed
 * request set merely because the wrapper hides the literal `service.method`.
 */
export function inferEventsClientCapabilities(source, serviceMethods) {
  const capabilities = new Set();
  const sourceFiles = [ts.ScriptKind.TS, ts.ScriptKind.TSX].map((scriptKind) =>
    ts.createSourceFile(
      scriptKind === ts.ScriptKind.TS
        ? "events-authority-source.ts"
        : "events-authority-source.tsx",
      source,
      ts.ScriptTarget.Latest,
      false,
      scriptKind
    )
  );
  const visit = (node) => {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "EventsClient"
    ) {
      const selectedService = node.arguments?.[2];
      const service =
        selectedService && ts.isStringLiteralLike(selectedService)
          ? selectedService.text
          : "events";
      for (const method of serviceMethods.get(service) ?? []) {
        capabilities.add(`service:${service}.${method}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const sourceFile of sourceFiles) visit(sourceFile);
  return capabilities;
}

/**
 * Infer only methods actually selected from a literal typed-service client.
 * Constructing a client over a schema does not make every schema member
 * reachable: private clients are commonly wrapped by a deliberately smaller
 * exported API. Charging the whole schema would turn a typing implementation
 * detail into authority and inflate manifests whenever a host service grows.
 */
export function inferTypedServiceClientCapabilities(source, hostCapabilities) {
  const capabilities = new Set();
  for (const scriptKind of [ts.ScriptKind.TS, ts.ScriptKind.TSX]) {
    const parsed = ts.createSourceFile(
      scriptKind === ts.ScriptKind.TS ? "typed-clients.ts" : "typed-clients.tsx",
      source,
      ts.ScriptTarget.Latest,
      false,
      scriptKind
    );
    const clients = new Map();
    const collect = (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isCallExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression) &&
        node.initializer.expression.text === "createTypedServiceClient"
      ) {
        const service = node.initializer.arguments[0];
        if (service && ts.isStringLiteralLike(service)) clients.set(node.name.text, service.text);
      }
      ts.forEachChild(node, collect);
    };
    collect(parsed);

    const inspect = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression)
      ) {
        const service = clients.get(node.expression.expression.text);
        if (service) {
          const capability = `service:${service}.${node.expression.name.text}`;
          if (hostCapabilities.has(capability)) capabilities.add(capability);
        }
      }
      ts.forEachChild(node, inspect);
    };
    inspect(parsed);
  }
  return capabilities;
}

/**
 * Infer canonical workspace-service capabilities from public resolver calls.
 * Durable Object clients deliberately hide the workers.resolveService RPC, so
 * the selected service protocol must remain visible to the manifest audit at
 * the client construction site.
 */
export function inferWorkspaceServiceCapabilities(source, serviceSelectors) {
  const capabilities = new Set();
  for (const scriptKind of [ts.ScriptKind.TS, ts.ScriptKind.TSX]) {
    const parsed = ts.createSourceFile(
      scriptKind === ts.ScriptKind.TS ? "workspace-services.ts" : "workspace-services.tsx",
      source,
      ts.ScriptTarget.Latest,
      false,
      scriptKind
    );
    const literalBindings = new Map();
    const collect = (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isStringLiteralLike(node.initializer)
      ) {
        const values = literalBindings.get(node.name.text) ?? new Set();
        values.add(node.initializer.text);
        literalBindings.set(node.name.text, values);
      }
      ts.forEachChild(node, collect);
    };
    collect(parsed);

    const addSelector = (argument) => {
      const selectors = ts.isStringLiteralLike(argument)
        ? [argument.text]
        : ts.isIdentifier(argument)
          ? [...(literalBindings.get(argument.text) ?? [])]
          : [];
      for (const selector of selectors) {
        const capability = serviceSelectors.get(selector);
        if (capability) capabilities.add(capability);
      }
    };
    const addServiceName = (serviceName) => {
      const capability = serviceSelectors.get(serviceName);
      if (capability) capabilities.add(capability);
    };
    const inspect = (node) => {
      if (ts.isCallExpression(node)) {
        if (
          ts.isIdentifier(node.expression) &&
          node.expression.text === "createDurableObjectServiceClient"
        ) {
          // The host helper accepts (rpc, query, objectKey), while hosted
          // runtimes expose (query, objectKey). Only known selectors match.
          for (const argument of node.arguments.slice(0, 2)) addSelector(argument);
        } else if (
          ts.isIdentifier(node.expression) &&
          WORKSPACE_SERVICE_CLIENT_CONSTRUCTORS[node.expression.text]
        ) {
          addServiceName(WORKSPACE_SERVICE_CLIENT_CONSTRUCTORS[node.expression.text]);
        } else if (
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "resolveService"
        ) {
          addSelector(node.arguments[0]);
        } else if (
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          HOSTED_RUNTIME_WORKSPACE_SERVICE_FACADES[node.expression.expression.text]
        ) {
          addServiceName(HOSTED_RUNTIME_WORKSPACE_SERVICE_FACADES[node.expression.expression.text]);
        }
      }
      ts.forEachChild(node, inspect);
    };
    inspect(parsed);
  }
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
 * names, so raw RPC-literal scanning cannot discover these calls.
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
      serviceMethod: "runtime.supervision.reportHealth",
    },
    {
      pattern: new RegExp(`${CONTEXT_RECEIVER}\\s*\\.\\s*log\\s*\\.`, "g"),
      serviceMethod: "runtime.supervision.appendLog",
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

/**
 * Infer the transport-level authority effects visible in one executable module
 * closure. Callers map `service:<service>.<method>` through the reviewed host
 * catalog and then compare the resulting semantic effects with the unit's
 * explicit manifest. Keeping the syntactic recognition here gives checkout
 * audits and exact-state builds one inference implementation.
 */
export function inferUnitTransportCapabilities(
  source,
  { hostCapabilities, serviceMethods, workspaceServiceSelectors = new Map() }
) {
  const capabilities = new Set(["context.boundary"]);

  for (const capability of inferExtensionContextCapabilities(source, hostCapabilities)) {
    capabilities.add(capability);
  }
  for (const capability of inferHostedRuntimeCapabilities(source, hostCapabilities)) {
    capabilities.add(capability);
  }
  for (const capability of hostCapabilities) {
    const method = capability.slice("service:".length);
    if (
      source.includes(`"${method}"`) ||
      source.includes(`'${method}'`) ||
      source.includes(`\`${method}\``)
    ) {
      capabilities.add(capability);
    }
  }
  for (const capability of inferEventsClientCapabilities(source, serviceMethods)) {
    capabilities.add(capability);
  }
  for (const capability of inferTypedServiceClientCapabilities(source, hostCapabilities)) {
    capabilities.add(capability);
  }
  for (const capability of inferWorkspaceServiceCapabilities(source, workspaceServiceSelectors)) {
    capabilities.add(capability);
  }

  for (const match of source.matchAll(
    /(?:services|runtime\.services)\.([A-Za-z][\w-]*)\.([A-Za-z_$][\w$]*)/g
  )) {
    const capability = `service:${match[1]}.${match[2]}`;
    if (hostCapabilities.has(capability)) capabilities.add(capability);
  }

  return capabilities;
}
