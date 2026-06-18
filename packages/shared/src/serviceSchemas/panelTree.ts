/**
 * panelTree service method schemas.
 *
 * The panelTree service is the single server-owned authority for panel slot
 * creation, navigation, lifecycle commands, and tree metadata.
 */

import { z } from "zod";
import type { PanelRuntimeLease } from "../panel/panelLease.js";
import type {
  MovePanelRequest,
  Panel,
  PanelFocusResult,
  PanelLifecycleResult,
  PanelNavigationState,
  PanelTreeSnapshot,
} from "../types.js";
import { defineServiceMethods } from "../typedServiceClient.js";

const PanelIdSchema = z.string();
const StateArgsSchema = z.record(z.unknown());
const CreateResultSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.enum(["browser", "workspace"]).optional(),
  contextId: z.string().optional(),
  source: z.string().optional(),
  runtimeEntityId: z.string().optional(),
  effectiveVersion: z.string().nullable().optional(),
});

export const PanelTreeCreateOptionsSchema = z
  .object({
    parentId: z.string().nullable().optional(),
    name: z.string().optional(),
    focus: z.boolean().optional(),
    ref: z.string().optional(),
    stateArgs: StateArgsSchema.optional(),
  })
  .optional();

export const PanelTreeNavigateOptionsSchema = z
  .object({
    ref: z.string().optional(),
    contextId: z.string().optional(),
    env: z.record(z.string()).optional(),
    stateArgs: StateArgsSchema.optional(),
  })
  .optional();

export const panelTreeMethods = defineServiceMethods({
  list: { args: z.tuple([z.string().nullable().optional()]), returns: z.array(z.unknown()) },
  roots: { args: z.tuple([]), returns: z.array(z.unknown()) },
  getTreeSnapshot: { args: z.tuple([]), returns: z.custom<PanelTreeSnapshot>() },
  getFocusedPanelId: { args: z.tuple([]), returns: z.string().nullable() },
  create: { args: z.tuple([z.string(), PanelTreeCreateOptionsSchema]), returns: CreateResultSchema },
  ensureLoaded: { args: z.tuple([PanelIdSchema]), returns: z.custom<PanelFocusResult>() },
  focus: { args: z.tuple([PanelIdSchema]), returns: z.custom<PanelFocusResult>() },
  getRuntimeLease: {
    args: z.tuple([PanelIdSchema]),
    returns: z.custom<PanelRuntimeLease>().nullable(),
  },
  getStateArgs: { args: z.tuple([PanelIdSchema]), returns: StateArgsSchema },
  setStateArgs: { args: z.tuple([PanelIdSchema, StateArgsSchema]), returns: StateArgsSchema },
  reload: { args: z.tuple([PanelIdSchema]), returns: z.custom<PanelLifecycleResult>() },
  close: { args: z.tuple([PanelIdSchema]), returns: z.custom<PanelLifecycleResult>() },
  archive: { args: z.tuple([PanelIdSchema]), returns: z.custom<PanelLifecycleResult>() },
  unload: { args: z.tuple([PanelIdSchema]), returns: z.custom<PanelLifecycleResult>() },
  movePanel: { args: z.tuple([z.custom<MovePanelRequest>()]), returns: z.void() },
  navigate: {
    args: z.tuple([PanelIdSchema, z.string(), PanelTreeNavigateOptionsSchema]),
    returns: CreateResultSchema.nullable(),
  },
  navigateHistory: {
    args: z.tuple([PanelIdSchema, z.union([z.literal(-1), z.literal(1)])]),
    returns: CreateResultSchema.nullable(),
  },
  takeOver: { args: z.tuple([PanelIdSchema]), returns: z.custom<PanelFocusResult>() },
  openDevTools: {
    args: z.tuple([PanelIdSchema, z.enum(["detach", "right", "bottom"]).optional()]),
    returns: z.unknown(),
  },
  rebuildPanel: { args: z.tuple([PanelIdSchema]), returns: z.custom<PanelLifecycleResult>() },
  rebuildAndReload: { args: z.tuple([PanelIdSchema]), returns: z.custom<PanelLifecycleResult>() },
  updatePanelState: {
    args: z.tuple([PanelIdSchema, z.custom<PanelNavigationState>()]),
    returns: z.void(),
  },
  snapshot: { args: z.tuple([PanelIdSchema]), returns: z.unknown() },
  callAgent: {
    args: z.tuple([PanelIdSchema, z.string(), z.array(z.unknown()).optional()]),
    returns: z.unknown(),
  },
  metadata: { args: z.tuple([PanelIdSchema]), returns: z.custom<Panel>().nullable() },
  getCollapsedIds: { args: z.tuple([]), returns: z.array(z.string()) },
  setCollapsed: { args: z.tuple([PanelIdSchema, z.boolean()]), returns: z.void() },
  expandIds: { args: z.tuple([z.array(PanelIdSchema)]), returns: z.void() },
});
