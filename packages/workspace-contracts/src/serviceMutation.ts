import type {
  WorkspaceServiceExport,
  WorkspaceServiceSelection,
  WorkspaceSingletonObjectDecl,
} from "./types.js";

export type ServiceRegistration = {
  source: string;
  service: WorkspaceServiceExport;
  singletonKey?: string;
};

export type ServiceMutation =
  | (ServiceRegistration & { operation: "create" | "upsert" })
  | { operation: "remove"; source: string; name: string; removeSingleton?: boolean };

export interface ServiceMutationState {
  services: WorkspaceServiceSelection[];
  singletonObjects: WorkspaceSingletonObjectDecl[];
  providerServices: WorkspaceServiceExport[];
}

export interface ServiceMutationPlan extends ServiceMutationState {
  diagnostic?: "not-found" | "singleton-still-used";
}

/**
 * Plan one atomic root-selection, provider-export, and optional singleton edit.
 * The caller owns parsing/serialization and validates the complete candidate
 * workspace before publishing it.
 */
export function planServiceMutation(
  state: ServiceMutationState,
  command: ServiceMutation
): ServiceMutationPlan {
  if (
    !Array.isArray(state.services) ||
    !Array.isArray(state.singletonObjects) ||
    !Array.isArray(state.providerServices)
  ) {
    throw new Error("services, singletonObjects, and providerServices must be arrays");
  }
  const services = [...state.services];
  const singletonObjects = [...state.singletonObjects];
  const providerServices = [...state.providerServices];
  if (
    services.some(
      (entry) => !entry || typeof entry.source !== "string" || typeof entry.name !== "string"
    ) ||
    singletonObjects.some(
      (entry) =>
        !entry ||
        typeof entry.source !== "string" ||
        typeof entry.className !== "string" ||
        typeof entry.key !== "string"
    ) ||
    providerServices.some((entry) => !entry || typeof entry.name !== "string")
  ) {
    throw new Error("Cannot edit malformed service or singleton declarations");
  }

  const targetName = command.operation === "remove" ? command.name : command.service.name;
  const selectedIndex = services.findIndex(
    (entry) =>
      entry.name === targetName &&
      (command.operation !== "remove" || entry.source === command.source)
  );
  if (command.operation === "remove") {
    if (selectedIndex < 0)
      return { services, singletonObjects, providerServices, diagnostic: "not-found" };
    const removed = services[selectedIndex]!;
    const removedExportIndex = providerServices.findIndex((entry) => entry.name === command.name);
    if (removedExportIndex < 0) {
      throw new Error(
        `${command.source}/package.json does not export selected service ${command.name}`
      );
    }
    const removedExport = providerServices[removedExportIndex]!;
    if (command.removeSingleton && removedExport.durableObject) {
      const className = removedExport.durableObject.className;
      if (
        services.some(
          (entry, index) =>
            index !== selectedIndex &&
            entry.source === removed.source &&
            providerServices.some(
              (other) => other.name === entry.name && other.durableObject?.className === className
            )
        )
      )
        return { services, singletonObjects, providerServices, diagnostic: "singleton-still-used" };
      const singletonIndex = singletonObjects.findIndex(
        (entry) => entry.source === removed.source && entry.className === className
      );
      if (singletonIndex >= 0) singletonObjects.splice(singletonIndex, 1);
    }
    services.splice(selectedIndex, 1);
    providerServices.splice(removedExportIndex, 1);
  } else {
    const { source, service, singletonKey } = command;
    if (!source.trim() || !service.name.trim())
      throw new Error("Service source and name must be non-empty");
    const exportIndex = providerServices.findIndex((entry) => entry.name === service.name);
    if (command.operation === "create" && (selectedIndex >= 0 || exportIndex >= 0)) {
      throw new Error(`Cannot create ${service.name}: service name is already declared`);
    }
    if (services.some((entry) => entry.name === service.name && entry.source !== source)) {
      throw new Error(
        `Cannot select ${service.name}: that name is already selected from another provider`
      );
    }
    const binding = service.authority.binding;
    if (
      binding !== undefined &&
      binding !== "consent" &&
      binding !== "declared" &&
      !Array.isArray(binding.declaredFor)
    ) {
      throw new Error("Service authority binding is malformed");
    }
    const selected: WorkspaceServiceSelection = { source, name: service.name };
    if (selectedIndex < 0) services.push(selected);
    else services[selectedIndex] = selected;

    if (exportIndex < 0) providerServices.push(service);
    else providerServices[exportIndex] = service;

    if (singletonKey !== undefined) {
      if (!service.durableObject)
        throw new Error("singletonKey requires a Durable Object service export");
      const singleton = { source, className: service.durableObject.className, key: singletonKey };
      const singletonIndex = singletonObjects.findIndex(
        (entry) => entry.source === source && entry.className === singleton.className
      );
      if (singletonIndex < 0) singletonObjects.push(singleton);
      else singletonObjects[singletonIndex] = singleton;
    }
  }
  return { services, singletonObjects, providerServices };
}
