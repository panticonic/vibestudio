import type { AuthorizationContext, AuthorityGrant, Principal } from "@vibestudio/rpc";
import {
  ServiceDispatcher,
  type ServiceContext,
  type VerifiedCaller,
} from "./serviceDispatcher.js";
import type { ServiceDefinition } from "./serviceDefinition.js";
import { evaluateAuthority, type AuthorityRequirement } from "./authorization.js";
import { capabilityPatternCovers } from "./authorityManifest.js";

const TEST_DIGEST = "0".repeat(64);
const TEST_HOST = "host:test" as const;

/**
 * Exact, closed-world authority fixture for dispatcher tests. Production code
 * must install a resolver backed by live identity, membership, manifests, and
 * grants; this helper deliberately lives in a test-only module.
 */
export function createTestServiceDispatcher(): ServiceDispatcher {
  const dispatcher = new ServiceDispatcher();
  dispatcher.setAuthorityResolver(({ caller, capability, resourceKey }) =>
    testAuthority(caller, capability, resourceKey)
  );
  return dispatcher;
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
  const carriesCode = ["panel", "app", "worker", "do", "extension"].includes(
    caller.runtime.kind
  );
  const codeRequested = caller.code?.requested?.some((scope) =>
    capabilityPatternCovers(scope.capability, capability)
  );
  const code = carriesCode && (!platformCapability || codeRequested)
    ? (`code:${caller.code?.repoPath ?? "tests/service-dispatch"}@${caller.code?.executionDigest ?? TEST_DIGEST}` as const)
    : null;
  const entity =
    caller.runtime.kind === "agent" || code
      ? (`entity:${caller.agentBinding?.entityId ?? caller.runtime.id}` as const)
      : null;
  const context: AuthorizationContext = {
    host,
    actingUser,
    device: null,
    entity,
    incarnation: null,
    code,
    codeManifest: code
      ? {
          principal: code,
          requested: [{ capability, resource: { kind: "exact", key: resourceKey } }],
        }
      : null,
    deviceOwnership: null,
    ownerChain: actingUser ? [actingUser] : [],
    agentBinding:
      entity && caller.agentBinding
        ? {
            entity,
            contextId: caller.agentBinding.contextId,
            channelId: caller.agentBinding.channelId,
          }
        : null,
    delegation: [],
    workspace: { workspaceId: "test", member: true, role: "member", revision: "test" },
    session: {
      id: `test:${caller.runtime.id}`,
      audience: "test",
      version: "1.0.0",
      expiresAt: now + 60_000,
    },
  };
  const subjects: Principal[] = [];
  if (host) subjects.push(host);
  if (actingUser) subjects.push(actingUser);
  if (code) subjects.push(code);
  if (entity) subjects.push(entity);
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
      binding: { kind: "principal" },
      provenance: "test-fixture",
    })),
  };
}
