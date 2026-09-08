import * as path from "node:path";
import { fileURLToPath } from "node:url";

process.env["VIBESTUDIO_APP_ROOT"] ??= path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
process.env["VIBESTUDIO_HOST_ARTIFACT_ROOT"] ??= path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../dist"
);

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = ResizeObserverMock as typeof ResizeObserver;
}
