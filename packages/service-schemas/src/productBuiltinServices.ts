import type { ServiceMethodSchemas } from "@vibestudio/shared/typedServiceClient";
import { browserVaultMethods } from "./browserData.js";
import { workspaceStateMethods } from "./workspaceState.js";
import { webhookEngineMethods } from "./webhookEngine.js";
import { evalEngineMethods } from "./evalEngine.js";
import { workspaceStateEngineMethods } from "./workspaceStateEngine.js";
// BUILTIN_SCAFFOLD_IMPORTS

export type BuiltinBecause = "feeds-authority" | "durable-data" | "recovery-path";

interface BuiltinBase {
  source: "vibestudio/internal";
  className: string;
  implementation: string;
  sourceFile: string;
  directMethods: ServiceMethodSchemas;
  builtinBecause: BuiltinBecause;
  durableObject: {
    keyVersion: number;
    objectKey: "workspace" | "browser-environment" | "owner" | "subscription";
    keyMode: "workspace-scoped" | "verified-user-workspace" | "caller-supplied";
  };
  runtime: {
    staticAuthorityProjection: boolean;
    codegen: boolean;
    /** The class keeps an object resident through `ctx.residency.hold()` (celld residency holds). */
    residency: boolean;
  };
  /** Static authority ceiling for work that has no inbound RPC authority
   * parent, notably durable-object alarms. Direct RPC execution is narrowed
   * independently by hostCapabilityRequests below. */
  residentCapabilityRequests: readonly {
    capability: string;
    resource: { kind: "prefix"; prefix: string };
    tier: "gated" | "critical";
    evidence: "bounded-dynamic" | "intentional-broad";
  }[];
  hostCapabilityRequests: readonly {
    capability: string;
    methods: readonly string[];
    resource: { kind: "prefix"; prefix: string };
    tier: "gated" | "critical";
    evidence: "bounded-dynamic" | "intentional-broad";
  }[];
}

export interface BuiltinServiceEntry extends BuiltinBase {
  kind: "service";
  name: string;
  title: string;
  description: string;
  action: string;
  presentation: { domain: string; verb: string };
  principals: readonly ("host" | "user" | "code")[];
  protocols: readonly string[];
  methods: ServiceMethodSchemas;
}

export interface BuiltinEngineEntry extends BuiltinBase {
  kind: "engine";
  name: string;
}

export type ProductBuiltinEntry = BuiltinServiceEntry | BuiltinEngineEntry;

export const PRODUCT_BUILTINS = [
  {
    kind: "service",
    source: "vibestudio/internal",
    name: "workspace.state",
    title: "Workspace state",
    description: "Use the product-owned durable workspace state service.",
    action: "use workspace state",
    presentation: { domain: "computer", verb: "manage" },
    principals: ["host"],
    protocols: ["vibestudio.workspace-state.v1"],
    className: "WorkspaceDO",
    implementation: "@panticonic/builtin/workspace-state",
    sourceFile: "packages/builtin/src/workspace-state/WorkspaceDO.ts",
    builtinBecause: "feeds-authority",
    methods: workspaceStateMethods,
    directMethods: workspaceStateEngineMethods,
    durableObject: { keyVersion: 1, objectKey: "workspace", keyMode: "workspace-scoped" },
    runtime: {
      staticAuthorityProjection: true,
      codegen: false,
      residency: false,
    },
    residentCapabilityRequests: [],
    hostCapabilityRequests: [],
  },
  {
    kind: "engine",
    source: "vibestudio/internal",
    name: "browser.vault",
    className: "BrowserVaultDO",
    implementation: "@panticonic/builtin/browser-data",
    sourceFile: "packages/builtin/src/browser-data/BrowserVaultDO.ts",
    builtinBecause: "durable-data",
    directMethods: browserVaultMethods,
    durableObject: {
      keyVersion: 1,
      objectKey: "browser-environment",
      keyMode: "verified-user-workspace",
    },
    runtime: {
      staticAuthorityProjection: true,
      codegen: false,
      residency: false,
    },
    residentCapabilityRequests: [],
    hostCapabilityRequests: [],
  },
  {
    kind: "engine",
    source: "vibestudio/internal",
    name: "eval.engine",
    className: "EvalDO",
    implementation: "@panticonic/builtin/eval-engine",
    sourceFile: "packages/builtin/src/eval-engine/EvalDO.ts",
    builtinBecause: "feeds-authority",
    durableObject: { keyVersion: 1, objectKey: "owner", keyMode: "caller-supplied" },
    runtime: {
      staticAuthorityProjection: true,
      codegen: true,
      residency: true,
    },
    residentCapabilityRequests: [],
    hostCapabilityRequests: [
      {
        capability: "external.open",
        methods: ["executeRun", "run", "startRun"],
        resource: { kind: "prefix", prefix: "" },
        tier: "gated",
        evidence: "intentional-broad",
      },
    ],
    directMethods: evalEngineMethods,
  },
  {
    kind: "engine",
    source: "vibestudio/internal",
    name: "webhook.engine",
    className: "WebhookStoreDO",
    implementation: "@panticonic/builtin/webhook-engine",
    sourceFile: "packages/builtin/src/webhook-engine/WebhookStoreDO.ts",
    builtinBecause: "feeds-authority",
    durableObject: { keyVersion: 1, objectKey: "subscription", keyMode: "caller-supplied" },
    runtime: {
      staticAuthorityProjection: true,
      codegen: false,
      residency: false,
    },
    residentCapabilityRequests: [],
    hostCapabilityRequests: [],
    directMethods: webhookEngineMethods,
  },
  // BUILTIN_SCAFFOLD_ENTRIES
] as const satisfies readonly ProductBuiltinEntry[];

const classNames = new Set<string>();
const protocols = new Set<string>();
for (const entry of PRODUCT_BUILTINS) {
  if (classNames.has(entry.className))
    throw new Error(`Duplicate builtin class ${entry.className}`);
  classNames.add(entry.className);
  if (entry.kind === "service") {
    for (const protocol of entry.protocols) {
      if (protocols.has(protocol)) throw new Error(`Duplicate builtin protocol ${protocol}`);
      protocols.add(protocol);
    }
  }
}
