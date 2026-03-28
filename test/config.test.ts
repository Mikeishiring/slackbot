import assert from "node:assert/strict";
import test from "node:test";

import { getConfig } from "../src/config.js";

test("getConfig reads required values and applies defaults", () => {
  const config = getConfig({
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_APP_TOKEN: "xapp-test",
    ANTHROPIC_API_KEY: "sk-ant-test",
  });

  assert.equal(config.slackBotToken, "xoxb-test");
  assert.equal(config.slackAppToken, "xapp-test");
  assert.equal(config.anthropicApiKey, "sk-ant-test");
  assert.equal(config.anthropicModel, "claude-opus-4-20250514");
  assert.equal(config.anthropicRequestTimeoutMs, 15000);
  assert.equal(config.anthropicMaxRetries, 2);
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
