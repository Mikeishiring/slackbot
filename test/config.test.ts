import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_ANTHROPIC_EFFORT,
  DEFAULT_ANTHROPIC_MAX_RETRIES,
  DEFAULT_ANTHROPIC_MAX_TOKENS,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_ANTHROPIC_REQUEST_TIMEOUT_MS,
  getConfig,
} from "../src/config.js";

const REQUIRED_ENV = {
  SLACK_BOT_TOKEN: "xoxb-test",
  SLACK_APP_TOKEN: "xapp-test",
  ANTHROPIC_API_KEY: "sk-ant-test",
};

test("getConfig reads required values and applies defaults", () => {
  const config = getConfig({ ...REQUIRED_ENV });

  assert.equal(config.slackBotToken, "xoxb-test");
  assert.equal(config.slackAppToken, "xapp-test");
  assert.equal(config.anthropicApiKey, "sk-ant-test");
  // Assert against the exported defaults so bumping one can't silently
  // desync this test from src/config.ts.
  assert.equal(config.anthropicModel, DEFAULT_ANTHROPIC_MODEL);
  assert.equal(
    config.anthropicRequestTimeoutMs,
    DEFAULT_ANTHROPIC_REQUEST_TIMEOUT_MS
  );
  assert.equal(config.anthropicMaxRetries, DEFAULT_ANTHROPIC_MAX_RETRIES);
  assert.equal(config.anthropicMaxTokens, DEFAULT_ANTHROPIC_MAX_TOKENS);
  assert.equal(config.anthropicEffort, DEFAULT_ANTHROPIC_EFFORT);
});

test("getConfig reads max tokens and effort overrides", () => {
  const config = getConfig({
    ...REQUIRED_ENV,
    ANTHROPIC_MAX_TOKENS: "32000",
    ANTHROPIC_EFFORT: "XHIGH",
  });

  assert.equal(config.anthropicMaxTokens, 32_000);
  assert.equal(config.anthropicEffort, "xhigh");
});

test("getConfig omits the prompt append unless it is set", () => {
  const bare = getConfig({ ...REQUIRED_ENV });
  assert.equal(bare.anthropicSystemPromptAppend, undefined);
  assert.ok(
    !("anthropicSystemPromptAppend" in bare),
    "absent should mean absent, not an undefined key"
  );

  const withAppend = getConfig({
    ...REQUIRED_ENV,
    ANTHROPIC_SYSTEM_PROMPT_APPEND: "  You support the Acme billing team.  ",
  });
  assert.equal(
    withAppend.anthropicSystemPromptAppend,
    "You support the Acme billing team."
  );

  // Whitespace-only is treated as unset.
  const blank = getConfig({ ...REQUIRED_ENV, ANTHROPIC_SYSTEM_PROMPT_APPEND: "   " });
  assert.equal(blank.anthropicSystemPromptAppend, undefined);
});

test("getConfig rejects an unknown effort level", () => {
  assert.throws(
    () => getConfig({ ...REQUIRED_ENV, ANTHROPIC_EFFORT: "turbo" }),
    /ANTHROPIC_EFFORT must be one of/
  );
});

test("getConfig parses the channel allowlist and omits it when empty", () => {
  const withList = getConfig({
    ...REQUIRED_ENV,
    SLACK_ALLOWED_CHANNELS: " C123 , C456 ,, ",
  });
  assert.deepEqual([...(withList.slackAllowedChannels ?? [])], ["C123", "C456"]);

  const withoutList = getConfig({ ...REQUIRED_ENV, SLACK_ALLOWED_CHANNELS: " , " });
  assert.equal(withoutList.slackAllowedChannels, undefined);
});

test("getConfig fails fast when required environment variables are missing", () => {
  assert.throws(
    () =>
      getConfig({
        SLACK_BOT_TOKEN: "xoxb-test",
        ANTHROPIC_API_KEY: "sk-ant-test",
      }),
    /SLACK_APP_TOKEN/
  );
});

test("getConfig rejects invalid numeric overrides", () => {
  assert.throws(
    () =>
      getConfig({
        SLACK_BOT_TOKEN: "xoxb-test",
        SLACK_APP_TOKEN: "xapp-test",
        ANTHROPIC_API_KEY: "sk-ant-test",
        ANTHROPIC_MAX_RETRIES: "0",
      }),
    /ANTHROPIC_MAX_RETRIES must be a positive integer/
  );
});

test("getConfig still accepts the legacy max-attempts variable", () => {
  const config = getConfig({
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_APP_TOKEN: "xapp-test",
    ANTHROPIC_API_KEY: "sk-ant-test",
    ANTHROPIC_MAX_ATTEMPTS: "3",
  });

  assert.equal(config.anthropicMaxRetries, 3);
});

test("ANTHROPIC_MAX_RETRIES takes precedence over the legacy variable", () => {
  const config = getConfig({
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_APP_TOKEN: "xapp-test",
    ANTHROPIC_API_KEY: "sk-ant-test",
    ANTHROPIC_MAX_ATTEMPTS: "3",
    ANTHROPIC_MAX_RETRIES: "4",
  });

  assert.equal(config.anthropicMaxRetries, 4);
});

test("the legacy max-attempts variable still validates as a positive integer", () => {
  assert.throws(
    () =>
      getConfig({
        SLACK_BOT_TOKEN: "xoxb-test",
        SLACK_APP_TOKEN: "xapp-test",
        ANTHROPIC_API_KEY: "sk-ant-test",
        ANTHROPIC_MAX_ATTEMPTS: "0",
      }),
    /ANTHROPIC_MAX_ATTEMPTS must be a positive integer/
  );
});
