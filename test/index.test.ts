import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { getConfig } from "../src/config.js";
import {
  parseBatchCreateCaseInputsBody,
  runCli,
  startBackgroundWorkerLoop,
} from "../src/index.js";
import { PolicyBotRuntime } from "../src/runtime.js";

test("startBackgroundWorkerLoop polls without overlapping runs and stops cleanly", async () => {
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const logs: string[] = [];

  const stop = startBackgroundWorkerLoop(
    {
      async runWorkerUntilIdle() {
        calls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return calls === 1 ? 2 : 0;
      },
    },
    5,
    {
      log(message: string) {
        logs.push(message);
      },
      error() {
        assert.fail("background worker should not log an error");
      },
    }
  );

  await new Promise((resolve) => setTimeout(resolve, 45));
  stop();
  const callsAtStop = calls;
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.ok(callsAtStop >= 1);
  assert.equal(calls, callsAtStop);
  assert.equal(maxActive, 1);
  assert.ok(logs.some((entry) => /processed 2 job/i.test(entry)));
});

test("startBackgroundWorkerLoop can use multiple workers when available", async () => {
  const workerPrefixes: string[] = [];
  const stop = startBackgroundWorkerLoop(
    {
      async runWorkerUntilIdle() {
        assert.fail("single-worker path should not be used");
      },
      async runWorkersUntilIdle(workerPrefix: string, workerCount: number) {
        workerPrefixes.push(`${workerPrefix}:${workerCount}`);
        return 3;
      },
    },
    5,
    2,
    {
      log() {
        // ignore
      },
      error() {
        assert.fail("background worker should not log an error");
      },
    }
  );

  await new Promise((resolve) => setTimeout(resolve, 20));
  stop();

  assert.ok(workerPrefixes.some((value) => value === "slack-background:2"));
});

test("parseBatchCreateCaseInputsBody supports json arrays and jsonl", () => {
  const fromArray = parseBatchCreateCaseInputsBody(
    JSON.stringify([
      { displayName: "Acme", counterpartyKind: "individual" },
      { displayName: "Beta", counterpartyKind: "entity" },
    ])
  );
  assert.equal(fromArray.length, 2);
  assert.equal(fromArray[0]?.displayName, "Acme");

  const fromJsonl = parseBatchCreateCaseInputsBody(
    [
      JSON.stringify({ displayName: "Acme", counterpartyKind: "individual" }),
      JSON.stringify({ displayName: "Beta", counterpartyKind: "entity" }),
    ].join("\n")
  );
  assert.equal(fromJsonl.length, 2);
  assert.equal(fromJsonl[1]?.displayName, "Beta");
});

test("runCli can create and process a batch file with configurable workers", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "policy-bot-cli-batch-"));
  const batchPath = join(tempRoot, "cases.json");
  writeFileSync(
    batchPath,
    JSON.stringify([
      {
        displayName: "CLI Batch Individual",
        counterpartyKind: "individual",
        website: "https://example.com",
      },
      {
        displayName: "CLI Batch Entity",
        counterpartyKind: "entity",
        legalName: "CLI Batch Entity, Inc.",
        incorporationCountry: "US",
        incorporationState: "DE",
      },
    ]),
    "utf8"
  );

  const config = getConfig({
    POLICY_BOT_RUNTIME: "local",
    POLICY_BOT_POLICY_DIR: join(process.cwd(), "policy"),
    POLICY_BOT_DATA_DIR: tempRoot,
    POLICY_BOT_DB_PATH: join(tempRoot, "bot.sqlite"),
    POLICY_BOT_ARTIFACT_DIR: join(tempRoot, "artifacts"),
    POLICY_BOT_REPORT_DIR: join(tempRoot, "reports"),
    POLICY_BOT_EXPORT_DIR: join(tempRoot, "exports"),
  });
  const runtime = new PolicyBotRuntime(config, {
    captureEnabled: false,
    datasetClient: {
      async loadCurrentDataset() {
        return {
          names: [],
          sourceUrl: "https://example.test/ofac.xml",
          fetchedAt: new Date().toISOString(),
        };
      },
    },
  });
  const logs: string[] = [];

  try {
    await runCli(runtime, config, ["run-batch", batchPath, "2"], {
      log(message: string) {
        logs.push(message);
      },
    });

    assert.equal(runtime.workflow.listCases(10).length, 2);
    assert.ok(logs.some((entry) => /cases created: 2/i.test(entry)));
    assert.ok(logs.some((entry) => /workers: 2/i.test(entry)));
    assert.ok(logs.some((entry) => /CLI Batch Individual/.test(entry)));
    assert.ok(logs.some((entry) => /CLI Batch Entity/.test(entry)));
  } finally {
    runtime.close();
  }
});
