import type { TestCase } from "../types.js";
import {
  findLastAgentMessage,
  noIncompleteInvocations,
  successfulEvalCode,
  successfulEvalReturnValues,
} from "./_helpers.js";

function records(value: unknown, found: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const item of value) records(item, found);
    return found;
  }
  if (!value || typeof value !== "object") return found;
  const item = value as Record<string, unknown>;
  found.push(item);
  for (const child of Object.values(item)) records(child, found);
  return found;
}

function hasNamedTrue(values: unknown[], pattern: RegExp): boolean {
  return values.some((value) =>
    records(value).some((item) =>
      Object.entries(item).some(([key, child]) => pattern.test(key) && child === true)
    )
  );
}

function hasDigest(values: unknown[]): boolean {
  return values.some((value) =>
    records(value).some((item) =>
      Object.entries(item).some(
        ([key, child]) =>
          /digest|hash/iu.test(key) && typeof child === "string" && /^[0-9a-f]{64}$/u.test(child)
      )
    )
  );
}

function checked(
  result: Parameters<typeof noIncompleteInvocations>[0],
  methods: RegExp[],
  finalClaims: RegExp[],
  resultProof: (values: unknown[]) => boolean
) {
  const code = successfulEvalCode(result);
  if (!methods.every((method) => method.test(code))) {
    return {
      passed: false,
      reason: "Canonical eval arguments omitted a required blobstore operation",
    };
  }
  const values = successfulEvalReturnValues(result);
  if (values.length === 0 || !resultProof(values)) {
    return {
      passed: false,
      reason: "Canonical eval results omitted the blobstore verification proof",
    };
  }
  const final = findLastAgentMessage(result);
  if (!finalClaims.every((claim) => claim.test(final))) {
    return {
      passed: false,
      reason: "Final response did not semantically report the blobstore round trip",
    };
  }
  const pending = noIncompleteInvocations(result);
  return pending;
}

export const blobstoreTests: TestCase[] = [
  {
    name: "blob-text-roundtrip-grep",
    description: "Store text content-addressably, read a range back, and grep it",
    category: "blobstore",
    prompt:
      "Put a short multi-line document with a distinctive marker line into the workspace's content-addressable storage. Verify the full text, read back a smaller byte range, and search the stored content for that marker without scanning the whole value yourself.",
    validate: (result) =>
      checked(
        result,
        [
          /blobstore\.putText/iu,
          /blobstore\.getText/iu,
          /blobstore\.getRange/iu,
          /blobstore\.grep/iu,
        ],
        [/text|document/iu, /range|bytes/iu, /search|grep|marker|match/iu],
        (values) =>
          hasDigest(values) &&
          hasNamedTrue(values, /full|text|round.?trip/iu) &&
          hasNamedTrue(values, /range|slice/iu) &&
          hasNamedTrue(values, /grep|search|marker|match/iu)
      ),
  },
  {
    name: "blob-binary-roundtrip",
    description: "Store binary data in the blob store and verify the bytes round-trip",
    category: "blobstore",
    prompt:
      "Store a small binary value in the workspace's content-addressable storage and verify that the bytes returned are exactly the bytes you supplied. Report the size you checked.",
    validate: (result) =>
      checked(
        result,
        [
          /blobstore\.putBytes|blobstore\.putBase64/iu,
          /blobstore\.getBytes|blobstore\.getBase64/iu,
        ],
        [/binary|bytes/iu, /\d/u, /match|same|exact|round.trip/iu],
        (values) =>
          hasDigest(values) &&
          hasNamedTrue(values, /equal|same|exact|match|round.?trip/iu) &&
          values.some((value) =>
            records(value).some((item) =>
              Object.entries(item).some(
                ([key, child]) =>
                  /size|length|bytes/iu.test(key) && Number.isInteger(child) && Number(child) > 0
              )
            )
          )
      ),
  },
  {
    name: "blob-tree-lifecycle",
    description: "Build, list, diff, and materialize an immutable blob file tree",
    category: "blobstore",
    prompt:
      "Build a small immutable file tree from a few files, inspect and read it, create a second version with one changed file, and explain the resulting tree difference. Materialize one version into the sandbox and confirm the expected files arrived.",
    validate: (result) =>
      checked(
        result,
        [
          /blobstore\.(?:putTree|createTree)/iu,
          /blobstore\.listTree/iu,
          /blobstore\.(?:getTree|readFileAtTree)/iu,
          /blobstore\.diffTrees/iu,
          /blobstore\.materializeTree/iu,
        ],
        [/tree/iu, /difference|changed|diff/iu, /materializ/iu, /files?/iu],
        (values) => {
          const all = records(values);
          const hashes = all.some((item) =>
            Object.entries(item).some(
              ([key, child]) =>
                /treeHash|stateHash|tree/iu.test(key) &&
                typeof child === "string" &&
                /^(?:manifest|state):[0-9a-f]{64}$/u.test(child)
            )
          );
          const changed = all.some(
            (item) => Array.isArray(item["changed"]) && item["changed"].length > 0
          );
          const materialized = all.some(
            (item) =>
              Number.isInteger(item["written"]) &&
              Number.isInteger(item["unchanged"]) &&
              Number(item["written"]) + Number(item["unchanged"]) > 0
          );
          return hashes && changed && materialized;
        }
      ),
  },
];
