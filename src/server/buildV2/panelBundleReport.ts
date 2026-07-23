import * as path from "node:path";
import type { Metafile } from "esbuild";

export interface PanelBundlePayloadReport {
  requests: number;
  bytes: number;
  jsBytes: number;
  cssBytes: number;
}

export interface PanelBundleReport {
  version: 2;
  mode: "report-only";
  entryOutput: string;
  /** Static output closure required before the panel entry can execute. */
  initialArtifacts: string[];
  initial: PanelBundlePayloadReport;
  lazy: PanelBundlePayloadReport;
  total: PanelBundlePayloadReport;
  largestJsChunkBytes: number;
  largestInitialInputs: Array<{ source: string; bytes: number }>;
  largestLazyInputs: Array<{ source: string; bytes: number }>;
}

const payloadOutput = (outputPath: string): boolean => !outputPath.endsWith(".map");

function canonicalOutputPath(outputPath: string): string {
  return outputPath.replaceAll("\\", "/");
}

function importedOutput(
  outputs: Metafile["outputs"],
  importerPath: string,
  importedPath: string
): string | null {
  const canonicalImport = canonicalOutputPath(importedPath);
  if (outputs[canonicalImport]) return canonicalImport;

  const importer = canonicalOutputPath(importerPath);
  const relative = path.posix.normalize(
    path.posix.join(path.posix.dirname(importer), canonicalImport)
  );
  if (outputs[relative]) return relative;

  const absolute = canonicalOutputPath(path.resolve(path.dirname(importerPath), importedPath));
  return outputs[absolute] ? absolute : null;
}

function staticClosure(
  metafile: Metafile,
  entryOutput: string,
  cssOutput?: string,
  additionalInitialOutputs: readonly string[] = []
): Set<string> {
  const initial = new Set<string>();
  const pending = [entryOutput, ...(cssOutput ? [cssOutput] : []), ...additionalInitialOutputs];
  while (pending.length > 0) {
    const outputPath = pending.pop();
    if (!outputPath) continue;
    if (initial.has(outputPath)) continue;
    const output = metafile.outputs[outputPath];
    if (!output) continue;
    initial.add(outputPath);
    for (const imported of output.imports) {
      if (imported.external || imported.kind === "dynamic-import") continue;
      const resolved = importedOutput(metafile.outputs, outputPath, imported.path);
      if (resolved && !initial.has(resolved)) pending.push(resolved);
    }
  }
  return initial;
}

function payloadReport(outputs: readonly string[], metafile: Metafile): PanelBundlePayloadReport {
  let bytes = 0;
  let jsBytes = 0;
  let cssBytes = 0;
  for (const outputPath of outputs) {
    const size = metafile.outputs[outputPath]?.bytes ?? 0;
    bytes += size;
    if (outputPath.endsWith(".js")) jsBytes += size;
    if (outputPath.endsWith(".css")) cssBytes += size;
  }
  return {
    requests: outputs.length,
    bytes,
    jsBytes,
    cssBytes,
  };
}

function inputSource(inputPath: string): string {
  const canonical = canonicalOutputPath(inputPath);
  const nestedPackage = canonical.lastIndexOf("/node_modules/");
  if (nestedPackage >= 0) {
    let packagePath = canonical.slice(nestedPackage + "/node_modules/".length);
    if (packagePath.startsWith(".pnpm/")) {
      const inner = packagePath.indexOf("/node_modules/");
      if (inner >= 0) packagePath = packagePath.slice(inner + "/node_modules/".length);
    }
    const parts = packagePath.split("/");
    return `npm:${parts[0]?.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]}`;
  }
  const workspaceMarker = "/workspace/";
  const workspaceIndex = canonical.lastIndexOf(workspaceMarker);
  const relative =
    workspaceIndex >= 0 ? canonical.slice(workspaceIndex + workspaceMarker.length) : canonical;
  const parts = relative.split("/").filter(Boolean);
  return `workspace:${parts.slice(0, 2).join("/")}`;
}

function largestInputs(
  outputs: readonly string[],
  metafile: Metafile
): Array<{ source: string; bytes: number }> {
  const totals = new Map<string, number>();
  for (const outputPath of outputs) {
    for (const [inputPath, input] of Object.entries(metafile.outputs[outputPath]?.inputs ?? {})) {
      const source = inputSource(inputPath);
      totals.set(source, (totals.get(source) ?? 0) + input.bytesInOutput);
    }
  }
  return [...totals]
    .map(([source, bytes]) => ({ source, bytes }))
    .sort((left, right) => right.bytes - left.bytes || left.source.localeCompare(right.source))
    .slice(0, 20);
}

/**
 * Derive the deterministic initial static output closure from esbuild's
 * metafile. Compression belongs to the asynchronous transport-derivative
 * pipeline; computing it here would put every lazy output on the build path.
 */
export function createPanelBundleReport(
  metafile: Metafile,
  entryOutput: string,
  cssOutput: string | undefined,
  additionalInitialOutputs: readonly string[] = []
): PanelBundleReport {
  const payloadOutputs = Object.keys(metafile.outputs).filter(payloadOutput).sort();
  const initialSet = staticClosure(metafile, entryOutput, cssOutput, additionalInitialOutputs);
  const initialOutputs = payloadOutputs.filter((outputPath) => initialSet.has(outputPath));
  const lazyOutputs = payloadOutputs.filter((outputPath) => !initialSet.has(outputPath));
  const jsChunks = payloadOutputs.filter(
    (outputPath) => outputPath.endsWith(".js") && outputPath !== entryOutput
  );

  return {
    version: 2,
    mode: "report-only",
    entryOutput: canonicalOutputPath(entryOutput),
    initialArtifacts: initialOutputs.map(canonicalOutputPath),
    initial: payloadReport(initialOutputs, metafile),
    lazy: payloadReport(lazyOutputs, metafile),
    total: payloadReport(payloadOutputs, metafile),
    largestJsChunkBytes: jsChunks.reduce(
      (largest, outputPath) => Math.max(largest, metafile.outputs[outputPath]?.bytes ?? 0),
      0
    ),
    largestInitialInputs: largestInputs(initialOutputs, metafile),
    largestLazyInputs: largestInputs(lazyOutputs, metafile),
  };
}
