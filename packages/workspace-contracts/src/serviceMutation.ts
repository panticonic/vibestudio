import type {
  WorkspaceServiceBinding,
  WorkspaceServiceDecl,
  WorkspaceSingletonObjectDecl,
} from "./types.js";

export interface ServiceRegistration {
  name: string;
  source: string;
  title: string;
  action: string;
  description: string;
  notability: "headline" | "everyday";
  presentation: WorkspaceServiceDecl["presentation"];
  protocols: string[];
  principals: Array<"host" | "user" | "code" | "session" | "mission">;
  binding: WorkspaceServiceBinding;
  transport:
    | { kind: "durable-object"; className: string; objectKey?: string }
    | { kind: "worker"; routePath: string };
}
export type ServiceMutation =
  | (ServiceRegistration & { operation: "create" | "upsert" })
  | { operation: "remove"; name: string; removeSingleton?: boolean };

/** One policy owner for service/singleton edits. Serialization and exact-state
 * publication belong to the caller; the complete resulting config must be validated. */
export function planServiceMutation(
  config: { services?: WorkspaceServiceDecl[]; singletonObjects?: WorkspaceSingletonObjectDecl[] },
  command: ServiceMutation
): {
  services: WorkspaceServiceDecl[];
  singletonObjects: WorkspaceSingletonObjectDecl[];
  diagnostic?: "not-found" | "singleton-still-used";
} {
  if (
    (config.services !== undefined && !Array.isArray(config.services)) ||
    (config.singletonObjects !== undefined && !Array.isArray(config.singletonObjects))
  ) {
    throw new Error("services and singletonObjects must be arrays");
  }
  const services = [...(config.services ?? [])];
  const singletonObjects = [...(config.singletonObjects ?? [])];
  if (
    services.some(
      (service) =>
        !service || typeof service.name !== "string" || typeof service.source !== "string"
    ) ||
    singletonObjects.some(
      (object) =>
        !object ||
        typeof object.source !== "string" ||
        typeof object.className !== "string" ||
        typeof object.key !== "string"
    )
  ) {
    throw new Error("Cannot edit malformed service or singleton declarations");
  }
  const index = services.findIndex((service) => service.name === command.name);
  if (command.operation === "remove") {
    if (index < 0) return { services, singletonObjects, diagnostic: "not-found" };
    const removed = services[index]!;
    if (command.removeSingleton && removed.durableObject) {
      const className = removed.durableObject.className;
      if (
        services.some(
          (service, i) =>
            i !== index &&
            service.source === removed.source &&
            service.durableObject?.className === className
        )
      ) {
        return { services, singletonObjects, diagnostic: "singleton-still-used" };
      }
      const singletonIndex = singletonObjects.findIndex(
        (object) => object.source === removed.source && object.className === className
      );
      if (singletonIndex >= 0) singletonObjects.splice(singletonIndex, 1);
    }
    services.splice(index, 1);
  } else {
    const transport = command.transport;
    if (
      command.operation === "create" &&
      (index >= 0 ||
        services.some((service) =>
          service.protocols?.some((protocol) => command.protocols.includes(protocol))
        ) ||
        (transport.kind === "durable-object" &&
          singletonObjects.some(
            (object) => object.source === command.source && object.className === transport.className
          )))
    ) {
      throw new Error(
        `Cannot create ${command.name}: service name, protocol, or singleton already declared`
      );
    }
    const declaration: WorkspaceServiceDecl = {
      source: command.source,
      name: command.name,
      title: command.title,
      action: command.action,
      description: command.description,
      notability: command.notability,
      presentation: command.presentation,
      protocols: [...command.protocols],
      authority: { principals: [...command.principals], binding: command.binding },
      ...(transport.kind === "durable-object"
        ? { durableObject: { className: transport.className } }
        : { worker: { routePath: transport.routePath } }),
    };
    if (index < 0) services.push(declaration);
    else services[index] = declaration;
    if (transport.kind === "durable-object" && transport.objectKey) {
      const singleton = {
        source: command.source,
        className: transport.className,
        key: transport.objectKey,
      };
      const singletonIndex = singletonObjects.findIndex(
        (object) => object.source === singleton.source && object.className === singleton.className
      );
      if (singletonIndex < 0) singletonObjects.push(singleton);
      else singletonObjects[singletonIndex] = singleton;
    }
  }
  return { services, singletonObjects };
}
