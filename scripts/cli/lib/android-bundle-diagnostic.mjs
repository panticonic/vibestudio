import path from "node:path";

const maxExcerptLines = 7;
const maxExcerptLineCharacters = 240;

export function activeBundleCacheRelativePath(preferencesXml) {
  const match = preferencesXml.match(
    /<string\s+name="activeBundle\.localPath">([^<]+)<\/string>/
  );
  if (!match) throw new Error("Active React Native bundle path is absent from app preferences");
  const localPath = match[1]
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
  const marker = "/cache/vibestudio-rn/";
  const markerIndex = localPath.lastIndexOf(marker);
  if (markerIndex < 0) throw new Error("Active React Native bundle is outside the app bundle cache");
  const relative = localPath.slice(markerIndex + "/cache/".length);
  const segments = relative.split("/");
  if (
    segments.length < 2 ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        !/^[A-Za-z0-9._-]+$/.test(segment)
    )
  ) {
    throw new Error("Active React Native bundle path contains an invalid cache path");
  }
  return path.posix.join("cache", ...segments);
}

export function parseHermesLocation(message) {
  const patterns = [
    /\bCompiling JS failed:\s*(\d+)\s*:\s*(\d+)\s*:/i,
    /\bline\s+(\d+)\s*,\s*column\s+(\d+)\b/i,
    /\bline\s+(\d+)\s*:\s*(\d+)\b/i,
    /\((\d+)\s*:\s*(\d+)\)/,
  ];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match) return { line: Number(match[1]), column: Number(match[2]) };
  }
  return null;
}

export function bundleLineExcerpt(source, location) {
  if (
    !location ||
    !Number.isInteger(location.line) ||
    location.line < 1 ||
    !Number.isInteger(location.column) ||
    location.column < 1
  ) {
    return null;
  }
  const lines = source.split(/\r?\n/);
  if (location.line > lines.length) return null;
  const radius = Math.floor(maxExcerptLines / 2);
  const start = Math.max(1, location.line - radius);
  const end = Math.min(lines.length, start + maxExcerptLines - 1);
  const width = String(end).length;
  return lines
    .slice(start - 1, end)
    .map((line, index) => {
      const number = start + index;
      const marker = number === location.line ? ">" : " ";
      const sourceLine = lines[number - 1];
      const columnIndex = Math.max(0, location.column - 1);
      const cropStart =
        sourceLine.length <= maxExcerptLineCharacters
          ? 0
          : Math.max(
              0,
              Math.min(
                sourceLine.length - maxExcerptLineCharacters,
                columnIndex - Math.floor(maxExcerptLineCharacters / 2)
              )
            );
      const cropEnd = Math.min(sourceLine.length, cropStart + maxExcerptLineCharacters);
      const displayLine = `${cropStart > 0 ? "…" : ""}${sourceLine.slice(cropStart, cropEnd)}${cropEnd < sourceLine.length ? "…" : ""}`;
      const caretOffset = Math.min(
        maxExcerptLineCharacters,
        Math.max(0, columnIndex - cropStart)
      );
      const caret =
        number === location.line
          ? `\n  ${" ".repeat(width + 1)}${" ".repeat((cropStart > 0 ? 1 : 0) + caretOffset)}^`
          : "";
      return `${marker} ${String(number).padStart(width)} | ${displayLine}${caret}`;
    })
    .join("\n");
}
