import { readdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createTypedServiceClient, maxArgsArity } from "@vibestudio/shared/typedServiceClient";
import type { ServiceMethodSchemas } from "@vibestudio/shared/typedServiceClient";
import type { RuntimeSurfaceMethodDoc } from "@vibestudio/shared/runtimeSurface";
import {
  PANEL_TREE_METHOD_CATALOG,
  WORKERS_RUNTIME_METHOD_CATALOG,
} from "./runtime/runtimeSurface.portable.js";
import { adblockMethods } from "./adblock.js";
import { appMethods } from "./app.js";
import { accountMethods } from "./account.js";
import { authMethods } from "./auth.js";
import { authorityMethods } from "./authority.js";
import { autofillMethods } from "./autofill.js";
import { blobstoreMethods } from "./blobstore.js";
import { browserDataMethods } from "./browserData.js";
import { browserEnvironmentMethods } from "./browserEnvironment.js";
import { browserPrivacyPresentationMethods } from "./browserPrivacyPresentation.js";
import { desktopBrowserPrivacyPresentationMethods } from "./desktopBrowserPrivacyPresentation.js";
import { browserVaultNativeMethods } from "./browserVaultNative.js";
import { browserPermissionsMethods } from "./browserPermissions.js";
import { buildMethods } from "./build.js";
import { channelMethods } from "./channel.js";
import { contentTrustMethods } from "./contentTrust.js";
import { contextIntegrityMethods } from "./contextIntegrity.js";
import { corsApprovalMethods } from "./corsApproval.js";
import { ConnectCredentialSpecSchema, credentialsMethods } from "./credentials.js";
import { docsMethods } from "./docs.js";
import { desktopEventsMethods } from "./desktopEvents.js";
import { developmentMethods } from "./development.js";
import { developmentNativeMethods } from "./developmentNative.js";
import { developmentClientExecutorMethods } from "./developmentClientExecutor.js";
import { attachedHostsMethods } from "./attachedHosts.js";
import { durableWorkMethods } from "./durableWork.js";
import { eventsMethods } from "./events.js";
import { extensionsMethods } from "./extensions.js";
import { externalOpenMethods } from "./externalOpen.js";
import { fsMethods } from "./fs.js";
import { gitInteropMethods } from "./gitInterop.js";
import { hostLifecycleMethods } from "./hostLifecycle.js";
import { hostPerformanceMethods } from "./hostPerformance.js";
import { hubControlMethods } from "./hubControl.js";
import { serverLogMethods } from "./serverLog.js";
import { menuMethods } from "./menu.js";
import { mirrorMethods } from "./mirror.js";
import { missionsMethods } from "./missions.js";
import { shellBrowserPrivacyMethods } from "./shellBrowserPrivacy.js";
import { notificationMethods } from "./notification.js";
import { panelMethods } from "./panel.js";
import { panelLogMethods } from "./panelLog.js";
import { panelContextMethods } from "./panelContext.js";
import { panelRuntimeMethods } from "./panelRuntime.js";
import { pushMethods, PushRegisterRequestSchema } from "./push.js";
import { permissionsMethods } from "./permissions.js";
import { phoneProvisioningMethods } from "./phoneProvisioning.js";
import { phoneNativeEndpointMethods } from "./phoneNativeEndpoint.js";
import { remoteCredMethods } from "./remoteCred.js";
import { reviewedClosureMethods } from "./reviewedClosure.js";
import { runtimeMethods } from "./runtime.js";
import { evalMethods } from "./eval.js";
import { evalEngineMethods } from "./evalEngine.js";
import { evalEventIngressMethods } from "./evalEventIngress.js";
import { evalExecutionRootsMethods } from "./evalExecutionRoots.js";
import { shellApprovalMethods } from "./shellApproval.js";
import { shellPresenceMethods } from "./shellPresence.js";
import { templatesMethods } from "./templates.js";
import { vcsMethods } from "./vcs.js";
import { viewMethods } from "./view.js";
import { webhookIngressMethods } from "./webhookIngress.js";
import { webhookEngineMethods } from "./webhookEngine.js";
import { workerLogMethods } from "./workerLog.js";
import { workspaceMethods } from "./workspace.js";
import { workspacePresenceMethods } from "./workspacePresence.js";
import { gadWireMethods } from "./workspaceSource.js";
import { workspaceStateMethods } from "./workspaceState.js";
import { workspaceStateEngineMethods } from "./workspaceStateEngine.js";
import { workspacePresentationMethods } from "./workspacePresentation.js";
import { RPC_PROGRESS_SEMANTICS } from "./progressSemantics.generated.js";

