/**
 * The wrangler configuration of the runtime application (router, worker host,
 * UniversalDO, product Durable Object classes) and the class secrets that go
 * with it. A pure function of its inputs, so the manager and the tests that
 * stand a node up on the real application deploy the same thing.
 */
import {
  classSecretName,
  LIFECYCLE_SECRET,
  RPC_AUTH_TOKEN,
  RUNTIME_SCRIPT,
  UNIVERSAL_DO_LOADER_SECRET,
} from "./runtimeNames.js";

export interface RuntimeDeployment {
  readonly config: Record<string, unknown> & { readonly name: string };
  /** Class secrets to store (name -> value) before the deployment is published. */
  readonly secrets: Readonly<Record<string, string>>;
}

export interface RuntimeDeploymentInput {
  readonly compatibility: {
    readonly compatibilityDate: string;
    readonly compatibilityFlags: readonly string[];
  };
  /** Product Durable Object classes, each with its own credential and env. */
  readonly classes: ReadonlyArray<{
    readonly className: string;
    /** The class's bearer token: a class secret, seen by that class alone. */
    readonly rpcToken: string;
    /** Non-secret per-class environment (names of units, never credentials). */
    readonly env: Readonly<Record<string, string>>;
    /** Whether the class's isolates may generate code from strings. */
    readonly codegen: boolean;
    /** Whether the class may keep an object resident (`ctx.residency.hold()`). */
    readonly residency: boolean;
  }>;
  /** UniversalDO's loader and lifecycle secret: a class secret of that class. */
  readonly doLoaderSecret: string;
  /** Script variables: the router's and the worker host's (not DO classes). */
  readonly vars: Readonly<Record<string, unknown>>;
  /** The source namespace of product classes (their binding names). */
  readonly internalSource?: string;
}

export function buildRuntimeDeployment(input: RuntimeDeploymentInput): RuntimeDeployment {
  const source = input.internalSource ?? "vibestudio/internal";
  const doBindingNames: Record<string, string> = {};
  const bindings: Array<{ name: string; class_name: string }> = [
    { name: "UNIVERSAL_DO", class_name: "UniversalDO" },
  ];
  const internalEnv: Record<string, Readonly<Record<string, string>>> = {};
  const classes: Record<string, { codegen?: true; residency?: true; secrets: string[] }> = {};
  const secrets: Record<string, string> = {};
  // Credentials a single class holds are class secrets: sealed in the bucket,
  // opened by the node for that class only, never in the deployment manifest
  // or another class's env. The router and the worker host are not Durable
  // Object classes, so what they hold stays a variable.
  const classSecret = (className: string, name: string, value: string): void => {
    const binding = classSecretName(name, className);
    secrets[binding] = value;
    (classes[className] ??= { secrets: [] }).secrets.push(binding);
  };
  classSecret("UniversalDO", UNIVERSAL_DO_LOADER_SECRET, input.doLoaderSecret);
  for (const cls of input.classes) {
    const bindingName = `do_${source.replace(/[^a-zA-Z0-9_]/g, "_")}_${cls.className}`;
    doBindingNames[`${source}:${cls.className}`] = bindingName;
    bindings.push({ name: bindingName, class_name: cls.className });
    classSecret(cls.className, RPC_AUTH_TOKEN, cls.rpcToken);
    // The host's authority to delete this class's retired objects' storage.
    classSecret(cls.className, LIFECYCLE_SECRET, input.doLoaderSecret);
    internalEnv[cls.className] = cls.env;
    // Eval compiles agent code with the isolate's own `new Function`. Only a
    // class the deployment declares gets code generation; its isolates are a
    // separate pool, so no other class can evaluate (celld docs/fork/codegen.md).
    if (cls.codegen) (classes[cls.className] ??= { secrets: [] }).codegen = true;
    // A heap that cannot be rebuilt from storage (the notebook kernel) is kept
    // resident by an explicit hold; celld ends it only on a drain, a swap or an
    // operator revocation (celld docs/services/residency.md).
    if (cls.residency) (classes[cls.className] ??= { secrets: [] }).residency = true;
  }
  const classNames = input.classes.map((cls) => cls.className);
  return {
    secrets,
    config: {
      name: RUNTIME_SCRIPT,
      compatibility_date: input.compatibility.compatibilityDate,
      compatibility_flags: [...input.compatibility.compatibilityFlags],
      worker_loaders: [{ binding: "LOADER" }],
      durable_objects: { bindings },
      migrations: [{ tag: "v1", new_sqlite_classes: ["UniversalDO", ...classNames] }],
      services: [
        { binding: "WORKER_HOST", service: RUNTIME_SCRIPT, entrypoint: "WorkerHost" },
        {
          binding: "EXECUTABLE_PREPARATION",
          service: RUNTIME_SCRIPT,
          entrypoint: "ExecutablePreparation",
        },
      ],
      celld: { durable_objects: classes },
      vars: { ...input.vars, RUNTIME_DO_BINDINGS: doBindingNames, INTERNAL_DO_ENV: internalEnv },
    },
  };
}
