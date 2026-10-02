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
