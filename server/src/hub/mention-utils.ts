/**
 * Shared mention-detection utilities with word-boundary matching.
 *
 * Problem solved: `.includes()` and `.startsWith()` do substring matching,
 * causing false positives like "@Dev1" matching "Dev", "@ally" matching "@all",
 * or "@DevOps" matching "Dev" in BOT-TASK routing.
 *
 * These helpers use regex with word boundaries so only exact mentions match.
 */

/**
 * Escape a string for use in a RegExp constructor.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Check if `text` contains a mention of `name` as a whole word.
 * Matches `@Name` surrounded by word boundaries.
 * Case-insensitive.
 */
export function hasMention(text: string, name: string): boolean {
  const escaped = escapeRegex(name);
  // Require @ to be preceded by start-of-string or non-word char,
  // and the name to be followed by non-word char or end-of-string
  const regex = new RegExp(`(?:^|[^\\w])@${escaped}(?!\\w)`, "i");
  return regex.test(text);
}

/**
 * Check if `text` contains `@all` as a whole word (not part of `@ally` etc.).
 */
export function hasAllMention(text: string): boolean {
  return /(?:^|[^\w])@all(?!\w)/i.test(text);
}

/**
 * Check if `text` contains `@devs` as a whole word.
 */
export function hasDevsMention(text: string): boolean {
  return /(?:^|[^\w])@devs(?!\w)/i.test(text);
}

/**
 * Check if `text` contains `@you` as a whole word.
 */
export function hasYouMention(text: string): boolean {
  return /(?:^|[^\w])@you(?!\w)/i.test(text);
}

/**
 * Check if `text` contains ANY @-prefixed mention (e.g. @BotName, @all, @devs).
 * Used for broadcast detection — if this returns false, the message is a broadcast.
 */
export function hasAnyMention(text: string): boolean {
  return /(?:^|[^\w])@\w+/i.test(text);
}

/**
 * Check if a BOT-TASK content string starts with `@targetName` as a whole word.
 * Returns the message body after the target name if matched, or null.
 */
export function parseBotTaskTarget(
  content: string,
  targetName: string
): string | null {
  if (!content.startsWith("@")) return null;
  const withoutAt = content.slice(1);
  const lowerName = targetName.toLowerCase();
  const lowerContent = withoutAt.toLowerCase();

  if (!lowerContent.startsWith(lowerName)) return null;

  // Ensure the name is followed by a word boundary (space, punctuation, end of string)
  const afterName = lowerContent.slice(lowerName.length);
  if (afterName.length > 0 && /^\w/.test(afterName)) return null;

  const message = withoutAt.slice(targetName.length).trim();
  return message || null;
}
