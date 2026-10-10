/** Intrinsic source facts, computed when bytes first enter the content store. */
export interface ContentDescriptor {
  contentKind: "text" | "bytes";
  byteLength: number;
  coordinateExtent: number;
}
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
export function intrinsicContentDescriptor(bytes: Uint8Array): ContentDescriptor {
  const byteLength = bytes.byteLength;
  try {
    return { contentKind: "text", byteLength, coordinateExtent: utf8.decode(bytes).length };
  } catch {
    return { contentKind: "bytes", byteLength, coordinateExtent: byteLength };
  }
}
