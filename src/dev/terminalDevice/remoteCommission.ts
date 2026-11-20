import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { inspectDeploymentIdentity } from "../../../scripts/cli/remote-deployment-workflow.mjs";
import type { DeviceOperations } from "@vibestudio/shared/deviceDriver";
import { loadCliIdentity } from "../../cli/credentialStore.js";
import { bindRemoteCommission } from "../../cli/remoteCommissionWorkflow.js";

/** Assign one existing disposable hub and a fresh private terminal profile. */
export async function openOwnedRemoteCommission(
  instanceRoot: string,
  scratchRoot: string,
  signal: AbortSignal
) {
  const profile = loadCliIdentity(path.join(instanceRoot, "cli-credentials.json"));
  assert(
    profile?.kind === "device" && profile.phase === "workspace" && profile.transport === "local",
    "The managed hub needs its paired loopback device"
  );
  const origin = new URL(profile.url);
  const probe = () =>
    inspectDeploymentIdentity({
      readyFile: path.join(instanceRoot, "server-auth", "hub-ready.json"),
      port: Number(origin.port),
      workspace: profile.workspaceName,
      expectedWorkspaceId: profile.workspaceId,
    });
  signal.throwIfAborted();
  const observed = await probe();
  assert(observed.state === "ready", "The assigned managed hub is not ready");
  assert.equal(observed.identity.serverId, profile.serverId);
  assert.equal(observed.identity.workspaceId, profile.workspaceId);

  const directory = await mkdtemp(path.join(scratchRoot, "natlang-remote-commission-"));
  const credentialFile = path.join(directory, "profile.json");
  const binding = bindRemoteCommission(
    ["local"],
    {
      credentialFile,
      async pairingFor(identity) {
        assert.deepEqual(identity, observed.identity);
        return {
          invitation: {
            kind: "local-device",
            label: "Managed Natlang commissioning",
            sponsor: {
              gatewayUrl: origin.origin,
              serverId: profile.serverId,
              workspaceId: profile.workspaceId,
              workspaceName: profile.workspaceName,
              deviceId: profile.deviceId,
              refreshToken: profile.refreshToken,
            },
          },
        };
      },
    },
    {
      signal,
      async run(_command, _args, options) {
        assert(options?.capture, "The assignment only allows reusing the running hub");
        return JSON.stringify(await probe());
      },
    }
  );

  return {
    ...binding,
    identity: observed.identity,
    async verify() {
      signal.throwIfAborted();
      const saved = loadCliIdentity(credentialFile);
      const native = await probe();
      return {
        stableDeployment:
          native.state === "ready" &&
          native.identity.serverId === observed.identity.serverId &&
          native.identity.workspaceId === observed.identity.workspaceId &&
          native.identity.bootId === observed.identity.bootId &&
          native.identity.buildId === observed.identity.buildId,
        persistedNewProfile:
          saved?.kind === "device" &&
          saved.phase === "workspace" &&
          saved.deviceId !== profile.deviceId &&
          saved.serverId === profile.serverId &&
          saved.workspaceId === profile.workspaceId,
      };
    },
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

/** Host methods reached over the account's existing terminal driver transport. */
export function remoteCommissionDeviceOperations(options: {
  instanceRoot: string;
  scratchRoot: string;
  signal: AbortSignal;
}) {
  type Attempt = Awaited<ReturnType<typeof openOwnedRemoteCommission>>;
  const attempts = new Map<
    string,
    { attempt: Attempt; controller: AbortController; busy: boolean }
  >();

  const ops: DeviceOperations = {
    async remoteCommissionBegin(_args, signal) {
      const controller = new AbortController();
      const lifetime = AbortSignal.any([options.signal, controller.signal]);
      const abort = () => controller.abort(signal.reason);
      signal.throwIfAborted();
      signal.addEventListener("abort", abort, { once: true });
      try {
        const attempt = await openOwnedRemoteCommission(
          options.instanceRoot,
          options.scratchRoot,
          lifetime
        );
        if (lifetime.aborted) {
          await attempt.close();
          lifetime.throwIfAborted();
        }
        attempts.set(attempt.request.operationId, { attempt, controller, busy: false });
        return { ...attempt.request, identity: attempt.identity };
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
    async remoteCommissionStep({ operationId, step, evidence }, signal) {
      const active = attempts.get(operationId);
      if (!active) throw new Error("The terminal has no such active commissioning attempt");
      if (active.busy) throw new Error("The commissioning attempt already has an active step");
      const { attempt, controller } = active;
      const abort = () => controller.abort(signal.reason);
      signal.throwIfAborted();
      signal.addEventListener("abort", abort, { once: true });
      active.busy = true;
      try {
        const services = attempt.services;
        switch (step) {
          case "baseline":
            return await services.remoteDeploymentRead.observe(evidence);
          case "handoff":
            return await services.remoteDeploymentHandoff.open(evidence);
          case "profile":
            return await services.remoteAccessRead.observe(evidence);
          case "pair":
            return await services.remoteAccessPair.pair(evidence);
          case "route":
            return await services.remoteAccessRoute.select(evidence);
          case "child":
            return await services.remoteAccessVerify.verify(evidence);
          default:
            throw new Error("The assigned commissioning case does not allow that step");
        }
      } finally {
        active.busy = false;
        signal.removeEventListener("abort", abort);
      }
    },
    async remoteCommissionFinish({ operationId }) {
      const active = attempts.get(operationId);
      if (!active) throw new Error("The terminal has no such active commissioning attempt");
      if (active.busy) throw new Error("Wait for the active commissioning step");
      attempts.delete(operationId);
      try {
        return await active.attempt.verify();
      } finally {
        await active.attempt.close();
      }
    },
  };
  return {
    ops,
    async close() {
      const pending = [...attempts.values()];
      attempts.clear();
      for (const { controller } of pending)
        controller.abort(new Error("The terminal driver stopped"));
      const results = await Promise.allSettled(pending.map(({ attempt }) => attempt.close()));
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []
      );
      if (failures.length)
        throw new AggregateError(failures, "Commissioning profiles did not retire");
    },
  };
}
