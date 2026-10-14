import type { DevelopmentTemplateSet } from "../../src/dev/developmentTemplateSet.js";
import type { WorkspaceSource } from "@vibestudio/workspace/workspaceSources";

export function developmentTemplateSetSources(selection: DevelopmentTemplateSet): WorkspaceSource[];

export function developmentTemplateSetEnv(selection: DevelopmentTemplateSet): NodeJS.ProcessEnv;
