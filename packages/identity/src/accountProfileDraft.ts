import { isValidHandle } from "./types.js";

export interface AccountProfileFields {
  displayName: string;
  handle: string;
  color?: string | null;
}

export interface AccountProfileDraft {
  displayName: string;
  handle: string;
  color: string;
}

export const EMPTY_ACCOUNT_PROFILE_DRAFT: AccountProfileDraft = {
  displayName: "",
  handle: "",
  color: "",
};

const COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export function accountProfileDraftFor(profile: AccountProfileFields): AccountProfileDraft {
  return {
    displayName: profile.displayName,
    handle: profile.handle,
    color: profile.color ?? "",
  };
}

export function validateAccountProfileDraft(draft: AccountProfileDraft): string | null {
  const displayName = draft.displayName.trim();
  const handle = draft.handle.trim();
  const color = draft.color.trim();
  if (!displayName) return "Display name is required.";
  if (displayName.length > 200) return "Display name must be 200 characters or fewer.";
  if (!isValidHandle(handle)) {
    return "Handle must start with a letter, use at most 64 letters, numbers, _ or -, and cannot be reserved.";
  }
  if (color && !COLOR_PATTERN.test(color)) {
    return "Color must be a 3, 4, 6, or 8 digit hex value, including #.";
  }
  return null;
}

export function normalizedAccountProfileColor(draft: AccountProfileDraft): string | null {
  return draft.color.trim() || null;
}

export function accountProfileDraftIsDirty(
  profile: AccountProfileFields,
  draft: AccountProfileDraft,
  avatarChanged = false
): boolean {
  return (
    draft.displayName !== profile.displayName ||
    draft.handle !== profile.handle ||
    (normalizedAccountProfileColor(draft) ?? "") !== (profile.color ?? "") ||
    avatarChanged
  );
}

export function accountProfileInitials(draft: AccountProfileDraft): string {
  const source = draft.displayName.trim() || draft.handle.trim();
  return (
    source
      .split(/\s+/)
      .map((part) => part[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "?"
  );
}
