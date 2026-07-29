import assert from "node:assert/strict";
import test from "node:test";

import { toSlackMrkdwn } from "../src/format.js";

test("toSlackMrkdwn converts **bold** to *bold*", () => {
  assert.equal(toSlackMrkdwn("This is **important**."), "This is *important*.");
});

test("toSlackMrkdwn converts *italic* to _italic_ without eating bold", () => {
  assert.equal(
    toSlackMrkdwn("**bold** and *italic* together"),
    "*bold* and _italic_ together"
  );
});

test("toSlackMrkdwn leaves existing _italic_ alone", () => {
  assert.equal(toSlackMrkdwn("already _italic_ here"), "already _italic_ here");
});

test("toSlackMrkdwn converts [text](url) to <url|text>", () => {
  assert.equal(
    toSlackMrkdwn("See [the docs](https://example.com/docs) for more."),
    "See <https://example.com/docs|the docs> for more."
  );
});

test("toSlackMrkdwn leaves bare URLs untouched (Slack auto-links them)", () => {
  assert.equal(
    toSlackMrkdwn("Visit https://example.com today."),
    "Visit https://example.com today."
  );
});

test("toSlackMrkdwn converts dash bullets to bullet points", () => {
  assert.equal(
    toSlackMrkdwn("Steps:\n- first\n- second\n- third"),
    "Steps:\n• first\n• second\n• third"
  );
});

test("toSlackMrkdwn converts asterisk bullets to bullet points", () => {
  assert.equal(
    toSlackMrkdwn("Items:\n* alpha\n* beta"),
    "Items:\n• alpha\n• beta"
  );
});

test("toSlackMrkdwn preserves nested list indentation", () => {
  assert.equal(
    toSlackMrkdwn("- top\n  - nested\n  - also nested"),
    "• top\n  • nested\n  • also nested"
  );
});

test("toSlackMrkdwn handles partial bold mid-stream as literal", () => {
  // Mid-stream, before closing `**` arrives — passes through unchanged.
  assert.equal(toSlackMrkdwn("This is **bo"), "This is **bo");
});

test("toSlackMrkdwn converts headings to bold", () => {
  assert.equal(
    toSlackMrkdwn("# Title\n\nbody\n\n## Section\n\nmore"),
    "*Title*\n\nbody\n\n*Section*\n\nmore"
  );
});

test("toSlackMrkdwn strips trailing hashes from ATX-closed headings", () => {
  assert.equal(toSlackMrkdwn("## Foo ##"), "*Foo*");
});

test("toSlackMrkdwn handles empty string", () => {
  assert.equal(toSlackMrkdwn(""), "");
});

test("toSlackMrkdwn neutralizes Slack control tokens", () => {
  // Anything in angle brackets is a control token to Slack. Unescaped, a tool
  // row or a quoted message containing <!channel> would make the bot broadcast
  // to the whole channel on an attacker's behalf.
  assert.equal(toSlackMrkdwn("<!channel> look"), "&lt;!channel&gt; look");
  assert.equal(toSlackMrkdwn("<!here> now"), "&lt;!here&gt; now");
  assert.equal(toSlackMrkdwn("ping <@U123456>"), "ping &lt;@U123456&gt;");
  assert.equal(
    toSlackMrkdwn("<!subteam^S123|@team>"),
    "&lt;!subteam^S123|@team&gt;"
  );
});

test("toSlackMrkdwn escapes ampersands and comparisons", () => {
  assert.equal(toSlackMrkdwn("AT&T"), "AT&amp;T");
  assert.equal(
    toSlackMrkdwn("if (x > 3 && y < 5)"),
    "if (x &gt; 3 &amp;&amp; y &lt; 5)"
  );
});

test("toSlackMrkdwn leaves a generated link's URL unescaped", () => {
  // The URL must keep its raw & or the link breaks; the label is escaped.
  assert.equal(
    toSlackMrkdwn("[a & b](https://x.com?p=1&q=2)"),
    "<https://x.com?p=1&q=2|a &amp; b>"
  );
});

test("toSlackMrkdwn does not treat lone asterisks as emphasis", () => {
  // CommonMark flanking rules: emphasis can't open before whitespace or close
  // after it. Without them these were corrupted into underscores.
  assert.equal(toSlackMrkdwn("SELECT * FROM t WHERE a * b"), "SELECT * FROM t WHERE a * b");
  assert.equal(toSlackMrkdwn("match *.log and 3 * 4 = 12"), "match *.log and 3 * 4 = 12");
  // ...while real emphasis still converts.
  assert.equal(toSlackMrkdwn("he said *hi* and 3 * 4"), "he said _hi_ and 3 * 4");
});

