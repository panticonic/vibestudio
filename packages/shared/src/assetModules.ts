/**
 * Asset imports a workspace unit may make from TypeScript.
 *
 * This is the single contract between the bundler (which must load these
 * files) and the typechecker (which must accept the imports). Stylesheets are
 * bundled by esbuild natively and import as side effects; every other
 * extension resolves to a URL string default export.
 */
export const ASSET_URL_EXTENSIONS: readonly string[] = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".svg",
  ".ico",
  ".bmp",
  ".tif",
  ".tiff",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".mp3",
  ".aac",
  ".m4a",
  ".flac",
  ".oga",
  ".wav",
  ".ogg",
  ".opus",
  ".aif",
  ".aiff",
  ".mp4",
  ".m4v",
  ".webm",
  ".ogv",
  ".mov",
  ".avi",
  ".mkv",
  ".wasm",
  ".pdf",
];

export const STYLESHEET_EXTENSIONS: readonly string[] = [".css"];

/** Ambient module declarations matching the bundler's asset loaders. */
export function assetModuleDeclarations(): string {
  const lines: string[] = [
    "// Generated from @vibestudio/shared/assetModules — the bundler's asset contract.",
  ];
  for (const ext of STYLESHEET_EXTENSIONS) lines.push(`declare module "*${ext}" {}`);
  for (const ext of ASSET_URL_EXTENSIONS) {
    lines.push(`declare module "*${ext}" {`, "  const src: string;", "  export default src;", "}");
  }
  return `${lines.join("\n")}\n`;
}
