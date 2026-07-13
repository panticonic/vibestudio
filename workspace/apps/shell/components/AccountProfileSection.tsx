import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Box, Button, Callout, Flex, Spinner, Text, TextField } from "@radix-ui/themes";
import { CheckCircledIcon, ExclamationTriangleIcon } from "@radix-ui/react-icons";
import { isValidHandle } from "@vibestudio/identity/types";
import {
  ACCOUNT_AVATAR_DATA_URI_PATTERN,
  MAX_AVATAR_DATA_URI_BYTES,
} from "@vibestudio/service-schemas/account";
import { account, type ShellAccountProfile } from "../shell/client";

const COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

interface AccountProfileSectionProps {
  active: boolean;
}

interface ProfileDraft {
  displayName: string;
  handle: string;
  color: string;
}

const EMPTY_DRAFT: ProfileDraft = { displayName: "", handle: "", color: "" };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function draftFor(profile: ShellAccountProfile): ProfileDraft {
  return {
    displayName: profile.displayName,
    handle: profile.handle,
    color: profile.color ?? "",
  };
}

function initials(draft: ProfileDraft): string {
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

async function avatarDataUriFromFile(file: File): Promise<string> {
  if (!/^image\/(?:png|jpeg|webp|gif)$/.test(file.type)) {
    throw new Error("Choose a PNG, JPEG, WebP, or GIF image.");
  }
  if (file.size > 12 * 1024 * 1024) throw new Error("Choose an image smaller than 12 MB.");
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = objectUrl;
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("The selected image could not be decoded."));
    });
    const sourceSize = Math.min(image.naturalWidth, image.naturalHeight);
    if (sourceSize < 1) throw new Error("The selected image has no visible pixels.");
    const sourceX = (image.naturalWidth - sourceSize) / 2;
    const sourceY = (image.naturalHeight - sourceSize) / 2;
    for (const size of [512, 384, 256]) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.min(size, sourceSize);
      canvas.height = canvas.width;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Image processing is unavailable.");
      context.drawImage(
        image,
        sourceX,
        sourceY,
        sourceSize,
        sourceSize,
        0,
        0,
        canvas.width,
        canvas.height
      );
      for (const quality of [0.88, 0.76, 0.64, 0.52]) {
        const dataUri = canvas.toDataURL("image/webp", quality);
        if (
          dataUri.length <= MAX_AVATAR_DATA_URI_BYTES &&
          ACCOUNT_AVATAR_DATA_URI_PATTERN.test(dataUri)
        ) {
          return dataUri;
        }
      }
    }
    throw new Error("The image could not be reduced below the 256 KiB profile limit.");
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export function AccountProfileSection({ active }: AccountProfileSectionProps) {
  const [profile, setProfile] = useState<ShellAccountProfile | null>(null);
  const [draft, setDraft] = useState<ProfileDraft>(EMPTY_DRAFT);
  const [avatarDraft, setAvatarDraft] = useState<string | null | undefined>(undefined);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const requestRef = useRef(0);

  const applyProfile = useCallback((next: ShellAccountProfile) => {
    setProfile(next);
    setDraft(draftFor(next));
    setAvatarDraft(undefined);
  }, []);

  const loadProfile = useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const next = await account.getProfile();
      if (!next) throw new Error("The connected session has no active workspace account.");
      if (request === requestRef.current) applyProfile(next);
    } catch (loadError) {
      if (request === requestRef.current) setError(errorMessage(loadError));
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [applyProfile]);

  useEffect(() => {
    if (active) void loadProfile();
    return () => {
      requestRef.current += 1;
    };
  }, [active, loadProfile]);

  const validationError = useMemo(() => {
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
  }, [draft]);

  const normalizedColor = draft.color.trim();
  const previewAvatar = avatarDraft === undefined ? profile?.avatar : (avatarDraft ?? undefined);
  const dirty =
    profile !== null &&
    (draft.displayName !== profile.displayName ||
      draft.handle !== profile.handle ||
      normalizedColor !== (profile.color ?? "") ||
      avatarDraft !== undefined);

  const updateDraft = (patch: Partial<ProfileDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setError(null);
    setSuccess(null);
  };

  const save = async () => {
    if (!profile || validationError || saving) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const next = await account.updateProfile({
        displayName: draft.displayName.trim(),
        handle: draft.handle.trim(),
        color: normalizedColor || null,
        ...(avatarDraft !== undefined ? { avatar: avatarDraft } : {}),
      });
      applyProfile(next);
      setSuccess("Profile saved.");
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Flex direction="column" gap="3" aria-label="Account profile">
      <Flex justify="between" align="center" gap="3">
        <Box>
          <Text as="div" size="3" weight="medium">
            Your profile
          </Text>
          <Text as="div" size="1" color="gray">
            Shown to people in every workspace you share.
          </Text>
        </Box>
        {profile ? (
          <Box
            aria-label="Profile color preview"
            style={
              {
                width: 34,
                height: 34,
                flexShrink: 0,
                overflow: "hidden",
                borderRadius: "50%",
                border: "1px solid var(--surface-border)",
                background: normalizedColor || "var(--gray-5)",
                display: "grid",
                placeItems: "center",
                color: "white",
                fontSize: 12,
                fontWeight: 700,
              } as CSSProperties
            }
          >
            {previewAvatar ? (
              <img
                src={previewAvatar}
                alt="Profile avatar preview"
                style={{ width: "100%", height: "100%", objectFit: "cover" }}
              />
            ) : (
              initials(draft)
            )}
          </Box>
        ) : null}
      </Flex>

      {loading ? (
        <Flex align="center" gap="2" role="status">
          <Spinner size="1" />
          <Text size="2" color="gray">
            Loading profile…
          </Text>
        </Flex>
      ) : null}

      {!loading && profile ? (
        <>
          <Flex gap="3" direction={{ initial: "column", sm: "row" }}>
            <Box style={{ flex: 1 }}>
              <Text as="label" htmlFor="account-display-name" size="1" weight="medium">
                Display name
              </Text>
              <TextField.Root
                id="account-display-name"
                aria-label="Display name"
                value={draft.displayName}
                maxLength={200}
                disabled={saving}
                onChange={(event) => updateDraft({ displayName: event.target.value })}
              />
            </Box>
            <Box style={{ flex: 1 }}>
              <Text as="label" htmlFor="account-handle" size="1" weight="medium">
                Handle
              </Text>
              <TextField.Root
                id="account-handle"
                aria-label="Handle"
                value={draft.handle}
                maxLength={64}
                disabled={saving}
                onChange={(event) => updateDraft({ handle: event.target.value })}
              >
                <TextField.Slot side="left">@</TextField.Slot>
              </TextField.Root>
            </Box>
          </Flex>

          <Flex gap="3" align="end" wrap="wrap">
            <Box style={{ width: 180 }}>
              <Text as="label" htmlFor="account-color" size="1" weight="medium">
                Profile color
              </Text>
              <TextField.Root
                id="account-color"
                aria-label="Profile color"
                placeholder="#4a90d9"
                value={draft.color}
                maxLength={9}
                disabled={saving}
                aria-invalid={Boolean(validationError?.startsWith("Color"))}
                onChange={(event) => updateDraft({ color: event.target.value })}
              />
            </Box>
            <input
              ref={avatarInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              style={{ display: "none" }}
              aria-label="Choose profile avatar image"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                setError(null);
                setSuccess(null);
                void avatarDataUriFromFile(file)
                  .then((avatar) => setAvatarDraft(avatar))
                  .catch((avatarError) => setError(errorMessage(avatarError)));
              }}
            />
            <Button
              type="button"
              size="1"
              variant="soft"
              disabled={saving}
              onClick={() => avatarInputRef.current?.click()}
            >
              {previewAvatar ? "Change avatar" : "Choose avatar"}
            </Button>
            {previewAvatar ? (
              <Button
                type="button"
                size="1"
                variant="soft"
                color="red"
                disabled={saving}
                onClick={() => {
                  setAvatarDraft(null);
                  setError(null);
                  setSuccess(null);
                }}
              >
                Clear avatar
              </Button>
            ) : null}
            {avatarDraft !== undefined ? (
              <Button
                type="button"
                size="1"
                variant="ghost"
                disabled={saving}
                onClick={() => setAvatarDraft(undefined)}
              >
                Undo avatar change
              </Button>
            ) : null}
            <Button
              type="button"
              size="2"
              disabled={!dirty || Boolean(validationError) || saving}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save profile"}
            </Button>
          </Flex>

          {validationError ? (
            <Text size="1" color="red" role="alert">
              {validationError}
            </Text>
          ) : null}
        </>
      ) : null}

      {error ? (
        <Callout.Root size="1" color="red" role="alert">
          <Callout.Icon>
            <ExclamationTriangleIcon />
          </Callout.Icon>
          <Callout.Text>{error}</Callout.Text>
          {!profile && !loading ? (
            <Button size="1" variant="soft" color="red" onClick={() => void loadProfile()}>
              Retry
            </Button>
          ) : null}
        </Callout.Root>
      ) : null}

      {success ? (
        <Callout.Root size="1" color="green" role="status">
          <Callout.Icon>
            <CheckCircledIcon />
          </Callout.Icon>
          <Callout.Text>{success}</Callout.Text>
        </Callout.Root>
      ) : null}
    </Flex>
  );
}
