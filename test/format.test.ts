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
