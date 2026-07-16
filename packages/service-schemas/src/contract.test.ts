import { readdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import type { ServiceMethodSchemas } from "@vibestudio/shared/typedServiceClient";
import { appMethods } from "./app.js";
import { accountMethods } from "./account.js";
import { authMethods } from "./auth.js";
import { autofillMethods } from "./autofill.js";
import { blobstoreMethods } from "./blobstore.js";
import { buildMethods } from "./build.js";
import { channelMethods } from "./channel.js";
import { corsApprovalMethods } from "./corsApproval.js";
import { ConnectCredentialSpecSchema, credentialsMethods } from "./credentials.js";
import { docsMethods } from "./docs.js";
import { devHostMethods } from "./devHost.js";
import { eventsMethods } from "./events.js";
import { extensionsMethods } from "./extensions.js";
import { externalOpenMethods } from "./externalOpen.js";
import { fsMethods } from "./fs.js";
import { gitInteropMethods } from "./gitInterop.js";
import { hostLifecycleMethods } from "./hostLifecycle.js";
import { hubControlMethods } from "./hubControl.js";
import { serverLogMethods } from "./serverLog.js";
import { menuMethods } from "./menu.js";
import { mirrorMethods } from "./mirror.js";
import { notificationMethods } from "./notification.js";
import { paletteMethods } from "./palette.js";
import { panelMethods } from "./panel.js";
import { panelLogMethods } from "./panelLog.js";
import { panelRuntimeMethods } from "./panelRuntime.js";
import { panelTreeMethods } from "./panelTree.js";
import { phoneProvisioningMethods } from "./phoneProvisioning.js";
import { pushMethods, PushRegisterRequestSchema } from "./push.js";
import { permissionsMethods } from "./permissions.js";
import { refsMethods } from "./refs.js";
import { remoteCredMethods } from "./remoteCred.js";
import { runtimeMethods } from "./runtime.js";
import { evalMethods } from "./eval.js";
import { settingsMethods } from "./settings.js";
import { shellApprovalMethods } from "./shellApproval.js";
import { vcsMethods } from "./vcs.js";
import { viewMethods } from "./view.js";
import { webhookIngressMethods } from "./webhookIngress.js";
import { workerLogMethods } from "./workerLog.js";
import { HostTargetLaunchResultSchema, workspaceMethods } from "./workspace.js";
import { workspacePresenceMethods } from "./workspacePresence.js";
import { EntityRecordSchema, workspaceStateMethods } from "./workspaceState.js";
import { worktreeMethods } from "./worktree.js";

type ServiceTable = {
  service: string;
  file: string;
  methods: ServiceMethodSchemas;
};

const serviceTables: ServiceTable[] = [
  { service: "account", file: "account.ts", methods: accountMethods },
  { service: "app", file: "app.ts", methods: appMethods },
  { service: "auth", file: "auth.ts", methods: authMethods },
  { service: "autofill", file: "autofill.ts", methods: autofillMethods },
  { service: "blobstore", file: "blobstore.ts", methods: blobstoreMethods },
  { service: "build", file: "build.ts", methods: buildMethods },
  { service: "channel", file: "channel.ts", methods: channelMethods },
  { service: "corsApproval", file: "corsApproval.ts", methods: corsApprovalMethods },
  { service: "credentials", file: "credentials.ts", methods: credentialsMethods },
  { service: "devHost", file: "devHost.ts", methods: devHostMethods },
  { service: "docs", file: "docs.ts", methods: docsMethods },
  { service: "events", file: "events.ts", methods: eventsMethods },
  { service: "extensions", file: "extensions.ts", methods: extensionsMethods },
  { service: "externalOpen", file: "externalOpen.ts", methods: externalOpenMethods },
  { service: "fs", file: "fs.ts", methods: fsMethods },
  { service: "gitInterop", file: "gitInterop.ts", methods: gitInteropMethods },
  { service: "hostLifecycle", file: "hostLifecycle.ts", methods: hostLifecycleMethods },
  { service: "hubControl", file: "hubControl.ts", methods: hubControlMethods },
  { service: "serverLog", file: "serverLog.ts", methods: serverLogMethods },
  { service: "menu", file: "menu.ts", methods: menuMethods },
  { service: "mirror", file: "mirror.ts", methods: mirrorMethods },
  { service: "notification", file: "notification.ts", methods: notificationMethods },
  { service: "palette", file: "palette.ts", methods: paletteMethods },
  { service: "panel", file: "panel.ts", methods: panelMethods },
  { service: "panelLog", file: "panelLog.ts", methods: panelLogMethods },
  { service: "panelRuntime", file: "panelRuntime.ts", methods: panelRuntimeMethods },
  { service: "panelTree", file: "panelTree.ts", methods: panelTreeMethods },
  {
    service: "phoneProvisioning",
    file: "phoneProvisioning.ts",
    methods: phoneProvisioningMethods,
  },
  { service: "permissions", file: "permissions.ts", methods: permissionsMethods },
  { service: "push", file: "push.ts", methods: pushMethods },
  { service: "refs", file: "refs.ts", methods: refsMethods },
  { service: "remoteCred", file: "remoteCred.ts", methods: remoteCredMethods },
  { service: "runtime", file: "runtime.ts", methods: runtimeMethods },
  { service: "eval", file: "eval.ts", methods: evalMethods },
  { service: "settings", file: "settings.ts", methods: settingsMethods },
  { service: "shellApproval", file: "shellApproval.ts", methods: shellApprovalMethods },
  { service: "vcs", file: "vcs.ts", methods: vcsMethods },
  { service: "view", file: "view.ts", methods: viewMethods },
  { service: "webhookIngress", file: "webhookIngress.ts", methods: webhookIngressMethods },
  { service: "workerLog", file: "workerLog.ts", methods: workerLogMethods },
  { service: "workspace", file: "workspace.ts", methods: workspaceMethods },
  {
    service: "workspacePresence",
    file: "workspacePresence.ts",
    methods: workspacePresenceMethods,
  },
  { service: "workspace-state", file: "workspaceState.ts", methods: workspaceStateMethods },
  { service: "worktree", file: "worktree.ts", methods: worktreeMethods },
];

describe("runtime identity wire contracts", () => {
  it("keeps immutable source identity separate from the active execution digest", () => {
    expect(
      EntityRecordSchema.parse({
        id: "worker:workers/example:key",
        kind: "worker",
        source: { repoPath: "workers/example" },
        activeExecutionDigest: "a".repeat(64),
        contextId: "ctx-1",
        key: "key",
        createdAt: 1,
        status: "active",
        cleanupComplete: false,
      })
    ).toMatchObject({
      source: { repoPath: "workers/example" },
      activeExecutionDigest: "a".repeat(64),
    });
  });

  it("preserves exact authority metadata on ready host-target launches", () => {
    const parsed = HostTargetLaunchResultSchema.parse({
      status: "ready",
      launched: true,
      target: "electron",
      source: "apps/shell",
      appId: "@workspace-apps/shell",
      buildKey: "build-1",
      executionDigest: "a".repeat(64),
      authorityRequests: [
        {
          capability: "service:events.subscribe",
          resource: { kind: "exact", key: "service:events.subscribe" },
        },
      ],
      authorityDelegations: [
        {
          audience: "eval",
          purpose: "tool-eval",
          capabilities: [
            {
              capability: "service:events.subscribe",
              resource: { kind: "exact", key: "service:events.subscribe" },
            },
          ],
        },
      ],
    });

    expect(parsed.status).toBe("ready");
    if (parsed.status !== "ready") throw new Error("Expected a ready launch result");
    expect(parsed.authorityRequests).toEqual([
      {
        capability: "service:events.subscribe",
        resource: { kind: "exact", key: "service:events.subscribe" },
      },
    ]);
    expect(parsed.authorityDelegations).toEqual([
      {
        audience: "eval",
        purpose: "tool-eval",
        capabilities: [
          {
            capability: "service:events.subscribe",
            resource: { kind: "exact", key: "service:events.subscribe" },
          },
        ],
      },
    ]);
  });
});

const approvedReturnlessMethods = new Set([
  // `invokeStream` returns a live Response object from the extension streaming
  // bridge. That transport is validated by stream-level tests rather than a
  // JSON-compatible Zod return schema.
  "extensions.invokeStream",
]);

const approvedWeakReturnRoots = new Set([
  // A DeferredResult is a deliberately non-JSON control sentinel. Its custom
  // validator calls `isDeferredResult`; the actual credential payload branches
  // remain fully structural.
  "credentials.connect",
  "credentials.resolveCredential",
  // Live NDJSON streams cross the same Response-aware RPC relay as other
  // streamed services; individual entries are validated by devHost schemas.
  "devHost.logs",
  "devHost.watch",
]);

type TraversableZodDef = z.ZodTypeDef & {
  typeName?: z.ZodFirstPartyTypeKind;
  type?: unknown;
  valueType?: unknown;
  innerType?: unknown;
  schema?: unknown;
  options?: unknown;
  left?: unknown;
  right?: unknown;
  getter?: unknown;
  out?: unknown;
  items?: unknown;
  rest?: unknown;
};

function asZodSchema(value: unknown): z.ZodTypeAny | null {
  return value instanceof z.ZodType ? value : null;
}

/**
 * Follow transparent root containers until a structural object/primitive is
 * reached. This catches weak roots hidden in arrays, records, unions, lazy
 * JSON containers, and effects (including `z.custom`) without rejecting
 * intentionally opaque fields inside an otherwise validated object.
 */
function weakReturnRootPaths(
  schema: z.ZodTypeAny,
  path = "$",
  visited = new Set<z.ZodTypeAny>()
): string[] {
  if (visited.has(schema)) return [];
  visited.add(schema);
  const def = schema._def as TraversableZodDef;
  const descend = (value: unknown, suffix: string): string[] => {
    const child = asZodSchema(value);
    return child ? weakReturnRootPaths(child, `${path}${suffix}`, visited) : [];
  };

  switch (def.typeName) {
    case z.ZodFirstPartyTypeKind.ZodAny:
    case z.ZodFirstPartyTypeKind.ZodUnknown:
      return [path];
    case z.ZodFirstPartyTypeKind.ZodArray:
      return descend(def.type, "[]");
    case z.ZodFirstPartyTypeKind.ZodRecord:
      return descend(def.valueType, "{}");
    case z.ZodFirstPartyTypeKind.ZodOptional:
    case z.ZodFirstPartyTypeKind.ZodNullable:
    case z.ZodFirstPartyTypeKind.ZodDefault:
    case z.ZodFirstPartyTypeKind.ZodCatch:
    case z.ZodFirstPartyTypeKind.ZodBranded:
    case z.ZodFirstPartyTypeKind.ZodReadonly:
      return descend(def.innerType ?? def.type, "");
    case z.ZodFirstPartyTypeKind.ZodEffects:
      return descend(def.schema, "");
    case z.ZodFirstPartyTypeKind.ZodLazy:
      return typeof def.getter === "function" ? descend((def.getter as () => unknown)(), "") : [];
    case z.ZodFirstPartyTypeKind.ZodUnion:
      return Array.isArray(def.options)
        ? def.options.flatMap((option, index) => descend(option, `|${index}`))
        : [];
    case z.ZodFirstPartyTypeKind.ZodDiscriminatedUnion:
      return def.options instanceof Map
        ? [...def.options.values()].flatMap((option, index) => descend(option, `|${index}`))
        : [];
    case z.ZodFirstPartyTypeKind.ZodIntersection:
      return [...descend(def.left, "&left"), ...descend(def.right, "&right")];
    case z.ZodFirstPartyTypeKind.ZodPipeline:
      return descend(def.out, "|out");
    case z.ZodFirstPartyTypeKind.ZodTuple: {
      const items = Array.isArray(def.items)
        ? def.items.flatMap((item, index) => descend(item, `[${index}]`))
        : [];
      return [...items, ...descend(def.rest, "[]")];
    }
    default:
      return [];
  }
}

describe("service schema contracts", () => {
  it("allows reset-style eval methods to omit their optional routing object", () => {
    expect(evalMethods.reset.args.safeParse([]).success).toBe(true);
    expect(evalMethods.reset.args.safeParse([{}]).success).toBe(true);
    expect(evalMethods.forceReset.args.safeParse([]).success).toBe(true);
    expect(evalMethods.forceReset.args.safeParse([{}]).success).toBe(true);
  });

  it("bounds lossless eval scope pages at 128 Ki code units", () => {
    expect(
      evalMethods.readScopeTextPage.args.safeParse([{ key: "large", offset: 0, limit: 128 * 1024 }])
        .success
    ).toBe(true);
    expect(
      evalMethods.readScopeTextPage.args.safeParse([
        { key: "large", offset: 0, limit: 128 * 1024 + 1 },
      ]).success
    ).toBe(false);
  });

  it("covers every service schema file in this directory", () => {
    const schemaDir = dirname(fileURLToPath(import.meta.url));
    const schemaFiles = readdirSync(schemaDir)
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .sort();

    expect(serviceTables.map((table) => table.file).sort()).toEqual(schemaFiles);
  });

  it("declares args and approved return schemas for every method", () => {
    for (const { service, methods } of serviceTables) {
      expect(
        Object.keys(methods).length,
        `${service} should declare at least one method`
      ).toBeGreaterThan(0);
      for (const [method, schema] of Object.entries(methods)) {
        expect(
          typeof schema.args.safeParse,
          `${service}.${method} should have a Zod args schema`
        ).toBe("function");

        const key = `${service}.${method}`;
        if (!approvedReturnlessMethods.has(key)) {
          expect(schema.returns, `${key} should declare a return schema`).toBeDefined();
        }
      }
    }
  });

  it("rejects recursively weak return roots", () => {
    const weak: string[] = [];
    for (const { service, methods } of serviceTables) {
      for (const [method, schema] of Object.entries(methods)) {
        if (!schema.returns) continue;
        const key = `${service}.${method}`;
        const paths = weakReturnRootPaths(schema.returns);
        if (paths.length > 0 && !approvedWeakReturnRoots.has(key)) {
          weak.push(`${key}: ${paths.join(", ")}`);
        }
      }
    }
    expect(
      weak,
      `Weak return roots must be replaced with structural wire schemas: ${weak.join("; ")}`
    ).toEqual([]);
  });

  it("builds typed clients without dotted-method collisions", () => {
    for (const { service, methods } of serviceTables) {
      expect(() => createTypedServiceClient(service, methods, async () => undefined)).not.toThrow();
    }
  });

  it("rejects the retired client-owned push userId", () => {
    expect(
      PushRegisterRequestSchema.safeParse({
        token: "token",
        platform: "ios",
        clientId: "client",
        userId: "spoofed",
      }).success
    ).toBe(false);
  });

  it("rejects the retired non-PKCE authorization-code flow", () => {
    expect(
      ConnectCredentialSpecSchema.safeParse({
        flow: {
          type: "oauth2-auth-code",
          authorizeUrl: "https://accounts.example.test/authorize",
          tokenUrl: "https://accounts.example.test/token",
          clientId: "client",
          pkce: false,
          compatibilityReason: "old provider",
        },
        credential: {
          label: "Example",
          audience: [{ url: "https://api.example.test/", match: "origin" }],
          injection: {
            type: "header",
            name: "authorization",
            valueTemplate: "Bearer {token}",
          },
        },
      }).success
    ).toBe(false);
  });

  // Doc-coverage gate (replaces the deleted check:*-docs staleness gates).
  // The literate-docs migration (Workstream F) is complete, so this now ENFORCES
  // that every public method carries a non-empty `description` — new methods must
  // be documented at the definition site (it flows to agents via the catalog).
  it("documents every method (non-empty description at the definition site)", () => {
    const undocumented: string[] = [];
    for (const { service, methods } of serviceTables) {
      for (const [method, schema] of Object.entries(methods)) {
        if (!schema.description || schema.description.trim().length === 0) {
          undocumented.push(`${service}.${method}`);
        }
      }
    }
    expect(
      undocumented,
      `Undocumented methods (add a \`description\`): ${undocumented.join(", ")}`
    ).toEqual([]);
  });

  // Sensitivity-coverage gate: `access.sensitivity` is no longer enforced (the
  // caller gate lives in `policy`), but it stays agent-facing documentation
  // (rendered in docs_open) and the read-only dry-run key — so every public
  // method must declare it (read | write | admin | destructive).
  it("declares access.sensitivity on every method", () => {
    const missing: string[] = [];
    for (const { service, methods } of serviceTables) {
      for (const [method, schema] of Object.entries(methods)) {
        if (!schema.access?.sensitivity) {
          missing.push(`${service}.${method}`);
        }
      }
    }
    expect(
      missing,
      `Methods missing \`access.sensitivity\` (add read|write|admin|destructive): ${missing.join(", ")}`
    ).toEqual([]);
  });
});
