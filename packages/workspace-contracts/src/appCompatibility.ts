import semver from "semver";
import { z } from "zod";

export const AppVersionSchema = z
  .string()
  .refine((value) => semver.valid(value) === value, "must be an exact SemVer version");

const workspaceAppCompatibilityShape = {
  systemEpoch: z.number().int().nonnegative(),
  minimumAppVersion: AppVersionSchema.optional(),
} satisfies z.ZodRawShape;

/** Keys in the authored compatibility envelope, separate from inherited runtime settings. */
export const WORKSPACE_APP_COMPATIBILITY_FIELDS = Object.freeze(
  Object.keys(workspaceAppCompatibilityShape) as Array<keyof typeof workspaceAppCompatibilityShape>
);

export const WorkspaceAppCompatibilitySchema = z
  .object(workspaceAppCompatibilityShape)
  .superRefine((value, ctx) => {
    const minimum = value.minimumAppVersion ? semver.parse(value.minimumAppVersion) : null;
    if (minimum && minimum.major !== value.systemEpoch)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["minimumAppVersion"],
        message: "must belong to systemEpoch",
      });
  });

export function appCompatibilityError(
  requirement: z.infer<typeof WorkspaceAppCompatibilitySchema>,
  appVersion: string
): string | null {
  AppVersionSchema.parse(appVersion);
  if (semver.major(appVersion) !== requirement.systemEpoch)
    return `Requires app generation ${requirement.systemEpoch}.x; the workspace host is ${appVersion}.`;
  if (requirement.minimumAppVersion && semver.lt(appVersion, requirement.minimumAppVersion))
    return `Requires Vibestudio ${requirement.minimumAppVersion} or later within generation ${requirement.systemEpoch}.x; the workspace host is ${appVersion}.`;
  return null;
}

export function strongestMinimumAppVersion(
  versions: readonly (string | undefined)[]
): string | undefined {
  return versions
    .filter((version): version is string => version !== undefined)
    .sort(semver.rcompare)[0];
}
