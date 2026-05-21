type Brand<T, Name extends string> = T & { readonly __brand: Name };

/** Stable workspace/tree handle for a panel slot. This is what shell UI uses. */
export type PanelSlotId = Brand<string, "PanelSlotId">;

/** Runtime identity for a concrete panel entity/history entry. This is what RPC auth uses. */
export type PanelEntityId = Brand<string, "PanelEntityId">;

export function asPanelSlotId(value: string): PanelSlotId {
  return value as PanelSlotId;
}

export function asPanelEntityId(value: string): PanelEntityId {
  return value as PanelEntityId;
}
