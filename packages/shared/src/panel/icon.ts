// A text icon must be one emoji sequence, never an icon name or label.
// Include flags, keycaps, modifiers, joined emoji, and subdivision flag tags.
const emojiPart = String.raw`\p{Extended_Pictographic}\uFE0F?\p{Emoji_Modifier}?(?:[\u{E0020}-\u{E007E}]+\u{E007F})?`;
const semanticEmoji = new RegExp(
  String.raw`^(?:${emojiPart}(?:\u200D${emojiPart})*|\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3)$`,
  "u"
);

export function isSemanticEmoji(icon: string | undefined): icon is string {
  return icon !== undefined && semanticEmoji.test(icon);
}

export const MAX_UNIT_ICON_BYTES = 1024 * 1024;

/** Canonical image declaration, confined to the declaring unit. */
export function isUnitIconAssetPath(icon: string | undefined): icon is string {
  return (
    typeof icon === "string" &&
    icon.startsWith("./") &&
    !/[\\?#%\u0000-\u001f\u007f]/u.test(icon) &&
    icon
      .slice(2)
      .split("/")
      .every((segment) => segment !== "" && segment !== "." && segment !== "..") &&
    /\.(svg|png|jpe?g|webp|avif|gif|ico)$/iu.test(icon)
  );
}
