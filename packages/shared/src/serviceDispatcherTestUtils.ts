import type { AuthorizationContext, AuthorityGrant, Principal } from "@vibestudio/rpc";
import {
  createHostCaller,
  ServiceAccessError,
  ServiceDispatcher,
  type ServiceContext,
  type VerifiedCaller,
} from "./serviceDispatcher.js";
import type { ServiceDefinition } from "./serviceDefinition.js";
import {
  evaluateAuthority,
  lineageClasses,
  type AuthorityRequirement,
} from "./authorization.js";

const TEST_DIGEST = "0".repeat(64);
const TEST_HOST = "host:test" as const;

/** Host-attested execution-session fixture. Tests must provide the concrete
 * runtime and harness identity instead of using the removed boolean shortcut. */
export function createTestExecutionSession(input: {
  runtimeId: string;
  harnessPrincipal?: `code:${string}`;
  repoPath?: string;
  effectiveVersion?: string;
  contextId?: string;
  agentBinding?: {
    entityId: string;
    channelId: string;
    bindingId?: string;
  } | null;
  mode?: "interactive" | "mission" | "test";
  testPolicy?: import("@vibestudio/rpc").AgentExecutionTestPolicy;
}): import("@vibestudio/rpc").AgentExecutionSessionFact {
  const now = Date.now();
  const repoPath = input.repoPath ?? "tests/harness";
  const effectiveVersion = input.effectiveVersion ?? "test";
  return {
    v: 1,
    authoritySessionId: `test:${input.runtimeId}`,
    authoritySessionVersion: 1,
    mode: input.mode ?? "test",
    ownerUser: "user:test",
    workspaceId: "test",
    contextId: input.contextId ?? "ctx-test",
    agentBinding:
      input.agentBinding === null
        ? null
        : {
            entityId: input.agentBinding?.entityId ?? "agent:test",
            channelId: input.agentBinding?.channelId ?? "channel:test",
            bindingId: input.agentBinding?.bindingId ?? "binding:test",
          },
    taskRef: `task:${input.runtimeId}`,
    ...(input.testPolicy ? { testPolicy: input.testPolicy } : {}),
    harness: {
      principal:
        input.harnessPrincipal ?? (`code:${repoPath}@${TEST_DIGEST}` as `code:${string}`),
      repoPath,
      effectiveVersion,
    },
    eval: {
      runtimeId: input.runtimeId,
      runId: `run:${input.runtimeId}`,
      authorityManifest: {
        mode: "adaptive",
        effects: "read-write",
        approvals: "prompt",
        requests: [],
        digest: "0".repeat(64),
      },
    },
    causalParent: null,
    issuedAt: now,
    expiresAt: now + 60_000,
    nonce: `nonce:${input.runtimeId}`,
  };
}

/**
 * Exact, closed-world authority fixture for dispatcher tests. Production code
 * must install a resolver backed by live identity, membership, manifests, and
 * grants; this helper deliberately lives in a test-only module.
 */
export function createTestServiceDispatcher(opts: {
  openMethods?: readonly string[];
  methods?: Readonly<
    Record<
      string,
      {
        tier: "open" | "gated" | "critical";
        session?: "family" | "codeOnly";
        capability?: string;
      }
    >
  >;
} = {}): ServiceDispatcher {
  const dispatcher = new ServiceDispatcher();
  const openMethods = new Set(opts.openMethods ?? []);
  if (openMethods.size > 0 || opts.methods) {
    const register = dispatcher.registerService.bind(dispatcher);
    dispatcher.registerService = (definition) =>
      register({
        ...definition,
        methods: Object.fromEntries(
          Object.entries(definition.methods).map(([method, schema]) => {
            const qualified = `${definition.name}.${method}`;
            return [
              method,
              (openMethods.has(qualified) || opts.methods?.[qualified]) && !schema.tier
                ? {
                    ...schema,
                    ...(opts.methods?.[qualified]?.capability
                      ? { capability: opts.methods[qualified].capability }
                      : {}),
                    tier: {
                      tier: opts.methods?.[qualified]?.tier ?? ("open" as const),
                      session: opts.methods?.[qualified]?.session ?? ("family" as const),
                      rationale: "Explicit unit-test fixture method",
                    },
                  }
                : schema,
            ];
          })
        ),
      });
  }
  dispatcher.setAuthorityResolver(({ caller, capability, resourceKey }) =>
    testAuthority(caller, capability, resourceKey)
  );
  return dispatcher;
}

