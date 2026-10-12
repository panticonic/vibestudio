/**
 * Shared validator for declarative trusted workspace-unit manifests.
 *
 * Extensions and apps are both build-gated, approval-gated workspace units.
 * This module keeps their fail-closed package.json validation in one place so
 * build, reconcile/install, and boot checks cannot drift by unit kind.
 */

import { validateWebsiteMethodPolicy, type WebsiteMethodPolicy } from "@vibestudio/rpc";
import { isSemanticEmoji, isUnitIconAssetPath } from "./panel/icon.js";

export type UnitKind = "extension" | "app";
export type WorkspaceAppTarget = "electron" | "react-native" | "terminal";

export type ExtensionMethodAuthorityDeclaration =
  | { website: WebsiteMethodPolicy; effect: { kind: "open" } }
  | {
      website: WebsiteMethodPolicy;
      effect: {
        kind: "userland-capability";
        capability: string;
        resource: { kind: "receiver" };
      };
    };

/** Parse the exact public extension-method set without executing extension code. */
export function parseExtensionMethodAuthority(
  value: unknown,
  label: string
): Readonly<Record<string, ExtensionMethodAuthorityDeclaration>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UnitManifestError(
      `${label} must be an object keyed by public method`,
      "MANIFEST_METHOD_AUTHORITY"
    );
  }
  const result: Record<string, ExtensionMethodAuthorityDeclaration> = {};
  for (const [method, raw] of Object.entries(value)) {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(method)) {
      throw new UnitManifestError(
        `${label} key ${JSON.stringify(method)} is not a method name`,
        "MANIFEST_METHOD_AUTHORITY"
      );
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new UnitManifestError(
        `${label}.${method} must contain one effect and an explicit website policy`,
        "MANIFEST_METHOD_AUTHORITY"
      );
    }
    const declaration = raw as Record<string, unknown>;
    if (Object.keys(declaration).sort().join(",") !== "effect,website") {
      throw new UnitManifestError(
        `${label}.${method} must contain one effect and an explicit website policy`,
        "MANIFEST_METHOD_AUTHORITY"
      );
    }
    const website = declaration["website"];
    try {
      validateWebsiteMethodPolicy(website, `${label}.${method}`);
    } catch (error) {
      throw new UnitManifestError(String(error), "MANIFEST_METHOD_AUTHORITY");
    }
    const effect = declaration["effect"];
    if (!effect || typeof effect !== "object" || Array.isArray(effect)) {
      throw new UnitManifestError(
        `${label}.${method}.effect is invalid`,
        "MANIFEST_METHOD_AUTHORITY"
      );
    }
    const record = effect as Record<string, unknown>;
    if (record["kind"] === "open" && Object.keys(record).length === 1) {
      result[method] = { website, effect: { kind: "open" } };
      continue;
    }
    const resource = record["resource"];
    if (
      record["kind"] !== "userland-capability" ||
      Object.keys(record).sort().join(",") !== "capability,kind,resource" ||
      typeof record["capability"] !== "string" ||
      !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(record["capability"]) ||
      !resource ||
      typeof resource !== "object" ||
      Array.isArray(resource) ||
      (resource as Record<string, unknown>)["kind"] !== "receiver" ||
      Object.keys(resource as Record<string, unknown>).length !== 1
    ) {
      throw new UnitManifestError(
        `${label}.${method}.effect must be open or a receiver-bound userland capability`,
        "MANIFEST_METHOD_AUTHORITY"
      );
    }
    result[method] = {
      website,
      effect: {
        kind: "userland-capability",
        capability: record["capability"],
        resource: { kind: "receiver" },
      },
    };
  }
  return Object.freeze(result);
}

/**
 * The `vibestudio.terminal` block of a terminal app: a worker whose Durable
 * Object renders Ink inside workerd and serves the terminal session protocol
 * (`@workspace/terminal-host-protocol`). Declaring it does two things:
 *
 * - the build aliases `yoga-layout`/`signal-exit`/`terminal-size` to the
 *   `@workspace/terminal-shim` replacements and emits `yoga.wasm`, which
 *   `workerdManager` attaches as a module binding;
 * - the terminal browser's launcher lists the worker as an app the user can
 *   start, using `title`, `description` and `icon`.
 */
