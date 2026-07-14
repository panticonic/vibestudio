/** Canonical wire contract for live account profiles and self-service personalization. */

import { z } from "zod";
import type { MethodAccessDescriptor, ServiceAuthorityPolicy } from "@vibestudio/shared/serviceAuthority";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import { HANDLE_PATTERN, RESERVED_HANDLES } from "@vibestudio/identity/types";

const ACCOUNT_READ_POLICY: ServiceAuthorityPolicy = {
  principals: ["host", "user", "code", "entity"],
};

const READ_ACCESS: MethodAccessDescriptor = { sensitivity: "read" };
const WRITE_ACCESS: MethodAccessDescriptor = { sensitivity: "write" };

export const MAX_AVATAR_DATA_URI_BYTES = 256 * 1024;
export const ACCOUNT_AVATAR_DATA_URI_PATTERN =
  /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
const COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export const accountProfileSchema = z
  .object({
    userId: z.string(),
    handle: z.string(),
    displayName: z.string(),
    role: z.enum(["root", "admin", "member"]),
    color: z.string().optional(),
    avatar: z.string().optional(),
    revoked: z.boolean().optional(),
  })
  .strict();

export type AccountProfile = z.infer<typeof accountProfileSchema>;

export const accountProfileUpdateSchema = z
  .object({
    /** Defaults to the authenticated caller. Editing another user is root-only. */
    userId: z.string().min(1).optional(),
    displayName: z.string().min(1).max(200).optional(),
    avatar: z
      .string()
      .regex(
        ACCOUNT_AVATAR_DATA_URI_PATTERN,
        "Avatar must be a base64 PNG, JPEG, WebP, or GIF data URI"
      )
      .max(
        MAX_AVATAR_DATA_URI_BYTES,
        `Avatar data: URI exceeds ${MAX_AVATAR_DATA_URI_BYTES} bytes — use a smaller image`
      )
      .nullable()
      .optional(),
    color: z
      .string()
      .regex(COLOR_PATTERN, "Color must be a hex tint like #4a90d9")
      .nullable()
      .optional(),
    handle: z
      .string()
      .regex(HANDLE_PATTERN, "Handle must match /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/")
      .refine((handle) => !RESERVED_HANDLES.has(handle), "Handle is reserved")
      .optional(),
  })
  .strict();

export type AccountProfileUpdate = z.infer<typeof accountProfileUpdateSchema>;

export const accountMethods = defineServiceMethods({
  getProfile: {
    description:
      "Resolve one account's live profile (defaults to the caller's own subject). Returns null for an unknown userId.",
    args: z.tuple([z.string().optional()]),
    returns: accountProfileSchema.nullable(),
    authority: ACCOUNT_READ_POLICY,
    access: READ_ACCESS,
  },
  resolveProfiles: {
    description:
      "Batch-resolve userIds to live profiles for rendering user participants. Unknown ids are absent from the result.",
    args: z.tuple([z.array(z.string())]),
    returns: z.record(z.string(), accountProfileSchema),
    authority: ACCOUNT_READ_POLICY,
    access: READ_ACCESS,
  },
  isMember: {
    description:
      "Return whether a user belongs to this child server's bound workspace. The workspace is host-bound, never caller-selected.",
    args: z.tuple([z.string().min(1)]),
    returns: z.boolean(),
    authority: ACCOUNT_READ_POLICY,
    access: READ_ACCESS,
  },
  listWorkspaceMembers: {
    description:
      "List live account profiles for this child server's bound workspace, including implicit root membership.",
    args: z.tuple([]),
    returns: z.array(accountProfileSchema),
    authority: ACCOUNT_READ_POLICY,
    access: READ_ACCESS,
  },
  updateProfile: {
    description:
      "Update personalization (displayName/avatar/color/handle). Self, or root for others. The hub is the sole identity writer.",
    args: z.tuple([accountProfileUpdateSchema]),
    returns: accountProfileSchema,
    access: WRITE_ACCESS,
  },
});