/** Add explicit schema authority to compact test-only service fixtures. */
export function withTestMethodAuthority(
  definition: ServiceDefinition,
  decisions: Readonly<
    Record<
      string,
      {
        tier: "open" | "gated" | "critical";
        session?: "family" | "codeOnly";
        capability?: string;
      }
    >
  >
): ServiceDefinition {
  return {
    ...definition,
    methods: Object.fromEntries(
      Object.entries(definition.methods).map(([method, schema]) => {
        const decision = decisions[method];
        if (!decision) return [method, schema];
        return [
          method,
          {
            ...schema,
            ...(decision.capability ? { capability: decision.capability } : {}),
            tier: {
              tier: decision.tier,
              session: decision.session ?? "family",
              rationale: "Explicit unit-test fixture method",
            },
          },
        ];
      })
    ),
  };
}

export function withTestSchemaAuthority(
  definition: ServiceDefinition,
  decision: {
    tier: "open" | "gated" | "critical";
    session?: "family" | "codeOnly";
    capability?: string | ((method: string) => string);
  }
): ServiceDefinition {
  return withTestMethodAuthority(
    definition,
    Object.fromEntries(
      Object.keys(definition.methods).map((method) => [
        method,
        {
          tier: decision.tier,
          session: decision.session,
          ...(decision.capability
            ? {
                capability:
                  typeof decision.capability === "function"
                    ? decision.capability(method)
                    : decision.capability,
              }
            : {}),
        },
      ])
    )
  );
}

/**
 * Wrap a definition in the real dispatcher while preserving a unit test's
 * optional authority adapter. Prepared approval copy is therefore exercised
 * before the handler exactly as production does; ordinary primary leaves use
 * the closed-world fixture grants.
 */
export function withTestServiceDispatcher(definition: ServiceDefinition): ServiceDefinition {
  const adapters = new WeakMap<ServiceContext, ServiceContext["authority"]>();
  const dispatcher = new ServiceDispatcher();
  dispatcher.setAuthorityResolver(async (input) => {
    const adapter = adapters.get(input.ctx);
    if (input.capability === "panel-hosting") {
      const allowed = await adapter?.allows({
        capability: input.capability,
        resourceKey: input.resourceKey,
        requirement: input.requirement,
      });
      if (!allowed) {
        throw new ServiceAccessError(input.service, input.method, "panel hosting unavailable");
      }
      return testAuthority(
        createHostCaller(`test-panel-host:${input.caller.runtime.id}`),
        input.capability,
        input.resourceKey
      );
    }
    if (input.challenge && adapter) {
      await adapter.assert({
        capability: input.capability,
        resourceKey: input.resourceKey,
        requirement: input.requirement,
        authorizingCaller: input.caller,
        challenge: input.challenge,
      });
    }
    return testAuthority(input.caller, input.capability, input.resourceKey);
  });
  dispatcher.registerService(definition);
  dispatcher.markInitialized();
  return {
    ...definition,
    handler: async (context, method, args) => {
      const adapter = context.authority;
      adapters.set(context, adapter);
      try {
        await dispatcher.assertAuthority(context, definition.name, method, args);
        return await definition.handler(context, method, args);
      } finally {
        context.authority = adapter;
      }
    },
  };
}

/**
 * Construct the complete context a direct service-handler test would receive
 * from ServiceDispatcher. This keeps unit tests on the real compositional
 * evaluator without coupling them to the server's product boot manifest.
 */
export function createTestServiceContext(
  caller: VerifiedCaller,
  overrides: Omit<Partial<ServiceContext>, "caller" | "authority"> = {}
): ServiceContext {
  const baseline = testAuthority(caller, "test:context", "test:context");
  const allows = async (input: {
    capability: string;
    resourceKey: string;
    requirement: AuthorityRequirement;
  }): Promise<boolean> => {
    const resolved = testAuthority(caller, input.capability, input.resourceKey);
    return evaluateAuthority({
      context: resolved.context,
      grants: resolved.grants,
      requirement: input.requirement,
      resourceKey: input.resourceKey,
    }).allowed;
  };
  return {
    ...overrides,
    caller,
    authorization: overrides.authorization ?? baseline.context,
    authority: {
      allows,
      async assert(input) {
        if (await allows(input)) return;
        const error = new Error(
          `Test caller lacks ${input.capability} authority on ${input.resourceKey}`
        ) as Error & { code: string };
        error.code = "EACCES";
        throw error;
      },
    },
  };
}