export interface WorkerTerminalConfig {
  /** Only "ink" is supported. */
  renderer: "ink";
  /** Name shown in the terminal browser's launcher and tab strip. */
  title: string;
  /** One sentence telling the user what the app is for. */
  description?: string;
  /** One semantic emoji (terminals cannot show image icons). */
  icon?: string;
  /**
   * The session Durable Object class. Optional when the worker declares
   * exactly one durable class.
   */
  className: string;
}

/**
 * Read and validate the `vibestudio.terminal` block of a worker manifest.
 * Returns null when the worker is not a terminal app; throws an actionable
 * `UnitManifestError` when the block is present but malformed.
 */
export function workerTerminalConfig(
  vibestudio: Record<string, unknown> | undefined | null,
  unitName = "worker"
): WorkerTerminalConfig | null {
  const terminal = vibestudio?.["terminal"];
  if (terminal === undefined || terminal === null) return null;
  const fail = (message: string, code: string): never => {
    throw new UnitManifestError(`Terminal app ${unitName}: ${message}`, code);
  };
  if (typeof terminal !== "object" || Array.isArray(terminal)) {
    fail("vibestudio.terminal must be an object", "MANIFEST_TERMINAL_BLOCK");
  }
  const record = terminal as Record<string, unknown>;
  const known = new Set(["renderer", "title", "description", "icon", "className"]);
  for (const key of Object.keys(record)) {
    if (!known.has(key)) {
      fail(
        `unknown field vibestudio.terminal.${key} (allowed: ${[...known].join(", ")})`,
        "MANIFEST_TERMINAL_FIELD"
      );
    }
  }
  if (record["renderer"] !== "ink") {
    fail('vibestudio.terminal.renderer must be "ink"', "MANIFEST_TERMINAL_RENDERER");
  }
  const title = record["title"];
  if (typeof title !== "string" || title.trim().length === 0 || title.length > 60) {
    fail(
      "vibestudio.terminal.title must be a non-empty name of at most 60 characters (shown in the launcher)",
      "MANIFEST_TERMINAL_TITLE"
    );
  }
  const description = record["description"];
  if (
    description !== undefined &&
    (typeof description !== "string" || description.trim().length === 0 || description.length > 200)
  ) {
    fail(
      "vibestudio.terminal.description must be one non-empty sentence of at most 200 characters",
      "MANIFEST_TERMINAL_DESCRIPTION"
    );
  }
  const icon = record["icon"];
  if (icon !== undefined && (typeof icon !== "string" || !isSemanticEmoji(icon))) {
    fail("vibestudio.terminal.icon must be one emoji", "MANIFEST_TERMINAL_ICON");
  }
  const durable = vibestudio?.["durable"] as
    | { classes?: Array<{ className?: unknown }> }
    | undefined;
  const classes = (durable?.classes ?? [])
    .map((entry) => entry?.className)
    .filter((name): name is string => typeof name === "string");
  const declared = record["className"];
  let className: string;
  if (declared === undefined) {
    if (classes.length !== 1) {
      fail(
        classes.length === 0
          ? "a terminal app must declare its session Durable Object in vibestudio.durable.classes"
          : `set vibestudio.terminal.className to one of ${classes.join(", ")}`,
        "MANIFEST_TERMINAL_CLASS"
      );
    }
    className = classes[0]!;
  } else {
    if (typeof declared !== "string" || !classes.includes(declared)) {
      fail(
        `vibestudio.terminal.className must name a class in vibestudio.durable.classes (${classes.join(", ") || "none declared"})`,
        "MANIFEST_TERMINAL_CLASS"
      );
    }
    className = declared as string;
  }
  return {
    renderer: "ink",
    title: (title as string).trim(),
    ...(typeof description === "string" ? { description: description.trim() } : {}),
    ...(typeof icon === "string" ? { icon } : {}),
    className,
  };
}

/** Whether a worker declares a `vibestudio.terminal` block (validated by `workerTerminalConfig`). */
export function isTerminalWorker(
  vibestudio: Record<string, unknown> | undefined | null,
  unitName?: string
): boolean {
  return workerTerminalConfig(vibestudio, unitName) !== null;
}

type NativeAppHost = "electron" | "react-native";

interface AppCapabilityDescriptor {
  targets: readonly WorkspaceAppTarget[];
  nativeHosts?: readonly NativeAppHost[];
}

/**
 * One catalog owns both the manifest vocabulary and concrete native-host
 * support. A target may recognize a capability without every host having
 * implemented it; loaders must use the derived native-host set as well as the
 * target vocabulary.
 */
