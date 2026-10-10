export interface ChannelTargetLookup {
  listServices(): Promise<ChannelServiceProvider[]>;
  listDurableObjectEntities(): Promise<ChannelDurableObjectEntity[]>;
}

export interface ChannelServiceProvider {
  source: string;
  kind: string;
  className?: string | null;
  protocols?: string[];
}

export interface ChannelDurableObjectEntity {
  id: string;
  source: string;
  key: string;
  kind: "do";
  contextId: string;
  createdAt: number;
}

export const CHANNEL_PROTOCOL = "vibestudio.channel.v1";

export async function listChannelDurableObjectEntities(
  lookup: ChannelTargetLookup
): Promise<ChannelDurableObjectEntity[]> {
  const services = await lookup.listServices();
  const provider = services.find(
    (service) =>
      service.kind === "durable-object" &&
      typeof service.className === "string" &&
      service.protocols?.includes(CHANNEL_PROTOCOL)
  );
  if (!provider || typeof provider.className !== "string") {
    throw new Error(`service ${CHANNEL_PROTOCOL} is not a durable-object service`);
  }

  const entities = await lookup.listDurableObjectEntities();
  return entities.filter(
    (entity) =>
      entity.kind === "do" &&
      entity.source === provider.source &&
      entity.id === `do:${provider.source}:${provider.className}:${entity.key}`
  );
}

export async function resolveExistingChannelTarget(
  lookup: ChannelTargetLookup,
  channelId: string
): Promise<string> {
  const entity = (await listChannelDurableObjectEntities(lookup)).find(
    (candidate) => candidate.key === channelId
  );
  if (!entity) throw new Error(`channel ${channelId} does not exist in this workspace`);
  return entity.id;
}
