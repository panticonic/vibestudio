import path from "node:path";

const configuredRoot = process.env["VIBESTUDIO_USERLAND_ROOT"];
if (!configuredRoot) {
  throw new Error("VIBESTUDIO_USERLAND_ROOT must name the exact Base checkout under test");
}

export const exactUserlandRoot = path.resolve(configuredRoot);