export const APP_CAPABILITY_CATALOG = {
  "native-menus": { targets: ["electron"], nativeHosts: ["electron"] },
  notifications: {
    targets: ["electron", "react-native"],
    nativeHosts: ["electron", "react-native"],
  },
  tray: { targets: ["electron"] },
  "global-shortcut": { targets: ["electron"] },
  "fs-read": {
    targets: ["electron", "react-native"],
    nativeHosts: ["electron"],
  },
  "fs-write": {
    targets: ["electron", "react-native"],
    nativeHosts: ["electron"],
  },
  clipboard: {
    targets: ["electron", "react-native", "terminal"],
    nativeHosts: ["react-native"],
  },
  dialog: { targets: ["electron"] },
  "open-external": {
    targets: ["electron", "react-native", "terminal"],
    nativeHosts: ["electron", "react-native"],
  },
  "browser-import": {
    targets: ["react-native"],
    nativeHosts: ["react-native"],
  },
  "window-management": { targets: ["electron"], nativeHosts: ["electron"] },
  camera: { targets: ["electron", "react-native"] },
  microphone: { targets: ["electron"] },
  "screen-capture": { targets: ["electron"] },
  location: { targets: ["electron"] },
  "panel-hosting": {
    targets: ["electron", "react-native"],
    nativeHosts: ["electron"],
  },
  "incoming-pair-links": { targets: ["electron"], nativeHosts: ["electron"] },
  keychain: { targets: ["react-native"], nativeHosts: ["react-native"] },
  "connection-management": { targets: ["react-native", "terminal"] },
} as const satisfies Record<string, AppCapabilityDescriptor>;

export type AppCapability = keyof typeof APP_CAPABILITY_CATALOG;

const appCapabilities = Object.keys(APP_CAPABILITY_CATALOG) as AppCapability[];
const capabilitiesForTarget = (target: WorkspaceAppTarget): readonly AppCapability[] =>
  Object.freeze(
    appCapabilities.filter((capability) =>
      (APP_CAPABILITY_CATALOG[capability].targets as readonly WorkspaceAppTarget[]).includes(target)
    )
  );
const capabilitiesForNativeHost = (host: NativeAppHost): readonly AppCapability[] =>
  Object.freeze(
    appCapabilities.filter((capability) =>
      (APP_CAPABILITY_CATALOG[capability] as AppCapabilityDescriptor).nativeHosts?.includes(host)
    )
  );

export const APP_CAPABILITIES_BY_TARGET = Object.freeze({
  electron: capabilitiesForTarget("electron"),
  "react-native": capabilitiesForTarget("react-native"),
  terminal: capabilitiesForTarget("terminal"),
}) satisfies Record<WorkspaceAppTarget, readonly AppCapability[]>;

export const APP_CAPABILITIES_BY_NATIVE_HOST = Object.freeze({
  electron: capabilitiesForNativeHost("electron"),
  "react-native": capabilitiesForNativeHost("react-native"),
}) satisfies Record<NativeAppHost, readonly AppCapability[]>;

export class UnitManifestError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "UnitManifestError";
    this.code = code;
  }
}

/** Validate the common icon field before authoring or consuming unit metadata. */
export function validateUnitIconDeclaration(icon: unknown): asserts icon is string | undefined {
  if (
    icon !== undefined &&
    (typeof icon !== "string" || (!isSemanticEmoji(icon) && !isUnitIconAssetPath(icon)))
  ) {
    throw new UnitManifestError(
      'vibestudio.icon must be one semantic emoji or a safe unit-relative image path such as "./assets/icon.svg". Catalog IDs are authoring inputs only: use prepareProjects or setUnitIcon from @workspace-skills/workspace-dev to materialize the artwork.',
      "MANIFEST_ICON"
    );
  }
}

export interface UnitManifestValidationOptions {
  /** Display name used in error messages, typically the package name. */
  unitName: string;
}

export interface UnitManifestDescriptor {
  kind: UnitKind;
  label: string;
}

export const extensionUnitManifestDescriptor: UnitManifestDescriptor = {
  kind: "extension",
  label: "Extension",
};

export const appUnitManifestDescriptor: UnitManifestDescriptor = {
  kind: "app",
  label: "App",
};

const LOCATION_CONFIG_BLOCKS = ["extension", "app"] as const;

