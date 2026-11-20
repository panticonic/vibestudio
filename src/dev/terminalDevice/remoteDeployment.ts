import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { DeviceOperations } from "@vibestudio/shared/deviceDriver";
import type { Ownership } from "@vibestudio/shared/ownership";
import {
  openOwnedDeploymentTarget,
  requireInstalledDeploymentPackage,
} from "../../../scripts/lib/owned-deployment-target.mjs";
import { bindRemoteDeploymentTarget } from "../../../scripts/cli/remote-deployment-workflow.mjs";

export function remoteDeploymentDeviceOperations({
  appRoot,
  ownership,
  scratchRoot,
  signal,
}: {
  appRoot: string;
  ownership: Ownership;
  scratchRoot: string;
  signal: AbortSignal;
}) {
  type Target = Awaited<ReturnType<typeof openOwnedDeploymentTarget>>;
  type Attempt = {
    binding: ReturnType<typeof bindRemoteDeploymentTarget>;
    target: Target;
    directory: string;
    controller: AbortController;
    busy: boolean;
  };
  const attempts = new Map<string, Attempt>();

  async function retire(directory: string, target?: Target) {
    try {
      await target?.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  const ops: DeviceOperations = {
    async remoteDeploymentBegin({ intent }, invocationSignal) {
      if (intent !== "deploy" && intent !== "update")
        throw new Error("Unknown owned deployment operation");
      await requireInstalledDeploymentPackage(appRoot);
      const controller = new AbortController();
      const lifetime = AbortSignal.any([signal, controller.signal]);
      const abort = () => controller.abort(invocationSignal.reason);
      invocationSignal.throwIfAborted();
      invocationSignal.addEventListener("abort", abort, { once: true });
      let target: Target | undefined;
      let directory: string | undefined;
      try {
        directory = await mkdtemp(path.join(scratchRoot, "natlang-deployment-"));
        const assigned = await openOwnedDeploymentTarget({
          appRoot,
          ownership,
          scratchRoot: directory,
          signal: lifetime,
        });
        target = assigned;
        if (intent === "update") await assigned.start("existing-deployment");
        const initial = await assigned.observe();
        if (initial.state !== (intent === "update" ? "ready" : "inactive"))
          throw new Error("The disposable deployment did not start in its assigned state");
        lifetime.throwIfAborted();
        const binding = bindRemoteDeploymentTarget({
          intent,
          observe: assigned.observe,
          apply: () =>
            assigned.start(intent === "update" ? "updated-deployment" : "fresh-deployment"),
          signal: lifetime,
        });
        attempts.set(binding.request.operationId, {
          binding,
          target,
          directory,
          controller,
          busy: false,
        });
        return { ...binding.request, initial };
      } catch (error) {
        if (directory) await retire(directory, target);
        throw error;
      } finally {
        invocationSignal.removeEventListener("abort", abort);
      }
    },
    async remoteDeploymentStep({ operationId, step, evidence }, invocationSignal) {
      const attempt = attempts.get(operationId);
      if (!attempt || attempt.busy) throw new Error("The deployment attempt is unavailable");
      const abort = () => attempt.controller.abort(invocationSignal.reason);
      invocationSignal.throwIfAborted();
      invocationSignal.addEventListener("abort", abort, { once: true });
      attempt.busy = true;
      try {
        const { remoteDeploymentRead, remoteDeploymentApply, remoteDeploymentVerify } =
          attempt.binding.services;
        switch (step) {
          case "baseline":
            return await remoteDeploymentRead.observe(evidence);
          case "apply":
            return await remoteDeploymentApply.apply(evidence);
          case "verify":
            return await remoteDeploymentVerify.verify(evidence);
          default:
            throw new Error("Unknown deployment step");
        }
      } finally {
        attempt.busy = false;
        invocationSignal.removeEventListener("abort", abort);
      }
    },
    async remoteDeploymentFinish({ operationId }) {
      const attempt = attempts.get(operationId);
      if (!attempt || attempt.busy) throw new Error("The deployment attempt is unavailable");
      attempts.delete(operationId);
      try {
        return await attempt.target.observe();
      } finally {
        await retire(attempt.directory, attempt.target);
      }
    },
  };
  return {
    ops,
    async close() {
      const pending = [...attempts.values()];
      attempts.clear();
      for (const { controller } of pending)
        controller.abort(new Error("The terminal deployment driver stopped"));
      const results = await Promise.allSettled(
        pending.map(({ directory, target }) => retire(directory, target))
      );
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []
      );
      if (failures.length) throw new AggregateError(failures, "Deployment targets did not retire");
    },
  };
}