test("toSlackMrkdwn does not let a bare dash swallow the next line", () => {
  assert.equal(toSlackMrkdwn("-\nnext line"), "-\nnext line");
  assert.equal(toSlackMrkdwn("- item\n- next"), "• item\n• next");
});

test("toSlackMrkdwn keeps a # that belongs to the heading text", () => {
  assert.equal(toSlackMrkdwn("## Sharp C#"), "*Sharp C#*");
  // The ATX closing run still works when it's whitespace-separated.
  assert.equal(toSlackMrkdwn("## Foo ##"), "*Foo*");
});

test("toSlackMrkdwn leaves control tokens inside code alone", () => {
  // Slack doesn't parse mentions inside code, so escaping there would only
  // corrupt the snippet.
  assert.equal(
    toSlackMrkdwn("```bash\nnpm run check && npm start\n```"),
    "```bash\nnpm run check && npm start\n```"
  );
  assert.equal(toSlackMrkdwn("`a && b`"), "`a && b`");
});

test("toSlackMrkdwn converts ~~strikethrough~~ to Slack's single tilde", () => {
  assert.equal(toSlackMrkdwn("that plan is ~~dead~~ now"), "that plan is ~dead~ now");
});

test("toSlackMrkdwn leaves markdown inside inline code alone", () => {
  assert.equal(
    toSlackMrkdwn("Run `npm i --save-dev` then read `a_b_c` and `x**y`"),
    "Run `npm i --save-dev` then read `a_b_c` and `x**y`"
  );
});

test("toSlackMrkdwn leaves fenced code blocks untouched", () => {
  const input = [
    "Here's the fix:",
    "```js",
    "const area = radius ** 2;",
    "// - this is a comment, not a bullet",
    "// **not bold** and _not italic_",
    "// see [docs](https://example.com)",
    "```",
    "Ship it.",
  ].join("\n");

  assert.equal(toSlackMrkdwn(input), input);
});

test("toSlackMrkdwn still converts markdown outside a fenced block", () => {
  const input = "**Fix:**\n```js\nconst a = b ** 2;\n```\n- deploy it";
  const expected = "*Fix:*\n```js\nconst a = b ** 2;\n```\n• deploy it";

  assert.equal(toSlackMrkdwn(input), expected);
});

test("toSlackMrkdwn protects an unterminated fence mid-stream", () => {
  // Half-streamed code block: the closing fence hasn't arrived yet, so the
  // body must not be rewritten (it would flicker once the fence lands).
  const input = "Here:\n```js\nconst a = b ** 2;\n// - pending";

  assert.equal(toSlackMrkdwn(input), input);
});

test("toSlackMrkdwn handles multiple code spans independently", () => {
  assert.equal(
    toSlackMrkdwn("**a** `x**y` **b** `p_q` **c**"),
    "*a* `x**y` *b* `p_q` *c*"
  );
});

test("toSlackMrkdwn handles a response mixing prose, list, and code", () => {
  const input = [
    "## Deploy steps",
    "",
    "- Set `ANTHROPIC_MODEL` in **Railway**",
    "- Run:",
    "",
    "```bash",
    "npm run check && npm start",
    "```",
    "",
    "Then check [the logs](https://example.com/logs).",
  ].join("\n");

  const expected = [
    "*Deploy steps*",
    "",
    "• Set `ANTHROPIC_MODEL` in *Railway*",
    "• Run:",
    "",
    "```bash",
    "npm run check && npm start",
    "```",
    "",
    "Then check <https://example.com/logs|the logs>.",
  ].join("\n");

  assert.equal(toSlackMrkdwn(input), expected);
});

test("toSlackMrkdwn handles a realistic Claude response", () => {
  const input =
    "Here are the **top results**:\n" +
    "- [Project Alpha](https://example.com/a) — launched 2026-01-15\n" +
    "- [Project Beta](https://example.com/b) — *in progress*\n\n" +
    "Both ship next quarter.";

  const expected =
    "Here are the *top results*:\n" +
    "• <https://example.com/a|Project Alpha> — launched 2026-01-15\n" +
    "• <https://example.com/b|Project Beta> — _in progress_\n\n" +
    "Both ship next quarter.";

  assert.equal(toSlackMrkdwn(input), expected);
});
