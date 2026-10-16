/**
 * Shared validator for declarative trusted workspace-unit manifests.
 *
 * Extensions and clients are both build-gated, approval-gated workspace units.
 * This module keeps their fail-closed package.json validation in one place so
 * build, reconcile/install, and boot checks cannot drift by unit kind.
 */

import { validateWebsiteMethodPolicy, type WebsiteMethodPolicy } from "@vibestudio/rpc";
import {
  CLIENT_RUNTIMES,
  RESERVED_TERMINAL_COMMANDS,
  capabilitiesForRuntime,
  isValidClientId,
  isValidIntentName,
  type ClientRuntime,
} from "@vibestudio/workspace-contracts/clients";
import { isSemanticEmoji, isUnitIconAssetPath } from "./panel/icon.js";

export type UnitKind = "extension" | "client";

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

export const clientUnitManifestDescriptor: UnitManifestDescriptor = {
  kind: "client",
  label: "Client",
};

const LOCATION_CONFIG_BLOCKS = ["extension", "client"] as const;

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

function clientError(message: string, code: string): UnitManifestError {
  return new UnitManifestError(message, code);
}

function validateCapabilityList(
  value: unknown,
  allowed: ReadonlySet<string>,
  field: string,
  options: UnitManifestValidationOptions,
  runtime: ClientRuntime
): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.some((capability) => typeof capability !== "string" || !allowed.has(capability))
  ) {
    throw clientError(
      `Client ${options.unitName} ${field} must list known ${runtime} capabilities`,
      "MANIFEST_CLIENT_CAPABILITIES"
    );
  }
  return value as string[];
}

function validateIntents(value: unknown, options: UnitManifestValidationOptions): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw clientError(
      `Client ${options.unitName} intents must be a list`,
      "MANIFEST_CLIENT_INTENTS"
    );
  }
  const names = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw clientError(
        `Client ${options.unitName} every intent must be an object`,
        "MANIFEST_CLIENT_INTENTS"
      );
    }
    const intent = raw as Record<string, unknown>;
    const name = intent["name"];
    if (!isValidIntentName(name)) {
      throw clientError(
        `Client ${options.unitName} intent names must be lower-case words joined by hyphens`,
        "MANIFEST_CLIENT_INTENT_NAME"
      );
    }
    if (names.has(name)) {
      throw clientError(
        `Client ${options.unitName} declares intent "${name}" twice`,
        "MANIFEST_CLIENT_INTENT_NAME"
      );
    }
    names.add(name);
    for (const key of Object.keys(intent)) {
      if (!INTENT_KEYS.has(key)) {
        throw clientError(
          `Client ${options.unitName} intent "${name}" has unknown field "${key}"`,
          "MANIFEST_CLIENT_INTENT_FIELD"
        );
      }
    }
    const kind = intent["kind"];
    if (kind !== "foreground" && kind !== "background") {
      throw clientError(
        `Client ${options.unitName} intent "${name}" kind must be "foreground" or "background"`,
        "MANIFEST_CLIENT_INTENT_KIND"
      );
    }
    if (name === "open" && kind !== "foreground") {
      throw clientError(
        `Client ${options.unitName} intent "open" must be a foreground intent`,
        "MANIFEST_CLIENT_INTENT_KIND"
      );
    }
    assertOptionalString(
      intent["title"],
      `Client ${options.unitName} intent "${name}" title must be a non-empty string`,
      "MANIFEST_CLIENT_INTENT_TITLE"
    );
    const params = intent["params"];
    if (params !== undefined) {
      if (!params || typeof params !== "object" || Array.isArray(params)) {
        throw clientError(
          `Client ${options.unitName} intent "${name}" params must be a mapping`,
          "MANIFEST_CLIENT_INTENT_PARAMS"
        );
      }
      for (const [param, type] of Object.entries(params)) {
        if (!/^[a-z][a-zA-Z0-9]*$/u.test(param) || (type !== "string" && type !== "text")) {
          throw clientError(
            `Client ${options.unitName} intent "${name}" param "${param}" must be "string" or "text"`,
            "MANIFEST_CLIENT_INTENT_PARAMS"
          );
        }
      }
    }
    for (const field of ["dynamic", "handler"] as const) {
      const method = intent[field];
      if (
        method !== undefined &&
        (typeof method !== "string" || !/^[^#\s]+#[^#\s]+$/u.test(method))
      ) {
        throw clientError(
          `Client ${options.unitName} intent "${name}" ${field} must name a service method as "<protocol>#<method>"`,
          "MANIFEST_CLIENT_INTENT_METHOD"
        );
      }
    }
    if (kind === "background") {
      if (typeof intent["handler"] !== "string") {
        throw clientError(
          `Client ${options.unitName} background intent "${name}" requires a handler`,
          "MANIFEST_CLIENT_INTENT_HANDLER"
        );
      }
      if (intent["accepts"] !== undefined) {
        throw clientError(
          `Client ${options.unitName} background intent "${name}" cannot accept shared content`,
          "MANIFEST_CLIENT_INTENT_ACCEPTS"
        );
      }
    } else {
      if (intent["handler"] !== undefined) {
        throw clientError(
          `Client ${options.unitName} foreground intent "${name}" cannot declare a handler`,
          "MANIFEST_CLIENT_INTENT_HANDLER"
        );
      }
      const accepts = intent["accepts"];
      if (
        accepts !== undefined &&
        (!Array.isArray(accepts) ||
          accepts.length === 0 ||
          accepts.some(
            (type) => typeof type !== "string" || !/^[a-z]+\/(\*|[a-z0-9.+-]+)$/u.test(type)
          ))
      ) {
        throw clientError(
          `Client ${options.unitName} intent "${name}" accepts must list MIME types such as "text/*"`,
          "MANIFEST_CLIENT_INTENT_ACCEPTS"
        );
      }
    }
  }
}

