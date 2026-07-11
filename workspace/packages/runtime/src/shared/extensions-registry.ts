// @vibestudio-extension-registry-sink
// Workspace-owned registry sink — the Vibestudio host rewrites everything below the
// directive line whenever the workspace extension set changes (generator:
// @vibestudio/shared/workspace/extensionRegistry). Keep the directive to stay
// subscribed; remove it (or delete the file) to opt out; move the file to
// relocate the registry. The committed contents are the fallback used when the
// host has not (re)generated the registry.
//
// Type-only re-exports that pull each workspace extension's module into the
// type-check program so its `declare module "@vibestudio/extension"` registry
// augmentation is active. Re-exported from the runtime SDK's extensions
// surface, so any panel that imports `@workspace/runtime` can type-check
// `extensions.use("...")` against the full registry — the same set the
// repo-wide `tsc` sees via `include`.

export type { Api as Ext_workspace_extensions_claude_code } from "@workspace-extensions/claude-code";
export type { Api as Ext_workspace_extensions_file_tools } from "@workspace-extensions/file-tools";
export type { Api as Ext_workspace_extensions_image_service } from "@workspace-extensions/image-service";
export type { Api as Ext_workspace_extensions_local_models } from "@workspace-extensions/local-models";
export type { Api as Ext_workspace_extensions_mobile_debug } from "@workspace-extensions/mobile-debug";
export type { Api as Ext_workspace_extensions_pdf_ingest } from "@workspace-extensions/pdf-ingest";
export type { Api as Ext_workspace_extensions_react_native } from "@workspace-extensions/react-native";
export type { Api as Ext_workspace_extensions_shell } from "@workspace-extensions/shell";
