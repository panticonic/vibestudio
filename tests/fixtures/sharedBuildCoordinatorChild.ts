import { SharedBuildCoordinator } from "../../src/server/buildV2/sharedBuildCoordinator.js";
import {
  BuildPriorityOwner,
  type BuildPriority,
} from "../../src/server/buildV2/builderLifetime.js";
import { serializeRpcFailure } from "@vibestudio/rpc";
import { closeDerivedCacheCoordinators } from "@vibestudio/shared/derivedCache";

const coordinator = new SharedBuildCoordinator(process.argv[2]!, Number(process.argv[3]));
const gates = new Map<string, (failure?: string) => void>();
const controllers = new Map<string, AbortController>();
const demands = new Map<string, BuildPriorityOwner>();
const pending = new Set<Promise<unknown>>();
process.on(
  "message",
  (message: {
    command: string;
    id: string;
    key: string;
    priority: BuildPriority;
    failure?: string;
    slot?: boolean;
  }) => {
    if (message.command === "release") {
      gates.get(message.id)?.(message.failure);
      return;
    }
    if (message.command === "cancel") {
      controllers.get(message.id)?.abort(new Error("request explicitly cancelled"));
      return;
    }
    if (message.command === "promote") {
      demands.get(message.id)?.promote(message.priority);
      return;
    }
    if (message.command === "close") {
      void Promise.allSettled(pending).then(async () => {
        coordinator.close();
        await closeDerivedCacheCoordinators();
        process.disconnect();
      });
      return;
    }
    const controller = new AbortController();
    const priority = new BuildPriorityOwner(message.priority);
    controllers.set(message.id, controller);
    demands.set(message.id, priority);
    const produce = async () => {
      process.send!({ type: "entered", id: message.id });
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", abort, { once: true });
        gates.set(message.id, (failure) => {
          controller.signal.removeEventListener("abort", abort);
          if (failure) reject(Object.assign(new Error(failure), { code: "ECOMPILER" }));
          else resolve();
        });
      });
      return "artifact";
    };
    const operation = (
      message.command === "slot"
        ? coordinator.withSlot(priority, controller.signal, produce)
        : coordinator.run(message.key, priority, controller.signal, (compilerPriority) =>
            message.slot
              ? coordinator.withSlot(compilerPriority, controller.signal, produce)
              : produce()
          )
    )
      .then(
        (result) => process.send!({ type: "complete", id: message.id, result }),
        (error) =>
          process.send!({ type: "failed", id: message.id, failure: serializeRpcFailure(error) })
      )
      .finally(() => {
        pending.delete(operation);
        gates.delete(message.id);
        controllers.delete(message.id);
        demands.delete(message.id);
      });
    pending.add(operation);
    process.send!({ type: "admitted", id: message.id });
  }
);
process.send!({ type: "ready" });