type ServiceTable = {
  service: string;
  file: string;
  methods: ServiceMethodSchemas;
};

const serviceTables: ServiceTable[] = [
  { service: "adblock", file: "adblock.ts", methods: adblockMethods },
  { service: "attachedHosts", file: "attachedHosts.ts", methods: attachedHostsMethods },
  { service: "account", file: "account.ts", methods: accountMethods },
  { service: "app", file: "app.ts", methods: appMethods },
  { service: "auth", file: "auth.ts", methods: authMethods },
  { service: "authority", file: "authority.ts", methods: authorityMethods },
  { service: "autofill", file: "autofill.ts", methods: autofillMethods },
  { service: "blobstore", file: "blobstore.ts", methods: blobstoreMethods },
  { service: "browserData", file: "browserData.ts", methods: browserDataMethods },
  {
    service: "browserVaultNative",
    file: "browserVaultNative.ts",
    methods: browserVaultNativeMethods,
  },
  {
    service: "browserEnvironment",
    file: "browserEnvironment.ts",
    methods: browserEnvironmentMethods,
  },
  {
    service: "browserPrivacyPresentation",
    file: "browserPrivacyPresentation.ts",
    methods: browserPrivacyPresentationMethods,
  },
  {
    service: "desktopBrowserPrivacyPresentation",
    file: "desktopBrowserPrivacyPresentation.ts",
    methods: desktopBrowserPrivacyPresentationMethods,
  },
  {
    service: "browserPermissions",
    file: "browserPermissions.ts",
    methods: browserPermissionsMethods,
  },
  { service: "build", file: "build.ts", methods: buildMethods },
  { service: "channel", file: "channel.ts", methods: channelMethods },
  { service: "contentTrust", file: "contentTrust.ts", methods: contentTrustMethods },
  {
    service: "contextIntegrity",
    file: "contextIntegrity.ts",
    methods: contextIntegrityMethods,
  },
  { service: "corsApproval", file: "corsApproval.ts", methods: corsApprovalMethods },
  { service: "credentials", file: "credentials.ts", methods: credentialsMethods },
  { service: "docs", file: "docs.ts", methods: docsMethods },
  { service: "desktopEvents", file: "desktopEvents.ts", methods: desktopEventsMethods },
  { service: "development", file: "development.ts", methods: developmentMethods },
  {
    service: "developmentNative",
    file: "developmentNative.ts",
    methods: developmentNativeMethods,
  },
  {
    service: "developmentClientExecutor",
    file: "developmentClientExecutor.ts",
    methods: developmentClientExecutorMethods,
  },
  { service: "durableWork", file: "durableWork.ts", methods: durableWorkMethods },
  { service: "events", file: "events.ts", methods: eventsMethods },
  { service: "extensions", file: "extensions.ts", methods: extensionsMethods },
  { service: "externalOpen", file: "externalOpen.ts", methods: externalOpenMethods },
  { service: "fs", file: "fs.ts", methods: fsMethods },
  { service: "gitInterop", file: "gitInterop.ts", methods: gitInteropMethods },
  { service: "hostLifecycle", file: "hostLifecycle.ts", methods: hostLifecycleMethods },
  { service: "hostPerformance", file: "hostPerformance.ts", methods: hostPerformanceMethods },
  { service: "hubControl", file: "hubControl.ts", methods: hubControlMethods },
  { service: "serverLog", file: "serverLog.ts", methods: serverLogMethods },
  { service: "menu", file: "menu.ts", methods: menuMethods },
  { service: "mirror", file: "mirror.ts", methods: mirrorMethods },
  { service: "missions", file: "missions.ts", methods: missionsMethods },
  {
    service: "shellBrowserPrivacy",
    file: "shellBrowserPrivacy.ts",
    methods: shellBrowserPrivacyMethods,
  },
  { service: "notification", file: "notification.ts", methods: notificationMethods },
  { service: "panel", file: "panel.ts", methods: panelMethods },
  { service: "panelLog", file: "panelLog.ts", methods: panelLogMethods },
  { service: "panelContext", file: "panelContext.ts", methods: panelContextMethods },
  { service: "panelRuntime", file: "panelRuntime.ts", methods: panelRuntimeMethods },
  { service: "permissions", file: "permissions.ts", methods: permissionsMethods },
  {
    service: "phoneProvisioning",
    file: "phoneProvisioning.ts",
    methods: phoneProvisioningMethods,
  },
  {
    service: "phoneNativeEndpoint",
    file: "phoneNativeEndpoint.ts",
    methods: phoneNativeEndpointMethods,
  },
  { service: "push", file: "push.ts", methods: pushMethods },
  { service: "remoteCred", file: "remoteCred.ts", methods: remoteCredMethods },
  {
    service: "reviewedClosure",
    file: "reviewedClosure.ts",
    methods: reviewedClosureMethods,
  },
  { service: "runtime", file: "runtime.ts", methods: runtimeMethods },
  { service: "eval", file: "eval.ts", methods: evalMethods },
  { service: "evalEngine", file: "evalEngine.ts", methods: evalEngineMethods },
  {
    service: "evalEventIngress",
    file: "evalEventIngress.ts",
    methods: evalEventIngressMethods,
  },
  {
    service: "evalExecutionRoots",
    file: "evalExecutionRoots.ts",
    methods: evalExecutionRootsMethods,
  },
  { service: "shellApproval", file: "shellApproval.ts", methods: shellApprovalMethods },
  { service: "shellPresence", file: "shellPresence.ts", methods: shellPresenceMethods },
  { service: "templates", file: "templates.ts", methods: templatesMethods },
  { service: "vcs", file: "vcs.ts", methods: vcsMethods },
  { service: "view", file: "view.ts", methods: viewMethods },
  { service: "webhookEngine", file: "webhookEngine.ts", methods: webhookEngineMethods },
  { service: "webhookIngress", file: "webhookIngress.ts", methods: webhookIngressMethods },
  { service: "workerLog", file: "workerLog.ts", methods: workerLogMethods },
  { service: "workspace", file: "workspace.ts", methods: workspaceMethods },
  { service: "workspaceSource", file: "workspaceSource.ts", methods: gadWireMethods },
  {
    service: "workspacePresence",
    file: "workspacePresence.ts",
    methods: workspacePresenceMethods,
  },
  { service: "workspace-state", file: "workspaceState.ts", methods: workspaceStateMethods },
  {
    service: "workspaceStateEngine",
    file: "workspaceStateEngine.ts",
    methods: workspaceStateEngineMethods,
  },
  {
    service: "workspacePresentation",
    file: "workspacePresentation.ts",
    methods: workspacePresentationMethods,
  },
];

