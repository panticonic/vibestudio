/**
 * Panel runtime factory — extends createBaseRuntime with panel-specific features.
 *
 * Adds: stateArgs bridge, parent handles, panel lifecycle methods.
 */

import type { RpcTransport } from "@natstack/rpc";
import { createBaseRuntime, type BaseRuntimeDeps } from "./createBaseRuntime.js";
import {
  noopParent,
  type PanelContract,
  type EndpointInfo,
  type GitConfig,
  type Rpc,
} from "../core/index.js";
import type { GatewayConfig } from "../shared/globals.js";
import { createParentHandle, createParentHandleFromContract } from "../shared/handles.js";
import type { ParentHandle, ParentHandleFromContract } from "../core/index.js";
import type { RuntimeFs, ThemeAppearance } from "../types.js";
import { _applyStateArgsFromHost, _initStateArgsRuntime } from "../panel/stateArgs.js";
import { registerAgentApi } from "../panel/agentApi.js";

export interface RuntimeDeps {
  selfId: string;
  createTransport: () => RpcTransport;
  entityId: string;
  id?: string;
  slotId?: string;
  contextId: string;
  parentId: string | null;
  parentEntityId?: string | null;
  initialTheme: ThemeAppearance;
  fs: RuntimeFs;
  setupGlobals?: () => void;
  gatewayConfig?: GatewayConfig | null;
  gitConfig?: GitConfig | null;
}

export function createRuntime(deps: RuntimeDeps) {
  const entityId = deps.entityId;
  const slotId = deps.slotId ?? entityId;
  const parentRuntimeId = deps.parentEntityId ?? deps.parentId;
  const base = createBaseRuntime({ ...deps, id: entityId });
  const shell = (globalThis as any).__natstackShell ?? (globalThis as any).__natstackElectron;

  _initStateArgsRuntime(slotId, (service, method, args) => base.rpc.call(service, method, args));
  registerAgentApi(shell);
  if (typeof shell?.addEventListener === "function") {
    shell.addEventListener((event: string, payload: unknown) => {
      if (event === "runtime:stateArgsChanged") {
        _applyStateArgsFromHost((payload ?? {}) as Record<string, unknown>);
      }
    });
  }

  const parentHandleOrNull = parentRuntimeId ? createParentHandle({ rpc: base.rpc, parentId: parentRuntimeId }) : null;
  const parent: ParentHandle = parentHandleOrNull ?? noopParent;

  const getParent = <
    T extends Rpc.ExposedMethods = Rpc.ExposedMethods,
    E extends Rpc.RpcEventMap = Rpc.RpcEventMap,
    EmitE extends Rpc.RpcEventMap = Rpc.RpcEventMap
  >(): ParentHandle<T, E, EmitE> | null => {
    return parentHandleOrNull as ParentHandle<T, E, EmitE> | null;
  };

  const getParentWithContract = <C extends PanelContract>(contract: C): ParentHandleFromContract<C> | null => {
    return createParentHandleFromContract(getParent(), contract);
  };

  return {
    id: base.id,
    entityId: base.id,
    slotId,
    parentId: deps.parentId,
    parentEntityId: deps.parentEntityId ?? null,

    rpc: base.rpc,
    fs: base.fs,
    workers: base.workers,

    parent,
    getParent,
    getParentWithContract,

    onConnectionError: base.onConnectionError,

    getInfo: () => shell.getInfo() as Promise<EndpointInfo>,
    focusPanel: (panelId: string) => shell.focusPanel(panelId),
    getWorkspaceTree: base.getWorkspaceTree,
    listBranches: base.listBranches,
    listCommits: base.listCommits,

    getTheme: base.getTheme,
    onThemeChange: base.onThemeChange,

    onFocus: base.onFocus,

    exposeMethod: base.exposeMethod,

    gitConfig: base.gitConfig,
    contextId: base.contextId,
  };
}

export type Runtime = ReturnType<typeof createRuntime>;
