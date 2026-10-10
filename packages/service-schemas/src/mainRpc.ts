import type { governanceMethods } from "./governance.js";
import type { presenceMethods } from "./presence.js";
import type { panelCdpMethods } from "./panelCdp.js";
import type { chromiumFetchMethods } from "./chromiumFetch.js";
import type { workerdInspectorMethods } from "./workerdInspector.js";
/** Schema-derived main RPC contracts. Descriptors load their receiver schemas on demand. */
import type { RpcMethod } from "@vibestudio/rpc";
import { createLazyRpcMethods, createRpcMethodCaller } from "@vibestudio/shared/rpcMethods";
import type { MethodFn, ServiceMethodSchemas } from "@vibestudio/shared/typedServiceClient";
import type { hostLifecycleMethods } from "./hostLifecycle.js";
import type { blobstoreMethods } from "./blobstore.js";
import type { shellPresenceMethods } from "./shellPresence.js";
import type { accountMethods } from "./account.js";
import type { authMethods } from "./auth.js";
import type { runtimeMethods } from "./runtime.js";
import type { workersMethods } from "./workers.js";
import type { desktopEventsMethods } from "./desktopEvents.js";
import type { buildMethods } from "./build.js";
import type { developmentMethods } from "./development.js";
import type { evalExecutionRootsMethods } from "./evalExecutionRoots.js";
import type { externalOpenMethods } from "./externalOpen.js";
import type { durableWorkMethods } from "./durableWork.js";
import type { eventsMethods } from "./events.js";
import type { hostTerminalMethods } from "./hostTerminal.js";
import type { serverLogMethods } from "./serverLog.js";
import type { webhookEngineMethods } from "./webhookEngine.js";
import type { docsMethods } from "./docs.js";
import type { gatewayMethods } from "./gateway.js";
import type { websiteHostingMethods } from "./websiteHosting.js";
import type { appMethods } from "./app.js";
import type { authorityMethods } from "./authority.js";
import type { attachedHostsMethods } from "./attachedHosts.js";
import type { developmentNativeMethods } from "./developmentNative.js";
import type { desktopBrowserPrivacyPresentationMethods } from "./desktopBrowserPrivacyPresentation.js";
import type { vcsMethods } from "./vcs.js";
import type { developmentClientExecutorMethods } from "./developmentClientExecutor.js";
import type { shellBrowserPrivacyMethods } from "./shellBrowserPrivacy.js";
import type { workerLogMethods } from "./workerLog.js";
import type { corsApprovalMethods } from "./corsApproval.js";
import type { webhookIngressMethods } from "./webhookIngress.js";
import type { notificationMethods } from "./notification.js";
import type { browserPermissionsMethods } from "./browserPermissions.js";
import type { extensionsMethods } from "./extensions.js";
import type { workspaceStateMethods } from "./workspaceState.js";
import type { adblockMethods } from "./adblock.js";
import type { permissionsMethods } from "./permissions.js";
import type { shellApprovalMethods } from "./shellApproval.js";
import type { panelContextMethods } from "./panelContext.js";
import type { templatesMethods } from "./templates.js";
import type { workspaceTemplateSourceMethods } from "./templates.js";
import type { pushMethods } from "./push.js";
import type { menuMethods } from "./menu.js";
import type { panelLogMethods } from "./panelLog.js";
import type { mobileNativeMethods } from "./mobileNative.js";
import type { viewMethods } from "./view.js";
import type { browserPrivacyPresentationMethods } from "./browserPrivacyPresentation.js";
import type { workspaceMethods } from "./workspace.js";
import type { panelRuntimeMethods } from "./panelRuntime.js";
import type { phoneNativeEndpointMethods } from "./phoneNativeEndpoint.js";
import type { remoteCredMethods } from "./remoteCred.js";
import type { browserVaultNativeMethods } from "./browserVaultNative.js";
import type { evalEventIngressMethods } from "./evalEventIngress.js";
import type { autofillMethods } from "./autofill.js";
import type { evalMethods } from "./eval.js";
import type { browserEnvironmentMethods } from "./browserEnvironment.js";
import type { hostPerformanceMethods } from "./hostPerformance.js";
import type { problemReportsMethods } from "./problemReports.js";
import type { browserDataMethods } from "./browserData.js";
import type { browserVaultMethods } from "./browserData.js";
import type { browserProductMethods } from "./browserData.js";
import type { credentialsMethods } from "./credentials.js";
import type { panelMethods } from "./panel.js";
import type { fsMethods } from "./fs.js";
import type { gitInteropMethods } from "./gitInterop.js";
import type { mirrorMethods } from "./mirror.js";
import type { evalEngineMethods } from "./evalEngine.js";
import type { workspacePresenceMethods } from "./workspacePresence.js";
import type { workspaceHubControlMethods } from "./workspaceHubControl.js";

