export function declaredMethodCapabilityDependencies(
  matrix: Record<string, unknown>
): Map<string, Set<string>>;

export function expandCapabilityDependencies(
  capabilities: Set<string>,
  dependencies: ReadonlyMap<string, ReadonlySet<string>>
): Set<string>;

export function inferWorkspacePackageReferences(
  source: string,
  workspacePackageNames: Iterable<string>
): Set<string>;

export function inferUnitTransportCapabilities(
  source: string,
  options: {
    hostCapabilities: ReadonlySet<string>;
    serviceMethods: ReadonlyMap<string, readonly string[]>;
  }
): Set<string>;

export function inferDirectRpcCapabilities(
  source: string,
  directCapabilities: ReadonlySet<string>
): Set<string>;

export function inferEventsClientCapabilities(
  source: string,
  serviceMethods: ReadonlyMap<string, readonly string[]>
): Set<string>;
export function inferTypedServiceClientCapabilities(
  source: string,
  hostCapabilities: ReadonlySet<string>
): Set<string>;
export function inferHostedRuntimeCapabilities(
  source: string,
  hostCapabilities: ReadonlySet<string>
): Set<string>;
export function inferExtensionContextCapabilities(
  source: string,
  hostCapabilities: ReadonlySet<string>
): Set<string>;
