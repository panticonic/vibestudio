import { serveNativeOperations } from "@vibestudio/process-adapter";
import { FsDisk, type FsDiskScope } from "./fsDisk.js";

const ripgrepPath = process.env["VIBESTUDIO_RIPGREP_PATH"];
if (!ripgrepPath) throw new Error("Native disk worker requires an installed ripgrep path");
const disk = new FsDisk(ripgrepPath);
serveNativeOperations(
  async (method, args, signal) => {
    if (method === "closeCaller") {
      if (args.length !== 1 || typeof args[0] !== "string") throw new Error("Invalid disk caller");
      return disk.closeCaller(args[0]);
    }
    if (method !== "call" || args.length !== 3) throw new Error("Invalid disk operation");
    const [scope, operation, values] = args as [FsDiskScope, unknown, unknown];
    if (
      !scope ||
      typeof scope.root !== "string" ||
      typeof scope.panelId !== "string" ||
      typeof scope.exposeHostPaths !== "boolean" ||
      typeof operation !== "string" ||
      !Array.isArray(values)
    )
      throw new Error("Invalid disk request");
    return disk.call(scope, operation, values, signal);
  },
  () => disk.stop()
);