type Methods<S extends string, M extends ServiceMethodSchemas> = {
  [K in keyof M & string as `${S}.${K}`]: MethodFn<M[K]>;
};
export type MainRpcMethods = Methods<"governance", typeof governanceMethods> &
  Methods<"presence", typeof presenceMethods> &
  Methods<"hostLifecycle", typeof hostLifecycleMethods> &
  Methods<"blobstore", typeof blobstoreMethods> &
  Methods<"shellPresence", typeof shellPresenceMethods> &
  Methods<"account", typeof accountMethods> &
  Methods<"auth", typeof authMethods> &
  Methods<"runtime", typeof runtimeMethods> &
  Methods<"workers", typeof workersMethods> &
  Methods<"desktopEvents", typeof desktopEventsMethods> &
  Methods<"build", typeof buildMethods> &
  Methods<"development", typeof developmentMethods> &
  Methods<"evalExecutionRoots", typeof evalExecutionRootsMethods> &
  Methods<"externalOpen", typeof externalOpenMethods> &
  Methods<"durableWork", typeof durableWorkMethods> &
  Methods<"events", typeof eventsMethods> &
  Methods<"hostTerminal", typeof hostTerminalMethods> &
  Methods<"serverLog", typeof serverLogMethods> &
  Methods<"webhookEngine", typeof webhookEngineMethods> &
  Methods<"docs", typeof docsMethods> &
  Methods<"gateway", typeof gatewayMethods> &
  Methods<"websiteHosting", typeof websiteHostingMethods> &
  Methods<"app", typeof appMethods> &
  Methods<"authority", typeof authorityMethods> &
  Methods<"attachedHosts", typeof attachedHostsMethods> &
  Methods<"developmentNative", typeof developmentNativeMethods> &
  Methods<"desktopBrowserPrivacyPresentation", typeof desktopBrowserPrivacyPresentationMethods> &
  Methods<"vcs", typeof vcsMethods> &
  Methods<"developmentClientExecutor", typeof developmentClientExecutorMethods> &
  Methods<"shellBrowserPrivacy", typeof shellBrowserPrivacyMethods> &
  Methods<"workerLog", typeof workerLogMethods> &
  Methods<"corsApproval", typeof corsApprovalMethods> &
  Methods<"webhookIngress", typeof webhookIngressMethods> &
  Methods<"notification", typeof notificationMethods> &
  Methods<"browserPermissions", typeof browserPermissionsMethods> &
  Methods<"extensions", typeof extensionsMethods> &
  Methods<"workspace-state", typeof workspaceStateMethods> &
  Methods<"adblock", typeof adblockMethods> &
  Methods<"permissions", typeof permissionsMethods> &
  Methods<"shellApproval", typeof shellApprovalMethods> &
  Methods<"panelContext", typeof panelContextMethods> &
  Methods<"templates", typeof templatesMethods> &
  Methods<"workspaceTemplateSource", typeof workspaceTemplateSourceMethods> &
  Methods<"push", typeof pushMethods> &
  Methods<"menu", typeof menuMethods> &
  Methods<"panelLog", typeof panelLogMethods> &
  Methods<"mobileNative", typeof mobileNativeMethods> &
  Methods<"view", typeof viewMethods> &
  Methods<"browserPrivacyPresentation", typeof browserPrivacyPresentationMethods> &
  Methods<"workspace", typeof workspaceMethods> &
  Methods<"panelRuntime", typeof panelRuntimeMethods> &
  Methods<"phoneNativeEndpoint", typeof phoneNativeEndpointMethods> &
  Methods<"remoteCred", typeof remoteCredMethods> &
  Methods<"browserVaultNative", typeof browserVaultNativeMethods> &
  Methods<"evalEventIngress", typeof evalEventIngressMethods> &
  Methods<"autofill", typeof autofillMethods> &
  Methods<"eval", typeof evalMethods> &
  Methods<"browserEnvironment", typeof browserEnvironmentMethods> &
  Methods<"hostPerformance", typeof hostPerformanceMethods> &
  Methods<"problemReports", typeof problemReportsMethods> &
  Methods<"browserData", typeof browserDataMethods> &
  Methods<"browserVault", typeof browserVaultMethods> &
  Methods<"browserProduct", typeof browserProductMethods> &
  Methods<"credentials", typeof credentialsMethods> &
  Methods<"panel", typeof panelMethods> &
  Methods<"fs", typeof fsMethods> &
  Methods<"gitInterop", typeof gitInteropMethods> &
  Methods<"mirror", typeof mirrorMethods> &
  Methods<"evalEngine", typeof evalEngineMethods> &
  Methods<"workspacePresence", typeof workspacePresenceMethods> &
  Methods<"hubControl", typeof workspaceHubControlMethods> &
  Methods<"panelCdp", typeof panelCdpMethods> &
  Methods<"chromiumFetch", typeof chromiumFetchMethods> &
  Methods<"workerdInspector", typeof workerdInspectorMethods>;

