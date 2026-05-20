/**
 * Standard markdown → Slack mrkdwn.
 *
 * Claude emits CommonMark-style markdown. Slack speaks its own dialect
 * ("mrkdwn") — single-asterisk bold, angle-bracket links, no headings.
 * This converter bridges the two so replies render cleanly in Slack.
 *
 * Applied to streamed and final text alike. Safe on partial input:
 * unterminated tokens (e.g. `**bo`) pass through as literals and are
 * re-rendered correctly once the rest of the stream arrives.
 */

const BOLD_PLACEHOLDER_OPEN = "BOLD_OPEN";
const BOLD_PLACEHOLDER_CLOSE = "BOLD_CLOSE";

export function toSlackMrkdwn(text: string): string {
  if (!text) return text;

  let out = text;

  out = convertBold(out);
  out = convertItalic(out);
  out = restoreBold(out);

  out = convertLinks(out);
  out = convertBullets(out);
  out = convertHeadings(out);

  return out;
}

/**
 * Standard `**X**` → placeholder (so we can convert italics next without
 * eating the asterisks we just placed).
 */
function convertBold(text: string): string {
  return text.replace(
    /\*\*([^*\n]+?)\*\*/g,
    `${BOLD_PLACEHOLDER_OPEN}$1${BOLD_PLACEHOLDER_CLOSE}`
  );
}

/**
 * Remaining `*X*` are italics in standard markdown — Slack uses `_X_`.
 * Also map `_X_` → `_X_` (no-op, but normalizes if Claude mixes styles).
 */
function convertItalic(text: string): string {
  return text.replace(/(^|[\s(])\*([^*\n]+?)\*(?=[\s).,!?:;]|$)/g, "$1_$2_");
}

function restoreBold(text: string): string {
  return text
    .split(BOLD_PLACEHOLDER_OPEN)
    .join("*")
    .split(BOLD_PLACEHOLDER_CLOSE)
    .join("*");
}

/**
 * `[label](https://example.com)` → `<https://example.com|label>`.
 * Bare URLs are left alone — Slack auto-linkifies them.
 */
function convertLinks(text: string): string {
  return text.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "<$2|$1>");
}

/**
 * `- item` or `* item` at line start → `• item`.
 * Preserves leading indent so nested lists keep their shape.
 */
function convertBullets(text: string): string {
  return text.replace(/^(\s*)[-*]\s+/gm, "$1• ");
}

/**
 * Slack has no native headings. Decide what to do with `# H1`..`###### H6`.
 *
 * TODO (learning-mode contribution): implement the strategy below.
 *
 * Options to consider:
 *   (a) Convert every heading to bold on its own line: `## Foo` → `*Foo*`.
 *       Simple, predictable, loses level distinction.
 *   (b) Bold + a trailing blank line for top levels (H1/H2) to create
 *       visual separation; just bold for deeper levels.
 *   (c) Drop the `#` characters entirely, leave the text plain.
 *
 * Trade-offs:
 *   - Bold-as-heading is the de-facto Slack convention, but every "section
 *     title" then looks the same weight as inline `*bold*` emphasis.
 *   - Adding blank lines costs vertical space in tight Slack threads.
 *   - Stripping `#` only is the most faithful, but headings lose all
 *     emphasis and can look like ordinary sentences mid-message.
 *
 * Input is a full multi-line block. Operate per-line.
 * Heading regex to use: /^(#{1,6})\s+(.+?)\s*#*\s*$/gm
 *   - $1 is the hash run (length = heading level, 1..6)
 *   - $2 is the heading text
 */
function convertHeadings(text: string): string {
  return text.replace(/^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, "*$1*");
}
