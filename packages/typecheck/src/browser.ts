import {
  FS_TYPE_DEFINITIONS,
  GLOBAL_TYPE_DEFINITIONS,
  PATH_TYPE_DEFINITIONS,
} from "./lib/index.js";
import { TS_LIB_FILES } from "./lib/typescript-libs.js";

export const MONACO_FS_TYPE_DEFINITIONS_PATH = "file:///node_modules/fs/index.d.ts";
export const MONACO_PATH_TYPE_DEFINITIONS_PATH = "file:///node_modules/path/index.d.ts";
export const MONACO_GLOBAL_TYPE_DEFINITIONS_PATH = "file:///vibez1/globals.d.ts";
export const MONACO_TYPESCRIPT_LIB_ROOT = "file:///node_modules/typescript/lib";

export interface BrowserTypeDefinitionFile {
  filePath: string;
  content: string;
  kind: "global" | "module";
  moduleName?: string;
}

export interface BrowserTypeDefinitions {
  FS_TYPE_DEFINITIONS: string;
  PATH_TYPE_DEFINITIONS: string;
  GLOBAL_TYPE_DEFINITIONS: string;
  TS_LIB_FILES: Record<string, string>;
  typeDefinitionFiles: BrowserTypeDefinitionFile[];
  tsLibFilePaths: Record<string, string>;
}

export function getMonacoTsLibFilePath(libName: string): string {
  return `${MONACO_TYPESCRIPT_LIB_ROOT}/${libName}`;
}

export function getBrowserTypeDefinitionFiles(): BrowserTypeDefinitionFile[] {
  return [
    {
      filePath: MONACO_GLOBAL_TYPE_DEFINITIONS_PATH,
      content: GLOBAL_TYPE_DEFINITIONS,
      kind: "global",
    },
    {
      filePath: MONACO_FS_TYPE_DEFINITIONS_PATH,
      content: FS_TYPE_DEFINITIONS,
      kind: "module",
      moduleName: "fs",
    },
    {
      filePath: MONACO_PATH_TYPE_DEFINITIONS_PATH,
      content: PATH_TYPE_DEFINITIONS,
      kind: "module",
      moduleName: "path",
    },
  ];
}

export function getBrowserTypeDefinitions(): BrowserTypeDefinitions {
  return {
    FS_TYPE_DEFINITIONS,
    PATH_TYPE_DEFINITIONS,
    GLOBAL_TYPE_DEFINITIONS,
    TS_LIB_FILES: { ...TS_LIB_FILES },
    typeDefinitionFiles: getBrowserTypeDefinitionFiles(),
    tsLibFilePaths: Object.fromEntries(
      Object.keys(TS_LIB_FILES).map((libName) => [libName, getMonacoTsLibFilePath(libName)]),
    ),
  };
}