function validateIntegration(
  value: unknown,
  runtime: ClientRuntime,
  options: UnitManifestValidationOptions
): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw clientError(
      `Client ${options.unitName} integration must be a mapping`,
      "MANIFEST_CLIENT_INTEGRATION"
    );
  }
  const integration = value as Record<string, unknown>;
  for (const key of Object.keys(integration)) {
    if (key !== "desktop" && key !== "terminal") {
      throw clientError(
        `Client ${options.unitName} integration has unknown host "${key}"`,
        "MANIFEST_CLIENT_INTEGRATION"
      );
    }
  }
  const desktop = integration["desktop"];
  if (desktop !== undefined) {
    if (runtime !== "web" || !desktop || typeof desktop !== "object" || Array.isArray(desktop)) {
      throw clientError(
        `Client ${options.unitName} integration.desktop applies only to web clients and must be a mapping`,
        "MANIFEST_CLIENT_INTEGRATION"
      );
    }
    for (const [key, size] of Object.entries(desktop)) {
      if (
        !["width", "height", "minWidth", "minHeight"].includes(key) ||
        typeof size !== "number" ||
        !Number.isInteger(size) ||
        size < 200 ||
        size > 8192
      ) {
        throw clientError(
          `Client ${options.unitName} integration.desktop.${key} must be a window size in pixels`,
          "MANIFEST_CLIENT_INTEGRATION"
        );
      }
    }
  }
  const terminal = integration["terminal"];
  if (terminal !== undefined) {
    if (
      runtime !== "terminal" ||
      !terminal ||
      typeof terminal !== "object" ||
      Array.isArray(terminal)
    ) {
      throw clientError(
        `Client ${options.unitName} integration.terminal applies only to terminal clients and must be a mapping`,
        "MANIFEST_CLIENT_INTEGRATION"
      );
    }
    const command = (terminal as Record<string, unknown>)["command"];
    if (command !== undefined) {
      if (typeof command !== "string" || !/^[a-z][a-z0-9-]{0,31}$/u.test(command)) {
        throw clientError(
          `Client ${options.unitName} integration.terminal.command must be a lower-case command name`,
          "MANIFEST_CLIENT_TERMINAL_COMMAND"
        );
      }
      if (RESERVED_TERMINAL_COMMANDS.includes(command)) {
        throw clientError(
          `Client ${options.unitName} integration.terminal.command "${command}" is a built-in vibestudio command`,
          "MANIFEST_CLIENT_TERMINAL_COMMAND"
        );
      }
    }
  }
}

