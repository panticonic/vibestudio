/**
 * Workspace extensions the harness calls through the typed client.
 *
 * The harness runs in the app TS program (not as a workspace panel), so it
 * can't reach the `@workspace/runtime` registry barrel that panels use. These
 * type-only re-exports put the file-tools and image-service
 * `WorkspaceExtensions` augmentations into the app program — the same mechanism
 * as the runtime barrel — so `extensions.use("@workspace-extensions/...")` in
 * read/find/grep type-checks. Module resolution relies on the
 * `@workspace-extensions/*` paths declared in the root tsconfig.json.
 *
 * This file is type-only; it has no runtime effect and is never imported.
 */
export type { Api as FileToolsApi } from "@workspace-extensions/file-tools";
export type { Api as ImageServiceApi } from "@workspace-extensions/image-service";