/** Enrich direct calls to a service definition exactly as the dispatcher does. */
export function withTestServiceAuthority(definition: ServiceDefinition): ServiceDefinition {
  return {
    ...definition,
    handler: (context, method, args) => {
      if (context.authority) return definition.handler(context, method, args);
      const { caller, ...overrides } = context;
      return definition.handler(
        createTestServiceContext(caller, overrides),
        method,
        args
      );
    },
  };
}

export function testAuthority(
  caller: VerifiedCaller,
  capability: string,
  resourceKey: string,
  now = Date.now()
): { context: AuthorizationContext; grants: AuthorityGrant[] } {
  const platformCapability = new Set([
    "panel-hosting",
    "window-management",
    "open-external",
    "native-menus",
    "notifications",
    "fs-read",
    "fs-write",
  ]).has(capability);
  const host =
    caller.hostOriginated === true || caller.runtime.kind === "server" ? TEST_HOST : null;
  const actingUser =
    caller.subject?.userId && caller.subject.userId !== "system"
      ? (`user:${caller.subject.userId}` as const)
      : caller.runtime.kind === "shell"
        ? ("user:test" as const)
        : null;
  // Only explicitly verified eval/causal invocations authorize as sessions.
  // Agent binding remains an attribution and relationship fact, never an
  // authorizing origin or grant subject.
  const carriesCode =
    Boolean(caller.code) ||
    (!caller.executionSession &&
      ["panel", "app", "worker", "do", "extension"].includes(caller.runtime.kind));
  // Code identity and manifest requests are independent facts. Under-declared
  // code remains code and must fail as `not-requested`; erasing its identity
  // here would incorrectly turn it into a user or product-host invocation.
  const code = carriesCode
    ? (`code:${caller.code?.repoPath ?? "tests/service-dispatch"}@${caller.code?.executionDigest ?? TEST_DIGEST}` as const)
    : null;
  const entity =
    caller.agentBinding || caller.runtime.kind === "agent" || code
      ? (`entity:${caller.agentBinding?.entityId ?? caller.runtime.id}` as const)
      : null;
  const sessionPrincipal = `session:test:${caller.runtime.id}` as const;
  const context: AuthorizationContext = {
    authorizingOrigin: caller.hostOriginated
      ? { kind: "host", principal: host ?? TEST_HOST }
      : code
        ? { kind: "code", principal: code }
        : caller.executionSession
          ? { kind: "session", principal: sessionPrincipal }
        : actingUser
          ? { kind: "user", principal: actingUser }
          : { kind: "host", principal: host ?? TEST_HOST },
    host,
    actingUser,
    entity,
    incarnation: null,
    executingCode: code
        ? {
            principal: code,
            requested:
              caller.code?.requested ??
              (platformCapability
                ? []
                : [{ capability, resource: { kind: "exact" as const, key: resourceKey } }]),
            sourceLineage: { class: "internal", externalKeys: [] },
          }
        : null,
    initiatorChain: [
      ...(actingUser ? [actingUser] : []),
      ...(entity ? [entity] : []),
      ...(code ? [code] : []),
    ],
    ownerChain: actingUser ? [actingUser] : [],
    agentBinding:
      entity && caller.agentBinding
        ? {
            entity,
            contextId: caller.agentBinding.contextId,
            channelId: caller.agentBinding.channelId,
          }
        : null,
    executionSession: caller.executionSession ?? null,
    testPolicy: caller.testPolicy ?? caller.executionSession?.testPolicy ?? null,
    workspace: { workspaceId: "test", member: true, role: "member", revision: "test" },
    session: {
      id: `test:${caller.runtime.id}`,
      audience: "test",
      version: "1.0.0",
      expiresAt: now + 60_000,
    },
    contextIntegrity:
      caller.executionSession
        ? { class: "internal", latchEpoch: 0, externalKeys: [] }
        : { class: "not-applicable", latchEpoch: 0, externalKeys: [] },
  };
  const subjects: Principal[] = [];
  if (host) subjects.push(host);
  if (actingUser) subjects.push(actingUser);
  if (code) subjects.push(code);
  if (context.authorizingOrigin.kind === "session") subjects.push(sessionPrincipal);
  return {
    context,
    grants: subjects.map((subject) => ({
      subject,
      capability,
      resource: { kind: "exact", key: resourceKey },
      effect: "allow",
      issuedBy: TEST_HOST,
      createdAt: now,
      expiresAt: now + 60_000,
      provenance: "test-fixture",
      constraints: {
        lineageAtConsent: context.contextIntegrity
          ? lineageClasses(context.contextIntegrity)
          : ["none"],
      },
    })),
  };
}
