import { expect, it } from "vitest";
import {
  WorkspaceAppCompatibilitySchema,
  appCompatibilityError,
  strongestMinimumAppVersion,
} from "./appCompatibility";
it("accepts optional exact floors within one generation and rejects ambiguous requirements", () => {
  expect(WorkspaceAppCompatibilitySchema.parse({ systemEpoch: 0 })).toEqual({ systemEpoch: 0 });
  for (const minimumAppVersion of [">=0.1.0", "0.1", "1.0.0"])
    expect(() =>
      WorkspaceAppCompatibilitySchema.parse({ systemEpoch: 0, minimumAppVersion })
    ).toThrow();
});
it("gates versions including prereleases without permitting another generation", () => {
  const requirement = { systemEpoch: 1, minimumAppVersion: "1.2.0" };
  expect(appCompatibilityError(requirement, "1.1.9")).toContain("1.2.0");
  expect(appCompatibilityError(requirement, "1.2.0-rc.1")).toContain("1.2.0");
  expect(appCompatibilityError(requirement, "1.2.0")).toBeNull();
  expect(appCompatibilityError(requirement, "1.3.0")).toBeNull();
  expect(appCompatibilityError(requirement, "2.0.0")).toContain("generation");
  expect(strongestMinimumAppVersion([undefined, "1.10.0", "1.9.0"])).toBe("1.10.0");
});
