import type * as esbuild from "esbuild";

/**
 * Framework adapter — encapsulates compilation concerns for a specific
 * component framework. Adapters are build-system code (server-side).
 *
 * Presentation concerns (CSS framework, HTML shell) live in workspace
 * templates, not here. The adapter's cdnStylesheets/additionalCss/rootElementHtml
 * are only used as a last-resort fallback when no template is available.
 */
export interface FrameworkAdapter {
  readonly id: string;

  /** Packages to deduplicate across chunks (e.g., react, react-dom) */
  readonly dedupePackages: readonly string[];

  /**
   * Globally order-safe base styles emitted as one content-addressed asset.
   * Panel-specific/component styles stay in the panel CSS output.
   */
  readonly sharedStyles?: readonly string[];

  /** esbuild jsx mode */
  readonly jsx?: "automatic" | "preserve" | "transform";

  /** esbuild tsconfigRaw compilerOptions.jsx value (e.g., "react-jsx") */
  readonly tsconfigJsx?: "preserve" | "react" | "react-jsx" | "react-native" | "react-jsxdev";

  /** Additional esbuild plugins (e.g., svelte compiler) */
  readonly plugins?: () => esbuild.Plugin[];

  /**
   * Generate the entry wrapper that imports the user module and mounts it.
   *
   * `frameworkModule` overrides the workspace module the wrapper imports the
   * auto-mount contract from (see `platformModules.FRAMEWORK_MODULES`); when
   * omitted, the adapter uses the platform default for its framework. Set per
   * unit via the `vibestudio.frameworkModule` manifest field. Adapters without an
   * auto-mount module (vanilla) ignore it.
   */
  generateEntry(exposeEntryFile: string, entryFile: string, frameworkModule?: string): string;

  // --- Fallback HTML generation (only used when no template HTML is found) ---

  /** CDN stylesheets to inject in default HTML <head> */
  readonly cdnStylesheets?: readonly string[];

  /** Extra CSS rules for default HTML <style> */
  readonly additionalCss?: string;

  /** Root element HTML for <body> */
  readonly rootElementHtml?: string;
}
