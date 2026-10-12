#!/usr/bin/env node
import process from "node:process";
import { fileURLToPath } from "node:url";

function parseStableReleaseTag(tag) {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(tag);
  if (!match) throw new Error(`Expected a stable v-prefixed release tag, received "${tag}"`);
  return match.slice(1).map(BigInt);
}

/** Compare candidate against current latest: positive means candidate is newer. */
export function compareReleaseTags(currentTag, candidateTag) {
  const current = parseStableReleaseTag(currentTag);
  const candidate = parseStableReleaseTag(candidateTag);
  for (let index = 0; index < 3; index += 1) {
    if (candidate[index] > current[index]) return 1;
    if (candidate[index] < current[index]) return -1;
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const [currentTag, candidateTag] = process.argv.slice(2);
    if (currentTag === undefined || candidateTag === undefined) {
      throw new Error("Usage: compare-release-tags.mjs CURRENT_TAG CANDIDATE_TAG");
    }
    const comparison = compareReleaseTags(currentTag, candidateTag);
    console.log(comparison > 0 ? "newer" : comparison === 0 ? "equal" : "older");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
