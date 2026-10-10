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