const approvedReturnlessMethods = new Set([
  // `invokeStream` returns a live Response object from the extension streaming
  // bridge. That transport is validated by stream-level tests rather than a
  // JSON-compatible Zod return schema.
  "extensions.invokeStream",
  // A watch is likewise a live Response resource. Its NDJSON records have a
  // structural codec; the Response itself is owned and validated by RPC.
  "events.watch",
  "desktopEvents.watch",
]);

const approvedWeakReturnRoots = new Set<string>();

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
  it("declares workspace presentation receiver effects explicitly", () => {
    for (const definition of Object.values(workspacePresentationMethods)) {
      expect(definition.directEffect).toEqual({ kind: "open" });
    }
  });

  it("indexes every contract-declared progress semantic without service-specific lookup code", () => {
    const declared = Object.fromEntries(
      serviceTables.flatMap(({ service, methods }) =>
        Object.entries(methods).flatMap(([method, schema]) =>
          schema.progressSemantics
            ? [[`${service}.${method}`, schema.progressSemantics] as const]
            : []
        )
      )
    );
    expect(RPC_PROGRESS_SEMANTICS).toEqual(declared);
  });

  it("allows eval reset to omit its optional routing object", () => {
    expect(evalMethods.reset.args.safeParse([]).success).toBe(true);
    expect(evalMethods.reset.args.safeParse([{}]).success).toBe(true);
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

  it("preserves structured eval failure data through start and get", () => {
    const result = {
      success: false,
      console: "",
      error: "Project publication failed",
      failureKind: "user-code" as const,
      failureCode: "scaffold_publication_failed",
      errorData: {
        code: "scaffold_publication_failed",
        committedEventId: "event:committed",
        publicationRequest: { commandId: "command:publish" },
      },
    };

    expect(
      evalMethods.start.returns.safeParse({
        runId: "run-1",
        runDigest: "a".repeat(64),
        authorityManifestDigest: "b".repeat(64),
        status: "terminal",
        snapshot: { status: "done", result },
      }).success
    ).toBe(true);
    expect(
      evalMethods.get.returns.safeParse({
        status: "done",
        result,
      }).success
    ).toBe(true);
  });

  it("carries exact eval-kernel restart recovery through start and get", () => {
    const result = {
      success: true,
      console: "",
      scopeKeys: ["panelId"],
      kernel: {
        incarnationId: "kernel-2",
        startedAt: 10,
        event: {
          kind: "restarted" as const,
          recovery: {
            status: "complete" as const,
            restored: ["panelId"],
            lost: ["panelHandle"],
          },
        },
      },
    };

    expect(
      evalMethods.start.returns.safeParse({
        runId: "run-1",
        runDigest: "a".repeat(64),
        authorityManifestDigest: "b".repeat(64),
        status: "terminal",
        snapshot: { status: "done", result },
      }).success
    ).toBe(true);
    expect(evalMethods.get.returns.safeParse({ status: "done", result }).success).toBe(true);
    expect(evalMethods.get.returns.safeParse({ status: "cancelling" }).success).toBe(true);
    expect(evalMethods.get.returns.safeParse({ status: "cleanup-ish" }).success).toBe(false);
  });

  it("reports whether eval cancellation required a shared-scope reset", () => {
    expect(evalMethods.cancel.returns.safeParse({ ok: true, forcedReset: false }).success).toBe(
      true
    );
    expect(evalMethods.cancel.returns.safeParse({ ok: true, forcedReset: true }).success).toBe(
      true
    );
    expect(evalMethods.cancel.returns.safeParse({ ok: true }).success).toBe(false);
  });

  it("covers every service schema file in this directory", () => {
    const schemaDir = dirname(fileURLToPath(import.meta.url));
    const schemaFiles = readdirSync(schemaDir)
      .filter(
        (file) =>
          file.endsWith(".ts") &&
          !file.endsWith(".test.ts") &&
          file !== "productBuiltinServices.ts" &&
          file !== "browserPrivacy.ts" &&
          !file.startsWith("progressSemantics")
      )
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

  it("declares the exact credential-use effect on every credential mediation entrypoint", () => {
    for (const method of ["resolveCredential", "proxyFetch", "proxyGitHttp"] as const) {
      expect(credentialsMethods[method].access?.approval).toContainEqual(
        expect.objectContaining({ capability: "credential.use", tier: "gated" })
      );
    }
  });

  it("uses the protected input form as the sole credential-entry consent boundary", () => {
    for (const method of ["configureClient", "requestCredentialInput"] as const) {
      expect(credentialsMethods[method].tier.tier).toBe("open");
      expect(credentialsMethods[method].access?.approval).toHaveLength(1);
    }
  });
});

describe("argumentNames arity", () => {
  it("matches every declared argumentNames list to its args tuple's maximum arity", () => {
    const mismatches: string[] = [];
    for (const { service, methods } of serviceTables) {
      for (const [name, method] of Object.entries(methods)) {
        if (!method.argumentNames) continue;
        const arity = maxArgsArity(method.args);
        if (arity === null) {
          mismatches.push(`${service}.${name}: argumentNames on a non-tuple args schema`);
        } else if (method.argumentNames.length !== arity) {
          mismatches.push(
            `${service}.${name}: ${method.argumentNames.length} names for arity ${arity}`
          );
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("matches runtime method-catalog argumentNames to their JSON-schema tuples", () => {
    const catalogs: Record<string, Record<string, RuntimeSurfaceMethodDoc>> = {
      workers: WORKERS_RUNTIME_METHOD_CATALOG,
      panelTree: PANEL_TREE_METHOD_CATALOG,
    };
    const mismatches: string[] = [];
    for (const [namespace, catalog] of Object.entries(catalogs)) {
      for (const [name, doc] of Object.entries(catalog)) {
        if (!doc.argumentNames) continue;
        const schema = doc.argsSchema as
          | { prefixItems?: unknown[]; maxItems?: number }
          | undefined;
        const arity = Array.isArray(schema?.prefixItems)
          ? schema.prefixItems.length
          : (schema?.maxItems ?? null);
        if (arity === null) {
          mismatches.push(`${namespace}.${name}: argumentNames without a bounded args tuple`);
        } else if (doc.argumentNames.length !== arity) {
          mismatches.push(
            `${namespace}.${name}: ${doc.argumentNames.length} names for arity ${arity}`
          );
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});
