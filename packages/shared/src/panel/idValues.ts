type Brand<T, Name extends string> = T & { readonly __brand: Name };

/** Stable workspace/tree handle for a panel slot. This is what shell UI uses. */
export type PanelSlotId = Brand<string, "PanelSlotId">;

/** Runtime identity for a concrete panel entity/history entry. This is what RPC auth uses. */
export type PanelEntityId = Brand<string, "PanelEntityId">;

const PANEL_SLOT_PREFIX = "panel:tree/";
const PANEL_ENTITY_PREFIX = "panel:nav-";

export function asPanelSlotId(value: string): PanelSlotId {
  if (!value.startsWith(PANEL_SLOT_PREFIX)) {
    throw new Error(
      `Not a panel slot id (expected "${PANEL_SLOT_PREFIX}…", got ${JSON.stringify(value)}). ` +
        `Slot ids name a tree position; a nav/entity id ("${PANEL_ENTITY_PREFIX}…") or other id must ` +
        `be mapped to its slot first (resolveOwningPanelSlot / workspace-state slot.resolveByEntity).`
    );
  }
  return value as PanelSlotId;
}

export function asPanelEntityId(value: string): PanelEntityId {
  if (!value.startsWith(PANEL_ENTITY_PREFIX)) {
    throw new Error(
      `Not a panel entity id (expected "${PANEL_ENTITY_PREFIX}…", got ${JSON.stringify(value)}). ` +
        `Entity/nav ids name a live runtime instance; a slot id ("${PANEL_SLOT_PREFIX}…") must not be ` +
        `passed here.`
    );
  }
  return value as PanelEntityId;
}

export function isPanelSlotId(value: string): value is PanelSlotId {
  return value.startsWith(PANEL_SLOT_PREFIX);
}

export function isPanelEntityId(value: string): value is PanelEntityId {
  return value.startsWith(PANEL_ENTITY_PREFIX);
}

export const PANEL_ID_PREFIXES = {
  slot: PANEL_SLOT_PREFIX,
  entity: PANEL_ENTITY_PREFIX,
} as const;