function assertRecord(
  value: unknown,
  label: string,
  options: UnitManifestValidationOptions
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UnitManifestError(
      `${label} ${options.unitName} is missing the vibestudio manifest block`,
      "MANIFEST_MISSING"
    );
  }
  return value as Record<string, unknown>;
}

function assertOptionalString(value: unknown, message: string, code: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new UnitManifestError(message, code);
  }
  return value;
}

function assertNoForeignLocationConfig(
  record: Record<string, unknown>,
  descriptor: UnitManifestDescriptor,
  options: UnitManifestValidationOptions
): void {
  const foreignBlocks = LOCATION_CONFIG_BLOCKS.filter(
    (key) => key !== descriptor.kind && record[key] !== undefined && record[key] !== null
  );
  if (foreignBlocks.length > 0) {
    throw new UnitManifestError(
      `${descriptor.label} ${options.unitName} cannot declare configuration for ${foreignBlocks.join(", ")}; its location fixes its unit kind`,
      "MANIFEST_KIND"
    );
  }
}

function validateInlineSourcemap(
  record: Record<string, unknown>,
  descriptor: UnitManifestDescriptor,
  options: UnitManifestValidationOptions
): void {
  if (record["sourcemap"] === false) {
    throw new UnitManifestError(
      `${descriptor.label} ${options.unitName} must enable sourcemaps`,
      "MANIFEST_SOURCEMAP"
    );
  }
}

function validateExtensionBlock(
  record: Record<string, unknown>,
  options: UnitManifestValidationOptions
): void {
  const extension = record["extension"] as
    | {
        activationEvents?: unknown;
        dependencyMode?: unknown;
        streamingMethods?: unknown;
        providerContracts?: unknown;
        methodAuthority?: unknown;
        contributes?: unknown;
      }
    | undefined;

  const events = extension?.activationEvents;
  if (events !== undefined) {
    if (
      !Array.isArray(events) ||
      events.length !== 1 ||
      (events[0] !== "*" && events[0] !== "onInvoke")
    ) {
      throw new UnitManifestError(
        `Extension ${options.unitName} activationEvents must be exactly ["*"] or ["onInvoke"]`,
        "MANIFEST_ACTIVATION"
      );
    }
  }

  const dependencyMode = extension?.dependencyMode;
  if (
    dependencyMode !== undefined &&
    dependencyMode !== "auto" &&
    dependencyMode !== "bundle" &&
    dependencyMode !== "external"
  ) {
    throw new UnitManifestError(
      `Extension ${options.unitName} dependencyMode must be "auto", "bundle", or "external"`,
      "MANIFEST_DEPENDENCY_MODE"
    );
  }

  const streamingMethods = extension?.streamingMethods;
  if (
    streamingMethods !== undefined &&
    (!Array.isArray(streamingMethods) ||
      streamingMethods.some((method) => typeof method !== "string"))
  ) {
    throw new UnitManifestError(
      `Extension ${options.unitName} streamingMethods must be an array of method names`,
      "MANIFEST_STREAMING_METHODS"
    );
  }

  const providerContracts = extension?.providerContracts;
  if (providerContracts !== undefined) {
    if (
      !providerContracts ||
      typeof providerContracts !== "object" ||
      Array.isArray(providerContracts)
    ) {
      throw new UnitManifestError(
        `Extension ${options.unitName} providerContracts must be an object keyed by provider slot`,
        "MANIFEST_PROVIDER_CONTRACTS"
      );
    }
    for (const [provider, declaration] of Object.entries(providerContracts)) {
      if (!/^[a-z][A-Za-z0-9]*$/.test(provider)) {
        throw new UnitManifestError(
          `Extension ${options.unitName} providerContracts key ${JSON.stringify(provider)} is not a valid provider slot`,
          "MANIFEST_PROVIDER_CONTRACTS"
        );
      }
      if (!declaration || typeof declaration !== "object" || Array.isArray(declaration)) {
        throw new UnitManifestError(
          `Extension ${options.unitName} providerContracts.${provider} must be an object with methods`,
          "MANIFEST_PROVIDER_CONTRACTS"
        );
      }
      const contract = declaration as Record<string, unknown>;
      if (Object.keys(contract).length !== 1 || !("methods" in contract)) {
        throw new UnitManifestError(
          `Extension ${options.unitName} providerContracts.${provider} must contain exactly one methods field`,
          "MANIFEST_PROVIDER_CONTRACTS"
        );
      }
      const methods = contract["methods"];
      if (
        !Array.isArray(methods) ||
        methods.length === 0 ||
        methods.some((method) => typeof method !== "string" || method.trim().length === 0) ||
        new Set(methods).size !== methods.length
      ) {
        throw new UnitManifestError(
          `Extension ${options.unitName} providerContracts.${provider}.methods must be a non-empty array of unique method names`,
          "MANIFEST_PROVIDER_CONTRACTS"
        );
      }
    }
  }

  if (extension?.methodAuthority === undefined) {
    throw new UnitManifestError(
      `Extension ${options.unitName} must declare methodAuthority for every public method`,
      "MANIFEST_METHOD_AUTHORITY"
    );
  }
  parseExtensionMethodAuthority(
    extension.methodAuthority,
    `Extension ${options.unitName} methodAuthority`
  );

  const contributes = extension?.contributes;
  if (contributes !== undefined) {
    if (!contributes || typeof contributes !== "object" || Array.isArray(contributes)) {
      throw new UnitManifestError(
        `Extension ${options.unitName} contributes must be an object`,
        "MANIFEST_CONTRIBUTES"
      );
    }
    const buildTargets = (contributes as Record<string, unknown>)["buildTargets"];
    if (
      buildTargets !== undefined &&
      (!Array.isArray(buildTargets) || buildTargets.some((target) => target !== "react-native"))
    ) {
      throw new UnitManifestError(
        `Extension ${options.unitName} contributes.buildTargets may only include "react-native"`,
        "MANIFEST_BUILD_TARGETS"
      );
    }
  }
}

