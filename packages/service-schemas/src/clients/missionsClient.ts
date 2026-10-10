import type { RpcCaller } from "@vibestudio/rpc";
import { createDurableObjectServiceClient } from "./durableObjectServiceClient.js";
import { mainRpcMethods } from "../mainRpc.js";
import { missionsRpcMethods } from "../missions.js";
import type { RpcMethodArgs, RpcMethodResult } from "@vibestudio/shared/rpcMethods";
import {
  MISSIONS_SERVICE_PROTOCOL,
  sameMissionExecution,
  type MissionExecution,
  type MissionAuthorityPlanReference,
  type MissionRecord,
  type MissionCallOptions,
  type MissionsClient,
} from "@vibestudio/automation/mission";
export type MissionRpc = Pick<RpcCaller, "call">;

export function compileMissionAuthorityPlan(
  rpc: MissionRpc,
  execution: MissionExecution,
  idempotencyKey?: string
): Promise<MissionAuthorityPlanReference> {
  return rpc.call(
    "main",
    mainRpcMethods["authority.compileAuthorityPlan"],
    [{ execution }],
    idempotencyKey ? { idempotencyKey } : undefined
  );
}

function editNeedsAuthorityPlan(
  current: Pick<MissionRecord, "charter" | "authorityPlan" | "seeded">,
  execution: MissionExecution
): boolean {
  return current.seeded === true || !sameMissionExecution(current.charter.execution, execution);
}

export function createMissionsClient(rpc: MissionRpc): MissionsClient {
  const service = createDurableObjectServiceClient(
    rpc,
    MISSIONS_SERVICE_PROTOCOL,
    missionsRpcMethods
  );
  let target: Promise<string> | null = null;
  const resolveTarget = (): Promise<string> =>
    (target ??= (async () => {
      return (await service.resolve()).targetId;
    })().catch((error: unknown) => {
      target = null;
      throw error;
    }));
  const call = async <K extends keyof typeof missionsRpcMethods & string>(
    method: K,
    args: RpcMethodArgs<(typeof missionsRpcMethods)[K]>,
    idempotencyKey?: string
  ): Promise<RpcMethodResult<(typeof missionsRpcMethods)[K]>> =>
    service.callWithOptions(method, args, idempotencyKey ? { idempotencyKey } : {});
  const planKey = (options?: MissionCallOptions) =>
    options?.idempotencyKey ? `${options.idempotencyKey}:authority-plan` : undefined;
  return {
    async observeChanges({ afterVersion, signal } = {}) {
      return await rpc.call(
        await resolveTarget(),
        missionsRpcMethods["observeChanges"],
        [{ ...(afterVersion === undefined ? {} : { afterVersion }) }],
        { ...(signal ? { signal } : {}) }
      );
    },
    overview: (options = {}) => call("overview", [options]),
    list: () => call("list", []),
    get: (missionId) => call("get", [missionId]),
    getDefault: (defaultId) => call("getDefault", [defaultId]),
    listRuns: (missionId, options = {}) => call("listRuns", [missionId, options]),
    getRun: (runId) => call("getRun", [runId]),
    async launch(input, options) {
      const authorityPlan = await compileMissionAuthorityPlan(
        rpc,
        input.charter.execution,
        planKey(options)
      );
      return call("launch", [{ ...input, authorityPlan }], options?.idempotencyKey);
    },
    async provisionDefault(defaultId, input, options) {
      const authorityPlan = await compileMissionAuthorityPlan(
        rpc,
        input.charter.execution,
        planKey(options)
      );
      return call(
        "provisionDefault",
        [defaultId, { ...input, authorityPlan }],
        options?.idempotencyKey
      );
    },
    async edit(missionId, patch, options) {
      const current = await call("get", [missionId]);
      if (!current) throw new Error(`Automation ${missionId} is unavailable`);
      const execution = patch.charter?.execution ?? current.charter.execution;
      const authorityPlan = editNeedsAuthorityPlan(current, execution)
        ? await compileMissionAuthorityPlan(rpc, execution, planKey(options))
        : undefined;
      return call(
        "edit",
        [missionId, { ...patch, ...(authorityPlan ? { authorityPlan } : {}) }],
        options?.idempotencyKey
      );
    },
    runNow: (missionId) => call("runNow", [missionId]),
    cancel: (missionId) => call("cancel", [missionId]),
    pause: (missionId) => call("pause", [missionId]),
    resume: (missionId) => call("resume", [missionId]),
    retire: (missionId) => call("retire", [missionId]),
  };
}