const loaders = {
  governance: async () => (await import("./governance.js")).governanceMethods,
  presence: async () => (await import("./presence.js")).presenceMethods,
  panelCdp: async () => (await import("./panelCdp.js")).panelCdpMethods,
  chromiumFetch: async () => (await import("./chromiumFetch.js")).chromiumFetchMethods,
  workerdInspector: async () => (await import("./workerdInspector.js")).workerdInspectorMethods,
  hostLifecycle: async () => (await import("./hostLifecycle.js")).hostLifecycleMethods,
  blobstore: async () => (await import("./blobstore.js")).blobstoreMethods,
  shellPresence: async () => (await import("./shellPresence.js")).shellPresenceMethods,
  account: async () => (await import("./account.js")).accountMethods,
  auth: async () => (await import("./auth.js")).authMethods,
  runtime: async () => (await import("./runtime.js")).runtimeMethods,
  workers: async () => (await import("./workers.js")).workersMethods,
  desktopEvents: async () => (await import("./desktopEvents.js")).desktopEventsMethods,
  build: async () => (await import("./build.js")).buildMethods,
  development: async () => (await import("./development.js")).developmentMethods,
  evalExecutionRoots: async () =>
    (await import("./evalExecutionRoots.js")).evalExecutionRootsMethods,
  externalOpen: async () => (await import("./externalOpen.js")).externalOpenMethods,
  durableWork: async () => (await import("./durableWork.js")).durableWorkMethods,
  events: async () => (await import("./events.js")).eventsMethods,
  hostTerminal: async () => (await import("./hostTerminal.js")).hostTerminalMethods,
  serverLog: async () => (await import("./serverLog.js")).serverLogMethods,
  webhookEngine: async () => (await import("./webhookEngine.js")).webhookEngineMethods,
  docs: async () => (await import("./docs.js")).docsMethods,
  gateway: async () => (await import("./gateway.js")).gatewayMethods,
  websiteHosting: async () => (await import("./websiteHosting.js")).websiteHostingMethods,
  app: async () => (await import("./app.js")).appMethods,
  authority: async () => (await import("./authority.js")).authorityMethods,
  attachedHosts: async () => (await import("./attachedHosts.js")).attachedHostsMethods,
  developmentNative: async () => (await import("./developmentNative.js")).developmentNativeMethods,
  desktopBrowserPrivacyPresentation: async () =>
    (await import("./desktopBrowserPrivacyPresentation.js"))
      .desktopBrowserPrivacyPresentationMethods,
  vcs: async () => (await import("./vcs.js")).vcsMethods,
  developmentClientExecutor: async () =>
    (await import("./developmentClientExecutor.js")).developmentClientExecutorMethods,
  shellBrowserPrivacy: async () =>
    (await import("./shellBrowserPrivacy.js")).shellBrowserPrivacyMethods,
  workerLog: async () => (await import("./workerLog.js")).workerLogMethods,
  corsApproval: async () => (await import("./corsApproval.js")).corsApprovalMethods,
  webhookIngress: async () => (await import("./webhookIngress.js")).webhookIngressMethods,
  notification: async () => (await import("./notification.js")).notificationMethods,
  browserPermissions: async () =>
    (await import("./browserPermissions.js")).browserPermissionsMethods,
  extensions: async () => (await import("./extensions.js")).extensionsMethods,
  "workspace-state": async () => (await import("./workspaceState.js")).workspaceStateMethods,
  adblock: async () => (await import("./adblock.js")).adblockMethods,
  permissions: async () => (await import("./permissions.js")).permissionsMethods,
  shellApproval: async () => (await import("./shellApproval.js")).shellApprovalMethods,
  panelContext: async () => (await import("./panelContext.js")).panelContextMethods,
  templates: async () => (await import("./templates.js")).templatesMethods,
  workspaceTemplateSource: async () =>
    (await import("./templates.js")).workspaceTemplateSourceMethods,
  push: async () => (await import("./push.js")).pushMethods,
  menu: async () => (await import("./menu.js")).menuMethods,
  panelLog: async () => (await import("./panelLog.js")).panelLogMethods,
  mobileNative: async () => (await import("./mobileNative.js")).mobileNativeMethods,
  view: async () => (await import("./view.js")).viewMethods,
  browserPrivacyPresentation: async () =>
    (await import("./browserPrivacyPresentation.js")).browserPrivacyPresentationMethods,
  workspace: async () => (await import("./workspace.js")).workspaceMethods,
  panelRuntime: async () => (await import("./panelRuntime.js")).panelRuntimeMethods,
  phoneNativeEndpoint: async () =>
    (await import("./phoneNativeEndpoint.js")).phoneNativeEndpointMethods,
  remoteCred: async () => (await import("./remoteCred.js")).remoteCredMethods,
  browserVaultNative: async () =>
    (await import("./browserVaultNative.js")).browserVaultNativeMethods,
  evalEventIngress: async () => (await import("./evalEventIngress.js")).evalEventIngressMethods,
  autofill: async () => (await import("./autofill.js")).autofillMethods,
  eval: async () => (await import("./eval.js")).evalMethods,
  browserEnvironment: async () =>
    (await import("./browserEnvironment.js")).browserEnvironmentMethods,
  hostPerformance: async () => (await import("./hostPerformance.js")).hostPerformanceMethods,
  problemReports: async () => (await import("./problemReports.js")).problemReportsMethods,
  browserData: async () => (await import("./browserData.js")).browserDataMethods,
  browserVault: async () => (await import("./browserData.js")).browserVaultMethods,
  browserProduct: async () => (await import("./browserData.js")).browserProductMethods,
  credentials: async () => (await import("./credentials.js")).credentialsMethods,
  panel: async () => (await import("./panel.js")).panelMethods,
  fs: async () => (await import("./fs.js")).fsMethods,
  gitInterop: async () => (await import("./gitInterop.js")).gitInteropMethods,
  mirror: async () => (await import("./mirror.js")).mirrorMethods,
  evalEngine: async () => (await import("./evalEngine.js")).evalEngineMethods,
  workspacePresence: async () => (await import("./workspacePresence.js")).workspacePresenceMethods,
  hubControl: async () => (await import("./workspaceHubControl.js")).workspaceHubControlMethods,
};
type MainMethodDescriptors = {
  [K in keyof MainRpcMethods]: RpcMethod<
    Parameters<MainRpcMethods[K]>,
    Awaited<ReturnType<MainRpcMethods[K]>>
  >;
};
const descriptors = new Map<string, RpcMethod<unknown[], unknown>>();
export const mainRpcMethods: MainMethodDescriptors = new Proxy({} as MainMethodDescriptors, {
  get(_target, property) {
    if (typeof property !== "string") return undefined;
    const previous = descriptors.get(property);
    if (previous) return previous;
    const separator = property.indexOf(".");
    const service = property.slice(0, separator);
    const method = property.slice(separator + 1);
    const loader = loaders[service as keyof typeof loaders];
    if (!loader) throw new Error(`No main service contract for ${service}`);
    const descriptor = createLazyRpcMethods(
      service,
      [method],
      loader as () => Promise<ServiceMethodSchemas>
    )[method]!;
    descriptors.set(property, descriptor);
    return descriptor;
  },
});

/** Runtime-selected operations retain unknown results and validate against the same receiver contract. */
export function mainRpcMethod(name: string): RpcMethod<unknown[], unknown> {
  return mainRpcMethods[name as keyof MainMethodDescriptors];
}

/** Bind the canonical main receiver contracts to their shared address. */
export function createMainRpcCaller(rpc: Pick<import("@vibestudio/rpc").RpcCaller, "call">) {
  return createRpcMethodCaller(rpc, "main", mainRpcMethods);
}
export type MainRpcCaller = ReturnType<typeof createMainRpcCaller>;

export type MainCaller = <K extends keyof MainRpcMethods & string>(
  method: K,
  ...args: Parameters<MainRpcMethods[K]>
) => ReturnType<MainRpcMethods[K]>;
export function createMainCaller(
  rpc: Pick<import("@vibestudio/rpc").RpcCaller, "call">
): MainCaller {
  return ((method, ...args) => rpc.call("main", mainRpcMethods[method], args)) as MainCaller;
}
