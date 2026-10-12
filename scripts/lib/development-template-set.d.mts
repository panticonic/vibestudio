import type { DevelopmentTemplateSet } from "../../src/dev/developmentTemplateSet.js";
import type { WorkspaceTemplatePin } from "@vibestudio/workspace-contracts/types";

export function developmentTemplateSetSources(selection: DevelopmentTemplateSet): Array<{
  pin: WorkspaceTemplatePin;
  checkout: string;
}>;

export function developmentTemplateSetEnv(selection: DevelopmentTemplateSet): NodeJS.ProcessEnv;
