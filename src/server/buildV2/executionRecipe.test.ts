import { describe, expect, it } from "vitest";
import { parseSha256 } from "@vibestudio/shared/execution/identity";
import {
  BUILDER_IMPLEMENTATION_CONTRACT,
  computeBuilderImplementationDigest,
} from "../../../scripts/builder-implementation-digest.mjs";

describe("execution recipe builder identity", () => {
  it("produces one full immutable digest for source and bundled host injection", () => {
    expect(BUILDER_IMPLEMENTATION_CONTRACT).toBe("vibestudio-build-v2/execution-recipe/v1");
    expect(parseSha256(computeBuilderImplementationDigest(process.cwd()))).toHaveLength(64);
  });
});