const INTENT_KEYS = new Set(["name", "kind", "title", "params", "dynamic", "handler", "accepts"]);

function validateClientBlock(
  record: Record<string, unknown>,
  options: UnitManifestValidationOptions
): void {
  const client = record["client"];
  if (!client || typeof client !== "object" || Array.isArray(client)) {
    throw clientError(
      `Client ${options.unitName} vibestudio.client must be an object`,
      "MANIFEST_CLIENT_BLOCK"
    );
  }
  const block = client as Record<string, unknown>;
  const known = new Set([
    "id",
    "runtime",
    "hostAbi",
    "entry",
    "title",
    "capabilities",
    "intents",
    "integration",
  ]);
  for (const key of Object.keys(block)) {
    if (!known.has(key)) {
      throw clientError(
        `Client ${options.unitName} vibestudio.client has unknown field "${key}"`,
        "MANIFEST_CLIENT_FIELD"
      );
    }
  }
  if (!isValidClientId(block["id"])) {
    throw clientError(
      `Client ${options.unitName} id must be a lower-case word or hyphenated words`,
      "MANIFEST_CLIENT_ID"
    );
  }
  const runtime = block["runtime"];
  if (!(CLIENT_RUNTIMES as readonly unknown[]).includes(runtime)) {
    throw clientError(
      `Client ${options.unitName} runtime must be one of ${CLIENT_RUNTIMES.join(", ")}`,
      "MANIFEST_CLIENT_RUNTIME"
    );
  }
  const clientRuntime = runtime as ClientRuntime;
  const abiPrefix = { web: "web-host-", "react-native": "rn-host-", terminal: "terminal-host-" }[
    clientRuntime
  ];
  const hostAbi = block["hostAbi"];
  if (typeof hostAbi !== "string" || !new RegExp(`^${abiPrefix}[1-9][0-9]*$`, "u").test(hostAbi)) {
    throw clientError(
      `Client ${options.unitName} hostAbi must be "${abiPrefix}<version>" for a ${clientRuntime} client`,
      "MANIFEST_CLIENT_HOST_ABI"
    );
  }
  const entry = block["entry"];
  if (
    typeof entry !== "string" ||
    entry.trim().length === 0 ||
    entry.startsWith("/") ||
    entry.includes("\\") ||
    entry.split("/").includes("..")
  ) {
    throw clientError(
      `Client ${options.unitName} entry must be a package-relative module path`,
      "MANIFEST_CLIENT_ENTRY"
    );
  }
  assertOptionalString(
    block["title"],
    `Client ${options.unitName} title must be a non-empty string when provided`,
    "MANIFEST_CLIENT_TITLE"
  );
  const capabilities = block["capabilities"];
  if (capabilities !== undefined) {
    if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
      throw clientError(
        `Client ${options.unitName} capabilities must be a mapping with required and optional lists`,
        "MANIFEST_CLIENT_CAPABILITIES"
      );
    }
    for (const key of Object.keys(capabilities)) {
      if (key !== "required" && key !== "optional") {
        throw clientError(
          `Client ${options.unitName} capabilities has unknown list "${key}"`,
          "MANIFEST_CLIENT_CAPABILITIES"
        );
      }
    }
    const allowed = new Set<string>(capabilitiesForRuntime(clientRuntime));
    const capabilityRecord = capabilities as Record<string, unknown>;
    const required = validateCapabilityList(
      capabilityRecord["required"],
      allowed,
      "capabilities.required",
      options,
      clientRuntime
    );
    const optional = validateCapabilityList(
      capabilityRecord["optional"],
      allowed,
      "capabilities.optional",
      options,
      clientRuntime
    );
    const overlap = required.filter((capability) => optional.includes(capability));
    if (overlap.length > 0) {
      throw clientError(
        `Client ${options.unitName} lists ${overlap.join(", ")} as both required and optional`,
        "MANIFEST_CLIENT_CAPABILITIES"
      );
    }
  }
  validateIntents(block["intents"], options);
  validateIntegration(block["integration"], clientRuntime, options);
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
    validateClientBlock(record, options);
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
