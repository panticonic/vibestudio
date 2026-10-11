/** Exercises import, activation, and owned shutdown in the native workspace. */
export function generateExtensionSmokeScript(runtimeExternalDeps: string[]): string {
  return `
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const bundlePath = process.env.VIBESTUDIO_EXTENSION_SMOKE_BUNDLE;
if (!bundlePath) throw new Error("Missing native smoke bundle");
const runtimeExternalDeps = ${JSON.stringify(runtimeExternalDeps)};
const require = createRequire(pathToFileURL(bundlePath).href);
for (const dep of runtimeExternalDeps) {
  require.resolve(dep);
}
function createAsyncNullProxy() {
  return new Proxy(Object.create(null), {
    get(_target, prop) {
      if (typeof prop !== "string" || prop === "then") return undefined;
      return async () => null;
    },
  });
}
function createExtensionSmokeContext() {
  const asyncNull = createAsyncNullProxy();
  const storage = new Proxy(Object.create(null), {
    get(_target, prop) {
      if (prop === "root") return process.cwd();
      if (prop === "readdir") return async () => [];
      if (prop === "readFile") {
        return async () => {
          const error = new Error("Smoke storage entry does not exist");
          error.code = "ENOENT";
          throw error;
        };
      }
      if (typeof prop !== "string" || prop === "then") return undefined;
      return async () => undefined;
    },
  });
  return {
    name: "smoke-test",
    version: "0.0.0",
    storage,
    fs: asyncNull,
    git: asyncNull,
    panel: asyncNull,
    workspace: {
      async getInfo() {
        return {
          id: "smoke",
          name: "smoke",
          path: process.cwd(),
          contextProjectionsPath: process.cwd(),
        };
      },
    },
    rpc: {
      async call(_target, method) {
        if (method === "workspace.getConfig") return { id: "smoke" };
        return null;
      },
    },
    workers: {
      listServices: asyncNull,
      resolveService: asyncNull,
      resolveDurableObject: asyncNull,
    },
    credentials: asyncNull,
    db: asyncNull,
    webhooks: asyncNull,
    approvals: {
      async request() {
        return { kind: "dismissed" };
      },
      async revoke() {
        return false;
      },
      async list() {
        return [];
      },
    },
    notifications: asyncNull,
    extensions: {
      use: () => createAsyncNullProxy(),
      on: () => ({ dispose() {} }),
      list: async () => [],
    },
    invocation: { current: () => null },
    subscriptions: [],
    log: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    health: {
      report() {},
      healthy() {},
      degraded() {},
      unhealthy() {},
    },
    emit() {},
  };
}
const mod = await import(pathToFileURL(bundlePath).href);
const context = createExtensionSmokeContext();
const failures = [];
try {
  const activate = mod["activate"];
  if (typeof activate === "function") {
    const api = await activate(context);
    if (api !== undefined && (api === null || typeof api !== "object")) {
      throw new Error("activate() must return an object or undefined");
    }
  }
} catch (error) {
  failures.push(error);
} finally {
  // Activation owns its subscriptions even when it fails before returning an
  // API. Smoke the same shutdown contract as the installed extension runtime:
  // invoke every disposer and deactivate, then join their actual completion.
  const deactivate = mod["deactivate"];
  const outcomes = await Promise.allSettled([
    ...(typeof deactivate === "function" ? [Promise.resolve().then(() => deactivate())] : []),
    ...context.subscriptions.reverse().map(resource =>
      Promise.resolve().then(() => resource.dispose())),
  ]);
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") failures.push(outcome.reason);
  }
}
if (failures.length === 1) throw failures[0];
if (failures.length > 1) {
  throw new AggregateError(failures, "Extension activation smoke and shutdown failed", {
    cause: failures[0],
  });
}
`;
}
