import { NativeOperationPort, type ProcessAdapter } from "@vibestudio/process-adapter";
import type { FsDiskPort } from "./fsDisk.js";

/** This private port never receives a ServiceContext or semantic capability. */
export function createFsDiskPort(process: ProcessAdapter): FsDiskPort & { retire(): void } {
  const port = new NativeOperationPort(process);
  return {
    call: (scope, method, args, signal) =>
      port.call(
        "call",
        [
          { root: scope.root, panelId: scope.panelId, exposeHostPaths: scope.exposeHostPaths },
          method,
          args,
        ],
        signal
      ),
    closeCaller: async (callerId, signal) => {
      await port.call("closeCaller", [callerId], signal);
    },
    retire: () => port.retire(),
  };
}