function validateAppBlock(
  record: Record<string, unknown>,
  options: UnitManifestValidationOptions
): void {
  const app = record["app"];
  if (!app || typeof app !== "object" || Array.isArray(app)) {
    throw new UnitManifestError(
      `App ${options.unitName} vibestudio.app must be an object`,
      "MANIFEST_APP_BLOCK"
    );
  }
  const appRecord = app as Record<string, unknown>;

  const target = appRecord["target"];
  if (target !== "electron" && target !== "react-native" && target !== "terminal") {
    throw new UnitManifestError(
      `App ${options.unitName} target must be "electron", "react-native", or "terminal"`,
      "MANIFEST_APP_TARGET"
    );
  }

  assertOptionalString(
    appRecord["displayName"],
    `App ${options.unitName} displayName must be a non-empty string when provided`,
    "MANIFEST_APP_DISPLAY_NAME"
  );
  const entryField = target === "terminal" ? "entry" : "renderer";
  if (typeof appRecord[entryField] !== "string" || appRecord[entryField].trim().length === 0) {
    throw new UnitManifestError(
      `App ${options.unitName} ${entryField} must be a non-empty string`,
      "MANIFEST_APP_RENDERER"
    );
  }
  if (target === "terminal" && appRecord["renderer"] !== undefined) {
    throw new UnitManifestError(
      `Terminal app ${options.unitName} must use vibestudio.app.entry instead of renderer`,
      "MANIFEST_APP_TERMINAL_RENDERER"
    );
  }
  if (target !== "terminal" && appRecord["entry"] !== undefined) {
    throw new UnitManifestError(
      `App ${options.unitName} vibestudio.app.entry is only supported for terminal apps`,
      "MANIFEST_APP_TERMINAL_ENTRY"
    );
  }

  const startupModules = appRecord["startupModules"];
  if (
    startupModules !== undefined &&
    (!Array.isArray(startupModules) ||
      startupModules.length === 0 ||
      startupModules.some(
        (specifier) =>
          typeof specifier !== "string" ||
          !specifier.startsWith("./") ||
          specifier.includes("\\") ||
          specifier.split("/").includes("..")
      ))
  ) {
    throw new UnitManifestError(
      `App ${options.unitName} vibestudio.app.startupModules must be a non-empty array of package-root-relative module specifiers`,
      "MANIFEST_APP_STARTUP_MODULES"
    );
  }
  if (target === "terminal" && startupModules !== undefined) {
    throw new UnitManifestError(
      `Terminal app ${options.unitName} cannot declare vibestudio.app.startupModules`,
      "MANIFEST_APP_STARTUP_MODULES_TARGET"
    );
  }

  // Interactive (TUI) terminal apps get the real TTY (stdio inherit) at launch.
  if (appRecord["interactive"] !== undefined) {
    if (typeof appRecord["interactive"] !== "boolean") {
      throw new UnitManifestError(
        `App ${options.unitName} vibestudio.app.interactive must be a boolean`,
        "MANIFEST_APP_INTERACTIVE"
      );
    }
    if (target !== "terminal" && appRecord["interactive"] === true) {
      throw new UnitManifestError(
        `App ${options.unitName} vibestudio.app.interactive is only supported for terminal apps`,
        "MANIFEST_APP_INTERACTIVE_TARGET"
      );
    }
  }

  for (const forbidden of ["main", "preload", "window"]) {
    if (appRecord[forbidden] !== undefined) {
      throw new UnitManifestError(
        `App ${options.unitName} is pure-thin and must not declare vibestudio.app.${forbidden}`,
        "MANIFEST_APP_NATIVE_FIELD"
      );
    }
  }

  const capabilities = appRecord["capabilities"];
  if (capabilities !== undefined) {
    const allowed = new Set<string>(APP_CAPABILITIES_BY_TARGET[target]);
    if (
      !Array.isArray(capabilities) ||
      capabilities.some((capability) => typeof capability !== "string" || !allowed.has(capability))
    ) {
      throw new UnitManifestError(
        `App ${options.unitName} capabilities must be known ${target} capabilities`,
        "MANIFEST_APP_CAPABILITIES"
      );
    }
  }

  if (target === "react-native") {
    assertOptionalString(
      appRecord["rnComponentName"],
      `React Native app ${options.unitName} rnComponentName must be a non-empty string`,
      "MANIFEST_APP_RN_COMPONENT"
    );
    assertOptionalString(
      appRecord["rnHostAbi"],
      `React Native app ${options.unitName} rnHostAbi must be a non-empty string`,
      "MANIFEST_APP_RN_ABI"
    );
    assertOptionalString(
      appRecord["nativeModulePolicy"],
      `React Native app ${options.unitName} nativeModulePolicy must be a non-empty string`,
      "MANIFEST_APP_RN_NATIVE_POLICY"
    );
    if (
      typeof appRecord["rnComponentName"] !== "string" ||
      typeof appRecord["rnHostAbi"] !== "string"
    ) {
      throw new UnitManifestError(
        `React Native app ${options.unitName} requires rnComponentName and rnHostAbi`,
        "MANIFEST_APP_RN_REQUIRED"
      );
    }
  } else if (
    appRecord["rnComponentName"] !== undefined ||
    appRecord["rnHostAbi"] !== undefined ||
    appRecord["nativeModulePolicy"] !== undefined
  ) {
    throw new UnitManifestError(
      `${target === "terminal" ? "Terminal" : "Electron"} app ${options.unitName} must not declare React Native-only fields`,
      "MANIFEST_APP_RN_FIELD"
    );
  }
}

