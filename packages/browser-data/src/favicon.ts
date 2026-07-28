export const FAVICON_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/x-icon",
  "image/svg+xml",
  "image/bmp",
  "image/avif",
] as const;

export type FaviconMimeType = (typeof FAVICON_MIME_TYPES)[number];

export const MAX_PAGE_FAVICON_BYTES = 128 * 1024;

const ASCII = new TextDecoder("ascii");
const UTF8 = new TextDecoder("utf-8", { fatal: false });

export function isFaviconMimeType(value: string): value is FaviconMimeType {
  return (FAVICON_MIME_TYPES as readonly string[]).includes(value);
}

/**
 * Determine an icon's actual format from its bytes.
 *
 * Browser profile databases are not consistent about MIME metadata. Chromium's
 * `icon_type` describes how an icon is used, not its encoding, while Firefox
 * often has only an icon URL whose extension may be absent or misleading.
 * Import and storage therefore agree on byte signatures instead of trusting
 * either hint.
 */
export function detectFaviconMimeType(bytes: Uint8Array): FaviconMimeType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWithAscii(bytes, "GIF87a") || startsWithAscii(bytes, "GIF89a")) {
    return "image/gif";
  }
  if (
    bytes.byteLength >= 12 &&
    startsWithAscii(bytes, "RIFF") &&
    ASCII.decode(bytes.subarray(8, 12)) === "WEBP"
  ) {
    return "image/webp";
  }
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00])) return "image/x-icon";
  if (startsWithAscii(bytes, "BM")) return "image/bmp";
  if (isAvif(bytes)) return "image/avif";
  if (isSvg(bytes)) return "image/svg+xml";
  return null;
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.byteLength < signature.length) return false;
  return signature.every((value, index) => bytes[index] === value);
}

function startsWithAscii(bytes: Uint8Array, signature: string): boolean {
  if (bytes.byteLength < signature.length) return false;
  return ASCII.decode(bytes.subarray(0, signature.length)) === signature;
}

function isAvif(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 16 || ASCII.decode(bytes.subarray(4, 8)) !== "ftyp") {
    return false;
  }
  for (let offset = 8; offset + 4 <= Math.min(bytes.byteLength, 64); offset += 4) {
    const brand = ASCII.decode(bytes.subarray(offset, offset + 4));
    if (brand === "avif" || brand === "avis") return true;
  }
  return false;
}

function isSvg(bytes: Uint8Array): boolean {
  // Only the XML prologue can precede the root element. Keeping the scan
  // bounded avoids treating arbitrary text containing "<svg" as an image.
  let source = UTF8.decode(bytes.subarray(0, Math.min(bytes.byteLength, 16 * 1024)))
    .replace(/^\uFEFF/, "")
    .trimStart();

  while (source.length > 0) {
    if (source.startsWith("<?xml")) {
      const end = source.indexOf("?>");
      if (end < 0) return false;
      source = source.slice(end + 2).trimStart();
      continue;
    }
    if (source.startsWith("<!--")) {
      const end = source.indexOf("-->");
      if (end < 0) return false;
      source = source.slice(end + 3).trimStart();
      continue;
    }
    if (/^<!doctype\s/i.test(source)) {
      const end = source.indexOf(">");
      if (end < 0) return false;
      source = source.slice(end + 1).trimStart();
      continue;
    }
    return /^<svg(?:\s|>)/i.test(source);
  }
  return false;
}
