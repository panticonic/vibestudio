import { z } from "zod";
import {
  isPanelEntityId,
  isPanelSlotId,
  PANEL_ID_PREFIXES,
  asPanelSlotId,
  asPanelEntityId,
} from "./idValues.js";
export * from "./idValues.js";

/** Wire boundary for the stable panel-tree identifier space. */
export const PanelSlotIdSchema = z
  .string()
  .refine(isPanelSlotId, {
    message: `Expected a panel slot id beginning with "${PANEL_ID_PREFIXES.slot}"`,
  })
  .transform(asPanelSlotId);

/** Wire boundary for the live panel runtime identifier space. */
export const PanelEntityIdSchema = z
  .string()
  .refine(isPanelEntityId, {
    message: `Expected a panel entity id beginning with "${PANEL_ID_PREFIXES.entity}"`,
  })
  .transform(asPanelEntityId);
