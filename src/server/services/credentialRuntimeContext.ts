import type { EntityRecord } from "@vibestudio/shared/runtime/entitySpec";

export interface CredentialRuntimePanelInfo {
  panelId: string;
  title?: string;
  source?: string;
  kind?: "workspace" | "browser";
  parentId?: string | null;
  contextId?: string;
  runtimeEntityId?: string | null;
  executionDigest?: string | null;
}

export interface CredentialRuntimeInspector {
  listActiveEntities(): EntityRecord[] | Promise<EntityRecord[]>;
  resolvePanelSlotByEntity?(entityId: string): string | null | Promise<string | null>;
  listPanels?(): CredentialRuntimePanelInfo[] | Promise<CredentialRuntimePanelInfo[]>;
}

export interface CredentialRuntimeIndex {
  activeEntities: EntityRecord[];
  entitiesById: Map<string, EntityRecord>;
  panelsByRuntimeEntityId: Map<string, CredentialRuntimePanelInfo>;
  panelsByPanelId: Map<string, CredentialRuntimePanelInfo>;
  slotByEntityId: Map<string, string | null>;
}

export async function buildCredentialRuntimeIndex(
  runtimeInspector: CredentialRuntimeInspector | undefined
): Promise<CredentialRuntimeIndex> {
  const [activeEntities, panels] = await Promise.all([
    safeListActiveCredentialEntities(runtimeInspector),
    safeListCredentialPanels(runtimeInspector),
  ]);
  const panelsByRuntimeEntityId = new Map<string, CredentialRuntimePanelInfo>();
  const panelsByPanelId = new Map<string, CredentialRuntimePanelInfo>();
  for (const panel of panels) {
    panelsByPanelId.set(panel.panelId, panel);
    if (panel.runtimeEntityId) {
      panelsByRuntimeEntityId.set(panel.runtimeEntityId, panel);
    }
  }
  return {
    activeEntities,
    entitiesById: new Map(activeEntities.map((entity) => [entity.id, entity])),
    panelsByRuntimeEntityId,
    panelsByPanelId,
    slotByEntityId: new Map(),
  };
}

export function findNearestCredentialPanelEntity(
  entity: EntityRecord,
  runtimeIndex: CredentialRuntimeIndex
): EntityRecord | null {
  if (entity.kind === "panel") return entity;
  let current: EntityRecord | null = entity;
  const seen = new Set<string>();
  while (current?.parentId) {
    const parentId: string = current.parentId;
    if (seen.has(parentId)) break;
    seen.add(parentId);
    const parent: EntityRecord | null = runtimeIndex.entitiesById.get(parentId) ?? null;
    if (!parent) return null;
    if (parent.kind === "panel") return parent;
    current = parent;
  }
  return null;
}

export async function resolvePanelSlotForCredentialEntity(
  entityId: string,
  runtimeIndex: CredentialRuntimeIndex,
  runtimeInspector: CredentialRuntimeInspector | undefined
): Promise<string | null> {
  if (runtimeIndex.slotByEntityId.has(entityId)) {
    return runtimeIndex.slotByEntityId.get(entityId) ?? null;
  }
  let slotId = runtimeIndex.panelsByRuntimeEntityId.get(entityId)?.panelId ?? null;
  if (!slotId && runtimeInspector?.resolvePanelSlotByEntity) {
    try {
      slotId = await runtimeInspector.resolvePanelSlotByEntity(entityId);
    } catch {
      slotId = null;
    }
  }
  runtimeIndex.slotByEntityId.set(entityId, slotId);
  return slotId;
}

async function safeListActiveCredentialEntities(
  runtimeInspector: CredentialRuntimeInspector | undefined
): Promise<EntityRecord[]> {
  if (!runtimeInspector) return [];
  try {
    return await runtimeInspector.listActiveEntities();
  } catch {
    return [];
  }
}

async function safeListCredentialPanels(
  runtimeInspector: CredentialRuntimeInspector | undefined
): Promise<CredentialRuntimePanelInfo[]> {
  if (!runtimeInspector?.listPanels) return [];
  try {
    return await runtimeInspector.listPanels();
  } catch {
    return [];
  }
}
