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
 * Two things are masked before any conversion runs and restored afterwards:
 * code (spans and fences), so `**not bold**` inside a snippet stays literal;
 * and the links we generate, so escaping can't mangle a URL.
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

const LINK_PATTERN = /\[([^\]\n]*)\]\((https?:\/\/[^)\s]+)\)/g;

export function toSlackMrkdwn(text: string): string {
  if (!text) return text;

  // Drop any incoming sentinel so a payload can't forge a placeholder.
  const stash: string[] = [];
  let out = mask(text.split(SENTINEL).join(""), CODE_PATTERN, stash);

  // Links are extracted before escaping so the URL keeps its raw `&` and the
  // angle brackets we emit aren't turned into entities.
  out = out.replace(LINK_PATTERN, (_match, label: string, url: string) =>
    store(`<${url}|${escapeSlack(label)}>`, stash)
  );

  out = escapeSlack(out);

  out = convertBold(out);
  out = convertItalic(out);
  out = restoreBold(out);

  out = convertStrikethrough(out);
  out = convertBullets(out);
  out = convertHeadings(out);

  return restore(out, stash);
}

/**
 * Slack parses anything in angle brackets as a control token, so unescaped
 * text can produce live mentions. A tool row or a quoted message containing
 * `<!channel>` would otherwise make the bot broadcast to everyone on an
 * attacker's behalf. Escaping is also what makes `AT&T` and `x < y` render.
 *
 * Only these three, per Slack's spec — escaping more would show up literally.
 */
function escapeSlack(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function store(value: string, stash: string[]): string {
  stash.push(value);
  return `${SENTINEL}${stash.length - 1}${SENTINEL}`;
}

function mask(text: string, pattern: RegExp, stash: string[]): string {
  return text.replace(pattern, (match) => store(match, stash));
}

/**
 * Restores masked spans verbatim — code is deliberately NOT escaped.
 *
 * Slack does not parse mentions or links inside code, so the injection risk
 * that motivates escaping doesn't exist there. Escaping anyway would render
 * a shell snippet as `npm run check &amp;&amp; start` if Slack doesn't decode
 * entities in code blocks, which is a visible regression for zero gain. Left
 * raw, code round-trips exactly as it does today.
 */
function restore(text: string, stash: string[]): string {
  if (stash.length === 0) return text;

  return text.replace(
    new RegExp(`${SENTINEL}(\\d+)${SENTINEL}`, "g"),
    (_match, index: string) => stash[Number(index)] ?? ""
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
 *
 * The flanking rules matter: CommonMark only opens emphasis on a `*` followed
 * by non-space, and only closes on one preceded by non-space. Without them
 * `SELECT * FROM t WHERE a * b` became `SELECT _ FROM t WHERE a _ b`, and
 * `match *.log and 3 * 4` was corrupted the same way.
 */
function convertItalic(text: string): string {
  return text.replace(
    /(^|[\s(])\*(?![\s*])([^*\n]+?)(?<![\s*])\*(?=[\s).,!?:;]|$)/g,
    "$1_$2_"
  );
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
 * `- item` or `* item` at line start → `• item`.
 * Preserves leading indent so nested lists keep their shape.
 *
 * The separator is same-line whitespace only: `\s+` let a bare `-` on its own
 * line swallow the newline and pull the following line up into the bullet.
 */
function convertBullets(text: string): string {
  return text.replace(/^([ \t]*)[-*][ \t]+/gm, "$1• ");
}

/**
 * Slack has no native headings, and bold-on-its-own-line is the de-facto
 * convention — so `## Foo` becomes `*Foo*` at every level. Level distinction
 * is lost deliberately: the alternatives (blank lines for H1/H2, or stripping
 * `#` and leaving the text plain) either burn vertical space in tight threads
 * or make section titles read as ordinary sentences.
 *
 * The optional closing run must be whitespace-separated, or `## Sharp C#`
 * loses the `#` that belongs to the word.
 */
function convertHeadings(text: string): string {
  return text.replace(/^#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/gm, "*$1*");
}