/**
 * Validate a parsed `vibestudio` block from a package.json.
 */
export function validateUnitManifest(
  descriptor: UnitManifestDescriptor,
  manifest: unknown,
  options: UnitManifestValidationOptions
): void {
  const record = assertRecord(manifest, descriptor.label, options);
  validateUnitIconDeclaration(record["icon"]);
  assertNoForeignLocationConfig(record, descriptor, options);
  validateInlineSourcemap(record, descriptor, options);

  if (descriptor.kind === "extension") {
    validateExtensionBlock(record, options);
  } else {
    validateAppBlock(record, options);
  }
}

/**
 * Read and validate the `vibestudio` block from a package.json on disk.
 */
export function readAndValidateUnitManifest(
  descriptor: UnitManifestDescriptor,
  packageJsonPath: string,
  options: UnitManifestValidationOptions,
  readFileSync: (p: string, encoding: "utf-8") => string
): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(packageJsonPath, "utf-8");
  } catch (err) {
    throw new UnitManifestError(
      `${descriptor.label} ${options.unitName} package.json not readable at ${packageJsonPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      "MANIFEST_READ"
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new UnitManifestError(
      `${descriptor.label} ${options.unitName} package.json is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
      "MANIFEST_PARSE"
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UnitManifestError(
      `${descriptor.label} ${options.unitName} package.json must be a JSON object`,
      "MANIFEST_PARSE"
    );
  }

  const vibestudio = (parsed as { vibestudio?: unknown }).vibestudio;
  validateUnitManifest(descriptor, vibestudio ?? {}, options);
  return (vibestudio as Record<string, unknown>) ?? {};
}
