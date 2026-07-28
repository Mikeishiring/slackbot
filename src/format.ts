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
 *
 * Code spans and fenced blocks are extracted before any conversion runs and
 * restored afterwards, so `**not bold**` inside a snippet stays literal.
 * Slack renders both `inline` and ``` fences natively, so they pass straight
 * through.
 */

/**
 * U+0000 can't appear in Slack message text, which makes it a safe sentinel —
 * unlike a plain-text marker, no tool payload can collide with it. Built with
 * `fromCharCode` rather than an escape so the byte never lands in the source.
 */
const SENTINEL = String.fromCharCode(0);
const BOLD_OPEN = `${SENTINEL}b${SENTINEL}`;
const BOLD_CLOSE = `${SENTINEL}/b${SENTINEL}`;

/**
 * Closed fences first, then an unterminated fence running to end of input —
 * that second branch is what keeps a half-streamed code block from being
 * mangled before its closing fence arrives.
 */
const CODE_PATTERN =
  /```[\s\S]*?```|~~~[\s\S]*?~~~|```[\s\S]*$|~~~[\s\S]*$|``[^`]*``|`[^`\n]*`/g;

export function toSlackMrkdwn(text: string): string {
  if (!text) return text;

  // Drop any incoming sentinel so a payload can't forge a placeholder.
  const { masked, blocks } = maskCode(text.split(SENTINEL).join(""));

  let out = masked;

  out = convertBold(out);
  out = convertItalic(out);
  out = restoreBold(out);

  out = convertStrikethrough(out);
  out = convertLinks(out);
  out = convertBullets(out);
  out = convertHeadings(out);

  return restoreCode(out, blocks);
}

/**
 * Replace every code span and fenced block with an opaque placeholder so the
 * markdown conversions below can't reach inside them.
 */
function maskCode(text: string): { masked: string; blocks: string[] } {
  const blocks: string[] = [];
  const masked = text.replace(CODE_PATTERN, (match) => {
    blocks.push(match);
    return `${SENTINEL}c${blocks.length - 1}${SENTINEL}`;
  });

  return { masked, blocks };
}

function restoreCode(text: string, blocks: string[]): string {
  if (blocks.length === 0) return text;

  return text.replace(
    new RegExp(`${SENTINEL}c(\\d+)${SENTINEL}`, "g"),
    (_match, index: string) => blocks[Number(index)] ?? ""
  );
}

/**
 * Standard `**X**` → placeholder (so we can convert italics next without
 * eating the asterisks we just placed).
 */
function convertBold(text: string): string {
  return text.replace(/\*\*([^*\n]+?)\*\*/g, `${BOLD_OPEN}$1${BOLD_CLOSE}`);
}

/**
 * Remaining `*X*` are italics in standard markdown — Slack uses `_X_`.
 * Also map `_X_` → `_X_` (no-op, but normalizes if Claude mixes styles).
 */
function convertItalic(text: string): string {
  return text.replace(/(^|[\s(])\*([^*\n]+?)\*(?=[\s).,!?:;]|$)/g, "$1_$2_");
}

function restoreBold(text: string): string {
  return text.split(BOLD_OPEN).join("*").split(BOLD_CLOSE).join("*");
}

/**
 * `~~gone~~` → `~gone~`. Slack uses a single tilde for strikethrough.
 */
function convertStrikethrough(text: string): string {
  return text.replace(/~~([^~\n]+?)~~/g, "~$1~");
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
 * Slack has no native headings, and bold-on-its-own-line is the de-facto
 * convention — so `## Foo` becomes `*Foo*` at every level. Level distinction
 * is lost deliberately: the alternatives (blank lines for H1/H2, or stripping
 * `#` and leaving the text plain) either burn vertical space in tight threads
 * or make section titles read as ordinary sentences.
 */
function convertHeadings(text: string): string {
  return text.replace(/^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, "*$1*");
}
