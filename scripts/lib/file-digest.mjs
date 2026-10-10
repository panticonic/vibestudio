import * as fs from "node:fs";
import { createHash } from "node:crypto";

export function updateHashFromFile(hash, file) {
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    let size;
    while ((size = fs.readSync(fd, buffer, 0, buffer.length, null)) !== 0)
      hash.update(buffer.subarray(0, size));
  } finally {
    fs.closeSync(fd);
  }
}

export function fileDigest(file) {
  const hash = createHash("sha256");
  updateHashFromFile(hash, file);
  return hash.digest("hex");
}
