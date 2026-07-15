import React from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useAtomValue } from "jotai";
import { isValidHandle } from "@vibestudio/identity/types";
import {
  ACCOUNT_AVATAR_DATA_URI_PATTERN,
  MAX_AVATAR_DATA_URI_BYTES,
} from "@vibestudio/service-schemas/account";
import type {
  MobileAccountProfile,
  MobileAccountProfileUpdate,
  ShellClient,
} from "../services/shellClient";
import { readClipboardImageOrText } from "../services/nativeCapabilities";
import { themeColorsAtom } from "../state/themeAtoms";
import { spacing, radius, type, pressedOpacity } from "../design/tokens";
import { Card, SectionHeader } from "./ui/primitives";

const COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

interface MobileAccountProfileSectionProps {
  client: Pick<ShellClient, "refreshAccountProfile" | "updateAccountProfile"> | null;
}

interface ProfileDraft {
  displayName: string;
  handle: string;
  color: string;
}

const EMPTY_DRAFT: ProfileDraft = { displayName: "", handle: "", color: "" };

function draftFor(profile: MobileAccountProfile): ProfileDraft {
  return {
    displayName: profile.displayName,
    handle: profile.handle,
    color: profile.color ?? "",
  };
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

export function MobileAccountProfileSection({ client }: MobileAccountProfileSectionProps) {
  const colors = useAtomValue(themeColorsAtom);
  const [profile, setProfile] = React.useState<MobileAccountProfile | null>(null);
  const [draft, setDraft] = React.useState<ProfileDraft>(EMPTY_DRAFT);
  const [avatarDraft, setAvatarDraft] = React.useState<string | null | undefined>(undefined);
  const [avatarLoading, setAvatarLoading] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<string | null>(null);
  const requestRef = React.useRef(0);

  const applyProfile = React.useCallback((next: MobileAccountProfile) => {
    setProfile(next);
    setDraft(draftFor(next));
    setAvatarDraft(undefined);
  }, []);

  const load = React.useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    setError(null);
    setSuccess(null);
    if (!client) {
      setProfile(null);
      setLoading(false);
      setError("Connect to a workspace to edit your profile.");
      return;
    }
    try {
      const next = await client.refreshAccountProfile();
      if (request === requestRef.current) applyProfile(next);
    } catch (loadError) {
      if (request === requestRef.current) setError(messageFor(loadError));
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [applyProfile, client]);

  React.useEffect(() => {
    void load();
    return () => {
      requestRef.current += 1;
    };
  }, [load]);

  const validationError = React.useMemo(() => {
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
    if (!client || !profile || validationError || saving) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    const update: MobileAccountProfileUpdate = {
      displayName: draft.displayName.trim(),
      handle: draft.handle.trim(),
      color: normalizedColor || null,
      ...(avatarDraft !== undefined ? { avatar: avatarDraft } : {}),
    };
    try {
      const next = await client.updateAccountProfile(update);
      applyProfile(next);
      setSuccess("Profile saved.");
    } catch (saveError) {
      setError(messageFor(saveError));
    } finally {
      setSaving(false);
    }
  };

  const pasteAvatar = async () => {
    if (saving || avatarLoading) return;
    setAvatarLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const avatar = await readClipboardImageOrText();
      if (!ACCOUNT_AVATAR_DATA_URI_PATTERN.test(avatar)) {
        throw new Error("Copy a PNG, JPEG, WebP, or GIF image data URI first.");
      }
      if (avatar.length > MAX_AVATAR_DATA_URI_BYTES) {
        throw new Error("The copied avatar exceeds the 256 KiB profile limit.");
      }
      setAvatarDraft(avatar);
    } catch (avatarError) {
      setError(messageFor(avatarError));
    } finally {
      setAvatarLoading(false);
    }
  };

  return (
    <View accessibilityLabel="Account profile">
      <SectionHeader label="Your profile" />
      <Card>
        <Text style={[type.caption, styles.help, { color: colors.textSecondary }]}>
          Shown across your workspaces.
        </Text>

        {loading ? (
          <View style={styles.loading} accessibilityRole="progressbar">
            <ActivityIndicator size="small" color={colors.primary} />
            <Text style={[type.caption, { color: colors.textSecondary }]}>Loading profile…</Text>
          </View>
        ) : null}

        {!loading && profile ? (
          <>
            <View style={styles.identityRow}>
              <View
                style={[
                  styles.avatar,
                  {
                    borderColor: colors.border,
                    backgroundColor: normalizedColor || colors.border,
                  },
                ]}
              >
                {previewAvatar ? (
                  <Image
                    source={{ uri: previewAvatar }}
                    accessibilityLabel="Profile avatar preview"
                    style={styles.avatarImage}
                  />
                ) : (
                  <Text style={styles.initials}>{initials(draft)}</Text>
                )}
              </View>
              <View style={styles.identityCopy}>
                <Text style={[type.bodyStrong, { color: colors.text }]} numberOfLines={1}>
                  {draft.displayName.trim() || "Your name"}
                </Text>
                <Text
                  style={[type.caption, styles.previewHandle, { color: colors.textSecondary }]}
                  numberOfLines={1}
                >
                  @{draft.handle.trim() || "handle"}
                </Text>
              </View>
            </View>
            <View style={styles.avatarActions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Paste profile avatar"
                disabled={saving || avatarLoading}
                onPress={() => void pasteAvatar()}
                style={({ pressed }) => [styles.avatarAction, pressed && styles.pressed]}
              >
                <Text style={[type.body, { color: colors.primary }]}>
                  {avatarLoading
                    ? "Reading…"
                    : previewAvatar
                      ? "Replace from clipboard"
                      : "Paste avatar"}
                </Text>
              </Pressable>
              {previewAvatar ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Clear avatar"
                  disabled={saving}
                  onPress={() => {
                    setAvatarDraft(null);
                    setError(null);
                    setSuccess(null);
                  }}
                  style={({ pressed }) => [styles.avatarAction, pressed && styles.pressed]}
                >
                  <Text style={[type.body, { color: colors.danger }]}>Clear</Text>
                </Pressable>
              ) : null}
              {avatarDraft !== undefined ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Undo avatar change"
                  disabled={saving}
                  onPress={() => setAvatarDraft(undefined)}
                  style={({ pressed }) => [styles.avatarAction, pressed && styles.pressed]}
                >
                  <Text style={[type.body, { color: colors.textSecondary }]}>Undo</Text>
                </Pressable>
              ) : null}
            </View>

            <Text style={[styles.fieldLabel, { color: colors.text }]}>Display name</Text>
            <TextInput
              accessibilityLabel="Display name"
              value={draft.displayName}
              editable={!saving}
              maxLength={200}
              autoCapitalize="words"
              returnKeyType="next"
              onChangeText={(displayName) => updateDraft({ displayName })}
              style={[
                styles.input,
                { color: colors.text, borderColor: colors.border, backgroundColor: colors.surfaceSunken },
              ]}
              placeholderTextColor={colors.textSecondary}
            />

            <Text style={[styles.fieldLabel, { color: colors.text }]}>Handle</Text>
            <TextInput
              accessibilityLabel="Handle"
              value={draft.handle}
              editable={!saving}
              maxLength={64}
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={(handle) => updateDraft({ handle })}
              style={[
                styles.input,
                { color: colors.text, borderColor: colors.border, backgroundColor: colors.surfaceSunken },
              ]}
              placeholderTextColor={colors.textSecondary}
            />

            <Text style={[styles.fieldLabel, { color: colors.text }]}>Profile color</Text>
            <View style={styles.colorRow}>
              <View
                accessibilityLabel="Profile color preview"
                style={[
                  styles.colorSwatch,
                  { borderColor: colors.border, backgroundColor: normalizedColor || colors.surface },
                ]}
              />
              <TextInput
                accessibilityLabel="Profile color"
                value={draft.color}
                editable={!saving}
                maxLength={9}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="#4a90d9"
                onChangeText={(color) => updateDraft({ color })}
                style={[
                  styles.input,
                  styles.colorInput,
                  { color: colors.text, borderColor: colors.border, backgroundColor: colors.surfaceSunken },
                ]}
                placeholderTextColor={colors.textSecondary}
              />
            </View>

            {validationError ? (
              <Text accessibilityRole="alert" style={[styles.message, { color: colors.danger }]}>
                {validationError}
              </Text>
            ) : null}

            <Pressable
              testID="profile-save"
              accessibilityRole="button"
              accessibilityLabel="Save profile"
              accessibilityState={{
                disabled: !dirty || Boolean(validationError) || saving,
                busy: saving,
              }}
              disabled={!dirty || Boolean(validationError) || saving}
              onPress={() => void save()}
              style={({ pressed }) => [
                styles.saveButton,
                { backgroundColor: colors.primary },
                (!dirty || Boolean(validationError) || saving) && styles.disabled,
                pressed && styles.pressed,
              ]}
            >
              {saving ? <ActivityIndicator size="small" color={colors.onPrimary} /> : null}
              <Text style={[type.bodyStrong, { color: colors.onPrimary }]}>
                {saving ? "Saving…" : "Save profile"}
              </Text>
            </Pressable>
          </>
        ) : null}

        {error ? (
          <View style={[styles.messageCard, { backgroundColor: colors.dangerSoft }]}>
            <Text accessibilityRole="alert" style={[styles.message, { color: colors.danger }]}>
              {error}
            </Text>
            {!profile && !loading ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Retry loading profile"
                onPress={() => void load()}
              >
                <Text style={[styles.retry, { color: colors.primary }]}>Retry</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {success ? (
          <Text accessibilityRole="summary" style={[styles.message, { color: colors.success }]}>
            {success}
          </Text>
        ) : null}
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  help: {
    marginBottom: spacing.md,
  },
  loading: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  identityRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: spacing.xs,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    borderWidth: 1,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarImage: {
    width: "100%",
    height: "100%",
  },
  initials: {
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "700",
  },
  identityCopy: {
    flex: 1,
    minWidth: 0,
    marginLeft: spacing.md,
  },
  previewHandle: {
    marginTop: 2,
  },
  avatarAction: {
    minHeight: 44,
    minWidth: 52,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  fieldLabel: {
    ...type.caption,
    fontWeight: "600",
    marginBottom: spacing.xs,
  },
  input: {
    minHeight: 46,
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    fontSize: 16,
    marginBottom: spacing.md,
  },
  colorRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  colorSwatch: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    marginBottom: spacing.md,
  },
  colorInput: {
    flex: 1,
  },
  saveButton: {
    minHeight: 46,
    borderRadius: radius.sm,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  disabled: {
    opacity: 0.45,
  },
  pressed: {
    opacity: pressedOpacity,
  },
  messageCard: {
    borderRadius: radius.sm,
    padding: spacing.sm,
    marginTop: spacing.sm,
  },
  message: {
    ...type.caption,
    marginTop: spacing.sm,
  },
  retry: {
    fontSize: 14,
    fontWeight: "700",
    marginTop: spacing.sm,
  },
});
