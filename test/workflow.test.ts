import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { getConfig } from "../src/config.js";
import { PolicyBotRuntime } from "../src/runtime.js";

const policyDirectory = join(process.cwd(), "policy");

test("entity workflow verifies good standing, opens review tasks, and approves after review clears", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "policy-bot-workflow-"));
  const server = await startServer(
    "<html><body><h1>Acme Labs LLC</h1><p>Status: Active</p></body></html>"
  );
  const runtime = new PolicyBotRuntime(
    getConfig({
      POLICY_BOT_RUNTIME: "local",
      POLICY_BOT_POLICY_DIR: policyDirectory,
      POLICY_BOT_DB_PATH: join(tempRoot, "bot.sqlite"),
      POLICY_BOT_ARTIFACT_DIR: join(tempRoot, "artifacts"),
      POLICY_BOT_REPORT_DIR: join(tempRoot, "reports"),
    }),
    {
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
    }
  );

  try {
    const createResponse = await runtime.handleSlackRequest({
      text: `create case ${JSON.stringify({
        displayName: "Acme Labs",
        counterpartyKind: "entity",
        incorporationCountry: "US",
        incorporationState: "DE",
        registrySearchUrl: server.url,
      })}`,
      channelId: "C1",
      threadTs: "100.000",
      messageTs: "100.001",
      actorId: "U1",
      actorLabel: "U1",
      threadHistory: [],
    }, runtime.createCommandResponder());

    const caseId = /Case ID:\s+(\S+)/.exec(createResponse)?.[1];
    assert.ok(caseId);

    const processed = await runtime.runWorkerUntilIdle("test-worker");
    assert.ok(processed >= 4);

    let snapshot = runtime.workflow.getCaseSnapshot(caseId!);
    assert.equal(snapshot.caseRecord.caseStatus, "awaiting_review");
    assert.equal(snapshot.caseRecord.recommendation, "manual_review");
    assert.ok(
      snapshot.facts.some(
        (fact) =>
          fact.factKey === "good_standing_status" &&
          fact.verificationStatus === "verified"
      )
    );
    assert.equal(
      snapshot.reviewTasks.filter((task) => task.status === "open").length,
      3
    );
    assert.equal(snapshot.reports.length, 4);
    assert.ok(snapshot.reports.some((report) => report.kind === "traceability"));

    for (const task of snapshot.reviewTasks.filter((item) => item.status === "open")) {
      snapshot = await runtime.workflow.resolveReviewTask(
        task.id,
        "clear",
        "Reviewed and cleared."
      );
    }

    assert.equal(snapshot.caseRecord.caseStatus, "completed");
    assert.equal(snapshot.caseRecord.recommendation, "approved");
  } finally {
    runtime.close();
    await server.close();
  }
});

test("explicit negative good-standing verification terminates the case", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "policy-bot-fail-"));
  const server = await startServer(
    "<html><body><h1>Acme Labs LLC</h1><p>Status: Not found</p></body></html>"
  );
  const runtime = new PolicyBotRuntime(
    getConfig({
      POLICY_BOT_RUNTIME: "local",
      POLICY_BOT_POLICY_DIR: policyDirectory,
      POLICY_BOT_DB_PATH: join(tempRoot, "bot.sqlite"),
      POLICY_BOT_ARTIFACT_DIR: join(tempRoot, "artifacts"),
      POLICY_BOT_REPORT_DIR: join(tempRoot, "reports"),
    }),
    {
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
    }
  );

  try {
    const snapshot = await runtime.workflow.createCase({
      displayName: "Blocked Entity",
      counterpartyKind: "entity",
      legalName: null,
      incorporationCountry: "US",
      incorporationState: "DE",
      website: null,
      registrySearchUrl: server.url,
      publicListingUrl: null,
      exchangeName: null,
      stockSymbol: null,
      requestedBy: "tester",
      notes: null,
      slackChannelId: null,
      slackThreadTs: null,
    });

    await runtime.runWorkerUntilIdle("test-worker");
    const finalSnapshot = runtime.workflow.getCaseSnapshot(snapshot.caseRecord.id);
    assert.equal(finalSnapshot.caseRecord.recommendation, "terminate");
    assert.equal(finalSnapshot.caseRecord.caseStatus, "terminated");
    assert.ok(
      finalSnapshot.issues.some((issue) =>
        /good standing not verified/i.test(issue.title)
      )
    );
  } finally {
    runtime.close();
    await server.close();
  }
});

test("inactive registry status does not pass as active", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "policy-bot-inactive-"));
  const server = await startServer(
    "<html><body><h1>Example Entity</h1><p>Company status: Inactive</p></body></html>"
  );
  const runtime = new PolicyBotRuntime(
    getConfig({
      POLICY_BOT_RUNTIME: "local",
      POLICY_BOT_POLICY_DIR: policyDirectory,
      POLICY_BOT_DB_PATH: join(tempRoot, "bot.sqlite"),
      POLICY_BOT_ARTIFACT_DIR: join(tempRoot, "artifacts"),
      POLICY_BOT_REPORT_DIR: join(tempRoot, "reports"),
    }),
    {
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
    }
  );

  try {
    const snapshot = await runtime.workflow.createCase({
      displayName: "Inactive Entity",
      counterpartyKind: "entity",
      legalName: null,
      incorporationCountry: "US",
      incorporationState: "DE",
      website: null,
      registrySearchUrl: server.url,
      publicListingUrl: null,
      exchangeName: null,
      stockSymbol: null,
      requestedBy: "tester",
      notes: null,
      slackChannelId: null,
      slackThreadTs: null,
    });

    await runtime.runWorkerUntilIdle("test-worker");
    const finalSnapshot = runtime.workflow.getCaseSnapshot(snapshot.caseRecord.id);
    assert.equal(finalSnapshot.caseRecord.recommendation, "terminate");
    assert.ok(
      finalSnapshot.issues.some((issue) =>
        /inactive/i.test(issue.detail)
      )
    );
  } finally {
    runtime.close();
    await server.close();
  }
});

test("uk entity can resolve an official Companies House detail page from search results", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "policy-bot-uk-resolution-"));
  const runtime = new PolicyBotRuntime(
    getConfig({
      POLICY_BOT_RUNTIME: "local",
      POLICY_BOT_POLICY_DIR: policyDirectory,
      POLICY_BOT_DB_PATH: join(tempRoot, "bot.sqlite"),
      POLICY_BOT_ARTIFACT_DIR: join(tempRoot, "artifacts"),
      POLICY_BOT_REPORT_DIR: join(tempRoot, "reports"),
    }),
    {
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
    }
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (
      request.url ===
      "https://find-and-update.company-information.service.gov.uk/search/companies?q=ACME%20LABS%20LTD"
    ) {
      return new Response(
        [
          "<html><body><ul id='results'>",
          '<li class="type-company"><h3><a class="govuk-link" href="/company/12345678">ACME LABS LTD</a></h3></li>',
          "</ul></body></html>",
        ].join(""),
        {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }
      );
    }

    if (
      request.url ===
      "https://find-and-update.company-information.service.gov.uk/company/12345678"
    ) {
      return new Response(
        "<html><body><h1>ACME LABS LTD</h1><p>Company status Active</p></body></html>",
        {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }
      );
    }

    return originalFetch(input, init);
  };

  try {
    const snapshot = await runtime.workflow.createCase({
      displayName: "Acme Labs",
      counterpartyKind: "entity",
      legalName: "ACME LABS LTD",
      incorporationCountry: "United Kingdom",
      incorporationState: null,
      website: null,
      registrySearchUrl: null,
      publicListingUrl: null,
      exchangeName: null,
      stockSymbol: null,
      requestedBy: "tester",
      notes: null,
      slackChannelId: null,
      slackThreadTs: null,
    });

    let finalSnapshot = await runtime.workflow.runStep(
      snapshot.caseRecord.id,
      "entity_resolution"
    );
    assert.equal(
      finalSnapshot.steps.find((step) => step.stepKey === "entity_resolution")?.status,
      "passed"
    );

    finalSnapshot = await runtime.workflow.runStep(
      snapshot.caseRecord.id,
      "good_standing"
    );
    assert.equal(
      finalSnapshot.steps.find((step) => step.stepKey === "good_standing")?.status,
      "manual_review_required"
    );
    assert.ok(
      finalSnapshot.facts.some((fact) => fact.factKey === "official_registry_url_resolved")
    );
    assert.ok(
      finalSnapshot.facts.some((fact) => fact.factKey === "good_standing_status")
    );
  } finally {
    globalThis.fetch = originalFetch;
    runtime.close();
  }
});

test("known legal name and jurisdiction establish official registry routing without a direct result url", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "policy-bot-registry-routing-"));
  const runtime = new PolicyBotRuntime(
    getConfig({
      POLICY_BOT_RUNTIME: "local",
      POLICY_BOT_POLICY_DIR: policyDirectory,
      POLICY_BOT_DB_PATH: join(tempRoot, "bot.sqlite"),
      POLICY_BOT_ARTIFACT_DIR: join(tempRoot, "artifacts"),
      POLICY_BOT_REPORT_DIR: join(tempRoot, "reports"),
    }),
    {
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
    }
  );

  try {
    const snapshot = await runtime.workflow.createCase({
      displayName: "Routing Check",
      counterpartyKind: "entity",
      legalName: "Routing Check, Inc.",
      incorporationCountry: "US",
      incorporationState: "DE",
      website: null,
      registrySearchUrl: null,
      publicListingUrl: null,
      exchangeName: null,
      stockSymbol: null,
      requestedBy: "tester",
      notes: null,
      slackChannelId: null,
      slackThreadTs: null,
    });

    const finalSnapshot = await runtime.workflow.runStep(
      snapshot.caseRecord.id,
      "entity_resolution"
    );
    assert.equal(
      finalSnapshot.steps.find((step) => step.stepKey === "entity_resolution")?.status,
      "passed"
    );
    assert.equal(finalSnapshot.caseRecord.caseStatus, "in_progress");
    assert.equal(finalSnapshot.caseRecord.registrySearchUrl, "https://icis.corp.delaware.gov/Ecorp/EntitySearch/NameSearch.aspx");
    assert.ok(
      finalSnapshot.facts.some((fact) =>
        fact.factKey === "official_registry_path_established"
      )
    );

    const routingArtifact = finalSnapshot.artifacts.find(
      (artifact) => artifact.title === "Entity Resolution Routing Summary"
    );
    assert.ok(routingArtifact);
    const routingBody = await readFile(
      runtime.artifactStore.resolveAbsolutePath(routingArtifact!),
      "utf8"
    );
    assert.match(routingBody, /Delaware entity name search/);
    assert.match(routingBody, /Delaware corporate status online/);
    assert.match(routingBody, /corp\.delaware\.gov\/directweb/i);

    const goodStandingSnapshot = await runtime.workflow.runStep(
      snapshot.caseRecord.id,
      "good_standing"
    );
    assert.equal(
      goodStandingSnapshot.steps.find((step) => step.stepKey === "good_standing")?.status,
      "manual_review_required"
    );
    assert.ok(
      goodStandingSnapshot.reviewTasks.some((task) =>
        /good-standing check/i.test(task.title)
      )
    );
  } finally {
    runtime.close();
  }
});

test("repeat entity case reuses fresh official checks from a prior case", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "policy-bot-reuse-"));
  const server = await startServer(
    "<html><body><h1>Repeat Entity LLC</h1><p>Status: Active</p></body></html>"
  );
  const runtime = new PolicyBotRuntime(
    getConfig({
      POLICY_BOT_RUNTIME: "local",
      POLICY_BOT_POLICY_DIR: policyDirectory,
      POLICY_BOT_DB_PATH: join(tempRoot, "bot.sqlite"),
      POLICY_BOT_ARTIFACT_DIR: join(tempRoot, "artifacts"),
      POLICY_BOT_REPORT_DIR: join(tempRoot, "reports"),
    }),
    {
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
    }
  );

  try {
    const firstCase = await runtime.workflow.createCase({
      displayName: "Repeat Entity",
      counterpartyKind: "entity",
      legalName: "Repeat Entity LLC",
      incorporationCountry: "US",
      incorporationState: "DE",
      website: null,
      registrySearchUrl: server.url,
      publicListingUrl: null,
      exchangeName: null,
      stockSymbol: null,
      requestedBy: "tester",
      notes: null,
      slackChannelId: null,
      slackThreadTs: null,
    });
    await runtime.runWorkerUntilIdle("test-worker");

    const secondCase = await runtime.workflow.createCase({
      displayName: "Repeat Entity",
      counterpartyKind: "entity",
      legalName: null,
      incorporationCountry: "US",
      incorporationState: "DE",
      website: null,
      registrySearchUrl: null,
      publicListingUrl: null,
      exchangeName: null,
      stockSymbol: null,
      requestedBy: "tester",
      notes: null,
      slackChannelId: null,
      slackThreadTs: null,
    });
    await runtime.runWorkerUntilIdle("test-worker");

    const finalSnapshot = runtime.workflow.getCaseSnapshot(secondCase.caseRecord.id);
    assert.equal(
      finalSnapshot.steps.find((step) => step.stepKey === "good_standing")?.status,
      "manual_review_required"
    );
    assert.equal(
      finalSnapshot.steps.find((step) => step.stepKey === "ofac_precheck")?.status,
      "passed"
    );
    assert.equal(
      finalSnapshot.steps.find((step) => step.stepKey === "ofac_search")?.status,
      "passed"
    );
    assert.ok(
      finalSnapshot.facts.some((fact) =>
        /official registry url from a prior case/i.test(fact.summary)
      )
    );
    assert.ok(
      finalSnapshot.facts.some((fact) =>
        /reused fresh ofac dataset precheck/i.test(fact.summary)
      )
    );
    assert.ok(
      finalSnapshot.facts.some((fact) =>
        /reused fresh official ofac search result/i.test(fact.summary)
      )
    );
    assert.equal(
      finalSnapshot.reviewTasks.filter((task) => task.status === "open").length,
      3
    );

    void firstCase;
  } finally {
    runtime.close();
    await server.close();
  }
});

test("missing jurisdiction still blocks entity resolution when official registry routing cannot be established", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "policy-bot-registry-blocker-"));
  const runtime = new PolicyBotRuntime(
    getConfig({
      POLICY_BOT_RUNTIME: "local",
      POLICY_BOT_POLICY_DIR: policyDirectory,
      POLICY_BOT_DB_PATH: join(tempRoot, "bot.sqlite"),
      POLICY_BOT_ARTIFACT_DIR: join(tempRoot, "artifacts"),
      POLICY_BOT_REPORT_DIR: join(tempRoot, "reports"),
    }),
    {
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
    }
  );

  try {
    const snapshot = await runtime.workflow.createCase({
      displayName: "Guidance Check",
      counterpartyKind: "entity",
      legalName: "Guidance Check, Inc.",
      incorporationCountry: null,
      incorporationState: null,
      website: null,
      registrySearchUrl: null,
      publicListingUrl: null,
      exchangeName: null,
      stockSymbol: null,
      requestedBy: "tester",
      notes: null,
      slackChannelId: null,
      slackThreadTs: null,
    });

    const finalSnapshot = await runtime.workflow.runStep(
      snapshot.caseRecord.id,
      "entity_resolution"
    );
    assert.equal(
      finalSnapshot.steps.find((step) => step.stepKey === "entity_resolution")?.status,
      "blocked"
    );
    assert.equal(finalSnapshot.caseRecord.caseStatus, "blocked");
    assert.equal(finalSnapshot.caseRecord.recommendation, "blocked");
  } finally {
    runtime.close();
  }
});

test("known official source hints can resolve Uniswap Labs into Delaware registry routing", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "policy-bot-uniswap-routing-"));
  const runtime = new PolicyBotRuntime(
    getConfig({
      POLICY_BOT_RUNTIME: "local",
      POLICY_BOT_POLICY_DIR: policyDirectory,
      POLICY_BOT_DB_PATH: join(tempRoot, "bot.sqlite"),
      POLICY_BOT_ARTIFACT_DIR: join(tempRoot, "artifacts"),
      POLICY_BOT_REPORT_DIR: join(tempRoot, "reports"),
    }),
    {
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
    }
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (
      request.url ===
      "https://support.uniswap.org/hc/en-us/articles/43018872248589-API-Terms-of-Use"
    ) {
      return new Response(
        "<html><head><title>API Terms of Use – Uniswap Labs</title></head><body>These Uniswap Labs API Terms of Use describe your rights and obligations when accessing certain application programming interfaces made available by Universal Navigation, Inc. dba “Uniswap Labs”, a Delaware corporation.</body></html>",
        {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }
      );
    }

    return originalFetch(input, init);
  };

  try {
    const snapshot = await runtime.workflow.createCase({
      displayName: "Uniswap Labs",
      counterpartyKind: "entity",
      legalName: null,
      incorporationCountry: null,
      incorporationState: null,
      website: "https://uniswap.org",
      registrySearchUrl: null,
      publicListingUrl: null,
      exchangeName: null,
      stockSymbol: null,
      requestedBy: "tester",
      notes: null,
      slackChannelId: null,
      slackThreadTs: null,
    });

    const finalSnapshot = await runtime.workflow.runStep(
      snapshot.caseRecord.id,
      "entity_resolution"
    );
    assert.equal(
      finalSnapshot.steps.find((step) => step.stepKey === "entity_resolution")?.status,
      "passed"
    );
    assert.equal(finalSnapshot.caseRecord.legalName, "Universal Navigation, Inc.");
    assert.equal(finalSnapshot.caseRecord.incorporationCountry, "US");
    assert.equal(finalSnapshot.caseRecord.incorporationState, "DE");
    assert.equal(finalSnapshot.caseRecord.registrySearchUrl, "https://icis.corp.delaware.gov/Ecorp/EntitySearch/NameSearch.aspx");
  } finally {
    globalThis.fetch = originalFetch;
    runtime.close();
  }
});

test("known official source hints can resolve Flashbots into Cayman registry routing", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "policy-bot-flashbots-routing-"));
  const runtime = new PolicyBotRuntime(
    getConfig({
      POLICY_BOT_RUNTIME: "local",
      POLICY_BOT_POLICY_DIR: policyDirectory,
      POLICY_BOT_DB_PATH: join(tempRoot, "bot.sqlite"),
      POLICY_BOT_ARTIFACT_DIR: join(tempRoot, "artifacts"),
      POLICY_BOT_REPORT_DIR: join(tempRoot, "reports"),
    }),
    {
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
    }
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url === "https://docs.flashbots.net/policies/terms-of-service") {
      return new Response(
        "<html><head><title>Terms of Service | Flashbots Docs</title></head><body><h1>Terms of Service</h1><p>Flashbots Ltd.</p><p>BY ACCESSING ANY SERVICES PROVIDED BY FLASHBOTS LTD.</p></body></html>",
        {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }
      );
    }

    return originalFetch(input, init);
  };

  try {
    const snapshot = await runtime.workflow.createCase({
      displayName: "Flashbots",
      counterpartyKind: "entity",
      legalName: null,
      incorporationCountry: null,
      incorporationState: null,
      website: "https://www.flashbots.net",
      registrySearchUrl: null,
      publicListingUrl: null,
      exchangeName: null,
      stockSymbol: null,
      requestedBy: "tester",
      notes: null,
      slackChannelId: null,
      slackThreadTs: null,
    });

    const finalSnapshot = await runtime.workflow.runStep(
      snapshot.caseRecord.id,
      "entity_resolution"
    );
    assert.equal(
      finalSnapshot.steps.find((step) => step.stepKey === "entity_resolution")?.status,
      "passed"
    );
    assert.equal(finalSnapshot.caseRecord.legalName, "Flashbots Ltd.");
    assert.equal(finalSnapshot.caseRecord.incorporationCountry, "Cayman Islands");
    assert.equal(finalSnapshot.caseRecord.registrySearchUrl, "https://online.ciregistry.gov.ky/");
  } finally {
    globalThis.fetch = originalFetch;
    runtime.close();
  }
});

test("known official source hints can resolve Offchain Labs into Delaware registry routing", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "policy-bot-offchain-routing-"));
  const runtime = new PolicyBotRuntime(
    getConfig({
      POLICY_BOT_RUNTIME: "local",
      POLICY_BOT_POLICY_DIR: policyDirectory,
      POLICY_BOT_DB_PATH: join(tempRoot, "bot.sqlite"),
      POLICY_BOT_ARTIFACT_DIR: join(tempRoot, "artifacts"),
      POLICY_BOT_REPORT_DIR: join(tempRoot, "reports"),
    }),
    {
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
    }
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url === "https://arbitrum.io/tos") {
      return new Response(
        "<html><head><title>Terms of Service – Arbitrum</title></head><body>These Terms of Service serve as an agreement between you and Offchain Labs, Inc. (“Offchain Labs”, “we”, “us”, “our”). Digital Assets are not subject to protections or insurance provided by the Federal Deposit Insurance Corporation.</body></html>",
        {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }
      );
    }

    return originalFetch(input, init);
  };

  try {
    const snapshot = await runtime.workflow.createCase({
      displayName: "Offchain Labs",
      counterpartyKind: "entity",
      legalName: null,
      incorporationCountry: null,
      incorporationState: null,
      website: "https://offchainlabs.com",
      registrySearchUrl: null,
      publicListingUrl: null,
      exchangeName: null,
      stockSymbol: null,
      requestedBy: "tester",
      notes: null,
      slackChannelId: null,
      slackThreadTs: null,
    });

    const finalSnapshot = await runtime.workflow.runStep(
      snapshot.caseRecord.id,
      "entity_resolution"
    );
    assert.equal(
      finalSnapshot.steps.find((step) => step.stepKey === "entity_resolution")?.status,
      "passed"
    );
    assert.equal(finalSnapshot.caseRecord.legalName, "Offchain Labs, Inc.");
    assert.equal(finalSnapshot.caseRecord.incorporationCountry, "US");
    assert.equal(finalSnapshot.caseRecord.incorporationState, "DE");
    assert.equal(finalSnapshot.caseRecord.registrySearchUrl, "https://icis.corp.delaware.gov/Ecorp/EntitySearch/NameSearch.aspx");
  } finally {
    globalThis.fetch = originalFetch;
    runtime.close();
  }
});

test("known entity curated routing fallback avoids blocking on a stalled hint page", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "policy-bot-curated-fallback-"));
  const runtime = new PolicyBotRuntime(
    getConfig({
      POLICY_BOT_RUNTIME: "local",
      POLICY_BOT_POLICY_DIR: policyDirectory,
      POLICY_BOT_DATA_DIR: tempRoot,
      POLICY_BOT_DB_PATH: join(tempRoot, "bot.sqlite"),
      POLICY_BOT_ARTIFACT_DIR: join(tempRoot, "artifacts"),
      POLICY_BOT_REPORT_DIR: join(tempRoot, "reports"),
      POLICY_BOT_ENTITY_EVIDENCE_CACHE_DIR: join(tempRoot, "entity-cache"),
      POLICY_BOT_ENTITY_EVIDENCE_LOAD_TIMEOUT_MS: "5",
    }),
    {
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
    }
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url === "https://arbitrum.io/tos") {
      return await new Promise<Response>(() => undefined);
    }

    return originalFetch(input, init);
  };

  try {
    const snapshot = await runtime.workflow.createCase({
      displayName: "Offchain Labs",
      counterpartyKind: "entity",
      legalName: null,
      incorporationCountry: null,
      incorporationState: null,
      website: "https://offchainlabs.com",
      registrySearchUrl: null,
      publicListingUrl: null,
      exchangeName: null,
      stockSymbol: null,
      requestedBy: "tester",
      notes: null,
      slackChannelId: null,
      slackThreadTs: null,
    });

    const finalSnapshot = await runtime.workflow.runStep(
      snapshot.caseRecord.id,
      "entity_resolution"
    );

    assert.equal(
      finalSnapshot.steps.find((step) => step.stepKey === "entity_resolution")?.status,
      "passed"
    );
    assert.equal(finalSnapshot.caseRecord.legalName, "Offchain Labs, Inc.");
    assert.equal(finalSnapshot.caseRecord.incorporationCountry, "US");
    assert.equal(finalSnapshot.caseRecord.incorporationState, "DE");
    assert.ok(
      finalSnapshot.issues.some((issue) =>
        /fallback used/i.test(issue.title)
      )
    );
  } finally {
    globalThis.fetch = originalFetch;
    runtime.close();
  }
});

test("website heuristics do not infer junk legal names from generic terms language", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "policy-bot-website-inference-"));
  const runtime = new PolicyBotRuntime(
    getConfig({
      POLICY_BOT_RUNTIME: "local",
      POLICY_BOT_POLICY_DIR: policyDirectory,
      POLICY_BOT_DB_PATH: join(tempRoot, "bot.sqlite"),
      POLICY_BOT_ARTIFACT_DIR: join(tempRoot, "artifacts"),
      POLICY_BOT_REPORT_DIR: join(tempRoot, "reports"),
    }),
    {
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
    }
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (
      request.url === "https://optimism.test/" ||
      request.url === "https://optimism.test/terms"
    ) {
      return new Response(
        "<html><body><p>The Foundation provides these services.</p><p>Your agreement forms a binding contract between you and us.</p><p>You must comply with all applicable sanctions Laws.</p></body></html>",
        {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }
      );
    }

    return new Response("", { status: 404 });
  };

  try {
    const snapshot = await runtime.workflow.createCase({
      displayName: "Optimism Style Case",
      counterpartyKind: "entity",
      legalName: null,
      incorporationCountry: null,
      incorporationState: null,
      website: "https://optimism.test",
      registrySearchUrl: null,
      publicListingUrl: null,
      exchangeName: null,
      stockSymbol: null,
      requestedBy: "tester",
      notes: null,
      slackChannelId: null,
      slackThreadTs: null,
    });

    const finalSnapshot = await runtime.workflow.runStep(
      snapshot.caseRecord.id,
      "entity_resolution"
    );
    assert.equal(
      finalSnapshot.steps.find((step) => step.stepKey === "entity_resolution")?.status,
      "blocked"
    );
    assert.equal(finalSnapshot.caseRecord.legalName, null);
    assert.equal(finalSnapshot.caseRecord.incorporationCountry, null);
    assert.equal(
      finalSnapshot.facts.some((fact) =>
        fact.factKey.startsWith("website_entity_inference_")
      ),
      false
    );
  } finally {
    globalThis.fetch = originalFetch;
    runtime.close();
  }
});

test("public-market shortcut review defers downstream screening until cleared", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "policy-bot-public-shortcut-"));
  const runtime = new PolicyBotRuntime(
    getConfig({
      POLICY_BOT_RUNTIME: "local",
      POLICY_BOT_POLICY_DIR: policyDirectory,
      POLICY_BOT_DB_PATH: join(tempRoot, "bot.sqlite"),
      POLICY_BOT_ARTIFACT_DIR: join(tempRoot, "artifacts"),
      POLICY_BOT_REPORT_DIR: join(tempRoot, "reports"),
    }),
    {
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
    }
  );

  try {
    const snapshot = await runtime.workflow.createCase({
      displayName: "Apple Inc.",
      counterpartyKind: "entity",
      legalName: null,
      incorporationCountry: "US",
      incorporationState: "CA",
      website: "https://www.apple.com",
      registrySearchUrl: null,
      publicListingUrl: "https://www.nasdaq.com/market-activity/stocks/aapl",
      exchangeName: "NASDAQ",
      stockSymbol: "AAPL",
      requestedBy: "tester",
      notes: null,
      slackChannelId: null,
      slackThreadTs: null,
    });

    await runtime.runWorkerUntilIdle("test-worker");
    let finalSnapshot = runtime.workflow.getCaseSnapshot(snapshot.caseRecord.id);
    assert.equal(finalSnapshot.caseRecord.caseStatus, "awaiting_review");
    assert.equal(finalSnapshot.caseRecord.recommendation, "manual_review");
    assert.equal(
      finalSnapshot.steps.find((step) => step.stepKey === "public_market_shortcut")?.status,
      "manual_review_required"
    );
    assert.equal(
      finalSnapshot.steps.find((step) => step.stepKey === "good_standing")?.status,
      "pending"
    );
    assert.equal(
      finalSnapshot.steps.find((step) => step.stepKey === "good_standing")?.note,
      "Waiting for public-market shortcut review before running downstream screening."
    );
    assert.equal(
      finalSnapshot.issues.some((issue) => issue.stepKey === "good_standing"),
      false
    );

    const reviewTask = finalSnapshot.reviewTasks.find((task) => task.status === "open");
    assert.ok(reviewTask);

    finalSnapshot = await runtime.workflow.resolveReviewTask(
      reviewTask!.id,
      "clear",
      "Listing confirmed manually."
    );

    assert.equal(finalSnapshot.caseRecord.caseStatus, "completed");
    assert.equal(finalSnapshot.caseRecord.recommendation, "approved");
    assert.equal(
      finalSnapshot.steps.find((step) => step.stepKey === "good_standing")?.status,
      "skipped"
    );
  } finally {
    runtime.close();
  }
});

test("rejecting the public-market shortcut resumes downstream screening", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "policy-bot-public-reject-"));
  const runtime = new PolicyBotRuntime(
    getConfig({
      POLICY_BOT_RUNTIME: "local",
      POLICY_BOT_POLICY_DIR: policyDirectory,
      POLICY_BOT_DB_PATH: join(tempRoot, "bot.sqlite"),
      POLICY_BOT_ARTIFACT_DIR: join(tempRoot, "artifacts"),
      POLICY_BOT_REPORT_DIR: join(tempRoot, "reports"),
    }),
    {
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
    }
  );

  try {
    const snapshot = await runtime.workflow.createCase({
      displayName: "Apple Inc.",
      counterpartyKind: "entity",
      legalName: null,
      incorporationCountry: "US",
      incorporationState: "CA",
      website: "https://www.apple.com",
      registrySearchUrl: null,
      publicListingUrl: "https://www.nasdaq.com/market-activity/stocks/aapl",
      exchangeName: "NASDAQ",
      stockSymbol: "AAPL",
      requestedBy: "tester",
      notes: null,
      slackChannelId: null,
      slackThreadTs: null,
    });

    await runtime.runWorkerUntilIdle("test-worker");
    const reviewTask = runtime
      .workflow
      .getCaseSnapshot(snapshot.caseRecord.id)
      .reviewTasks.find((task) => task.status === "open");
    assert.ok(reviewTask);

    await runtime.workflow.resolveReviewTask(
      reviewTask!.id,
      "concern",
      "Shortcut not accepted; continue full screening."
    );
    await runtime.runWorkerUntilIdle("test-worker");

    const finalSnapshot = runtime.workflow.getCaseSnapshot(snapshot.caseRecord.id);
    assert.equal(
      finalSnapshot.steps.find((step) => step.stepKey === "public_market_shortcut")?.status,
      "skipped"
    );
    assert.equal(
      finalSnapshot.steps.find((step) => step.stepKey === "entity_resolution")?.status,
      "passed"
    );
    assert.equal(
      finalSnapshot.steps.find((step) => step.stepKey === "good_standing")?.status,
      "manual_review_required"
    );
    assert.equal(finalSnapshot.caseRecord.caseStatus, "awaiting_review");
    assert.equal(finalSnapshot.caseRecord.recommendation, "manual_review");
  } finally {
    runtime.close();
  }
});

test("prior resolved entity fields can be reused even when no prior registry url exists", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "policy-bot-resolved-reuse-"));
  const runtime = new PolicyBotRuntime(
    getConfig({
      POLICY_BOT_RUNTIME: "local",
      POLICY_BOT_POLICY_DIR: policyDirectory,
      POLICY_BOT_DB_PATH: join(tempRoot, "bot.sqlite"),
      POLICY_BOT_ARTIFACT_DIR: join(tempRoot, "artifacts"),
      POLICY_BOT_REPORT_DIR: join(tempRoot, "reports"),
    }),
    {
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
    }
  );

  try {
    await runtime.createCase({
      displayName: "Reuse Candidate",
      counterpartyKind: "entity",
      legalName: "Reuse Candidate, Inc.",
      incorporationCountry: "US",
      incorporationState: "DE",
      website: "https://reuse.example",
      registrySearchUrl: null,
      publicListingUrl: null,
      exchangeName: null,
      stockSymbol: null,
      requestedBy: "tester",
      notes: null,
      slackChannelId: null,
      slackThreadTs: null,
    });

    const secondSnapshot = await runtime.createCase({
      displayName: "Reuse Candidate",
      counterpartyKind: "entity",
      legalName: null,
      incorporationCountry: null,
      incorporationState: null,
      website: null,
      registrySearchUrl: null,
      publicListingUrl: null,
      exchangeName: null,
      stockSymbol: null,
      requestedBy: "tester",
      notes: null,
      slackChannelId: null,
      slackThreadTs: null,
    });

    const finalSnapshot = await runtime.workflow.runStep(
      secondSnapshot.caseRecord.id,
      "entity_resolution"
    );

    assert.equal(
      finalSnapshot.steps.find((step) => step.stepKey === "entity_resolution")?.status,
      "passed"
    );
    assert.equal(finalSnapshot.caseRecord.legalName, "Reuse Candidate, Inc.");
    assert.equal(finalSnapshot.caseRecord.incorporationCountry, "US");
    assert.equal(finalSnapshot.caseRecord.incorporationState, "DE");
    assert.equal(
      finalSnapshot.caseRecord.registrySearchUrl,
      "https://icis.corp.delaware.gov/Ecorp/EntitySearch/NameSearch.aspx"
    );
    assert.ok(
      finalSnapshot.facts.some((fact) => fact.factKey === "entity_identity_reused")
    );
  } finally {
    runtime.close();
  }
});

test("entity evidence cache avoids refetching the same official hint page across cases", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "policy-bot-entity-cache-"));
  const runtime = new PolicyBotRuntime(
    getConfig({
      POLICY_BOT_RUNTIME: "local",
      POLICY_BOT_POLICY_DIR: policyDirectory,
      POLICY_BOT_DATA_DIR: tempRoot,
      POLICY_BOT_DB_PATH: join(tempRoot, "bot.sqlite"),
      POLICY_BOT_ARTIFACT_DIR: join(tempRoot, "artifacts"),
      POLICY_BOT_REPORT_DIR: join(tempRoot, "reports"),
      POLICY_BOT_ENTITY_EVIDENCE_CACHE_DIR: join(tempRoot, "entity-cache"),
    }),
    {
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
    }
  );

  let uniswapHintFetches = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (
      request.url ===
      "https://support.uniswap.org/hc/en-us/articles/43018872248589-API-Terms-of-Use"
    ) {
      uniswapHintFetches += 1;
      return new Response(
        "<html><head><title>API Terms of Use – Uniswap Labs</title></head><body>These Uniswap Labs API Terms of Use describe your rights and obligations when accessing certain application programming interfaces made available by Universal Navigation, Inc. dba “Uniswap Labs”, a Delaware corporation.</body></html>",
        {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }
      );
    }

    return originalFetch(input, init);
  };

  try {
    const firstSnapshot = await runtime.createCase({
      displayName: "Uniswap Labs",
      counterpartyKind: "entity",
      legalName: null,
      incorporationCountry: null,
      incorporationState: null,
      website: "https://uniswap.org",
      registrySearchUrl: null,
      publicListingUrl: null,
      exchangeName: null,
      stockSymbol: null,
      requestedBy: "tester",
      notes: null,
      slackChannelId: null,
      slackThreadTs: null,
    });
    await runtime.workflow.runStep(firstSnapshot.caseRecord.id, "entity_resolution");

    const secondSnapshot = await runtime.createCase({
      displayName: "Uniswap",
      counterpartyKind: "entity",
      legalName: null,
      incorporationCountry: null,
      incorporationState: null,
      website: "https://uniswap.org",
      registrySearchUrl: null,
      publicListingUrl: null,
      exchangeName: null,
      stockSymbol: null,
      requestedBy: "tester",
      notes: null,
      slackChannelId: null,
      slackThreadTs: null,
    });
    const finalSnapshot = await runtime.workflow.runStep(
      secondSnapshot.caseRecord.id,
      "entity_resolution"
    );

    assert.equal(uniswapHintFetches, 1);
    assert.equal(finalSnapshot.caseRecord.legalName, "Universal Navigation, Inc.");
    assert.equal(finalSnapshot.caseRecord.incorporationCountry, "US");
    assert.equal(finalSnapshot.caseRecord.incorporationState, "DE");
  } finally {
    globalThis.fetch = originalFetch;
    runtime.close();
  }
});

test("flashbots entity resolution surfaces multi-entity scope confirmation and exact registry handles", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "policy-bot-flashbots-structure-"));
  const runtime = new PolicyBotRuntime(
    getConfig({
      POLICY_BOT_RUNTIME: "local",
      POLICY_BOT_POLICY_DIR: policyDirectory,
      POLICY_BOT_DB_PATH: join(tempRoot, "bot.sqlite"),
      POLICY_BOT_ARTIFACT_DIR: join(tempRoot, "artifacts"),
      POLICY_BOT_REPORT_DIR: join(tempRoot, "reports"),
    }),
    {
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
    }
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url === "https://docs.flashbots.net/policies/terms-of-service") {
      return new Response(
        "<html><body><h1>Flashbots Terms</h1><p>These terms govern services provided by Flashbots Ltd.</p></body></html>",
        {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }
      );
    }

    return originalFetch(input, init);
  };

  try {
    const snapshot = await runtime.createCase({
      displayName: "Flashbots",
      counterpartyKind: "entity",
      legalName: null,
      incorporationCountry: null,
      incorporationState: null,
      website: null,
      registrySearchUrl: null,
      publicListingUrl: null,
      exchangeName: null,
      stockSymbol: null,
      requestedBy: "tester",
      notes: null,
      slackChannelId: null,
      slackThreadTs: null,
    });

    const finalSnapshot = await runtime.workflow.runStep(
      snapshot.caseRecord.id,
      "entity_resolution"
    );

    assert.equal(
      finalSnapshot.steps.find((step) => step.stepKey === "entity_resolution")?.status,
      "passed"
    );
    assert.equal(finalSnapshot.caseRecord.legalName, "Flashbots Ltd.");
    assert.equal(finalSnapshot.caseRecord.incorporationCountry, "Cayman Islands");
    assert.equal(finalSnapshot.caseRecord.registrySearchUrl, "https://online.ciregistry.gov.ky/");
    assert.ok(
      finalSnapshot.facts.some((fact) => fact.factKey === "known_entity_structure")
    );
    assert.ok(
      finalSnapshot.issues.some((issue) =>
        /multiple known legal entities/i.test(issue.title)
      )
    );
    assert.ok(
      finalSnapshot.reviewTasks.some((task) =>
        /Confirm in-scope legal entity/i.test(task.title)
      )
    );

    const routingFact = finalSnapshot.facts.find(
      (fact) => fact.factKey === "official_registry_path_established"
    );
    assert.ok(routingFact);
    const routingValue = JSON.parse(routingFact!.valueJson) as {
      suggestions?: Array<{ exactEntityName?: string; fileNumber?: string }>;
    };
    assert.ok(
      routingValue.suggestions?.some(
        (suggestion) =>
          suggestion.exactEntityName === "FLASHBOTS US, LLC" &&
          suggestion.fileNumber === "4174953"
      )
    );

    const goodStandingSnapshot = await runtime.workflow.runStep(
      snapshot.caseRecord.id,
      "good_standing"
    );
    const goodStandingTask = goodStandingSnapshot.reviewTasks.find(
      (task) => task.stepKey === "good_standing" && task.status === "open"
    );
    assert.ok(goodStandingTask);
    assert.match(goodStandingTask!.instructions, /Flashbots Ltd\./);
    assert.match(goodStandingTask!.instructions, /4174953/);
    assert.match(goodStandingTask!.instructions, /Cayman company search/i);
    assert.match(goodStandingTask!.instructions, /online tools/i);
    assert.match(goodStandingTask!.instructions, /registered users/i);
  } finally {
    globalThis.fetch = originalFetch;
    runtime.close();
  }
});

test("delaware manual registry review instructions include exact entity name and file number", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "policy-bot-delaware-targeting-"));
  const runtime = new PolicyBotRuntime(
    getConfig({
      POLICY_BOT_RUNTIME: "local",
      POLICY_BOT_POLICY_DIR: policyDirectory,
      POLICY_BOT_DB_PATH: join(tempRoot, "bot.sqlite"),
      POLICY_BOT_ARTIFACT_DIR: join(tempRoot, "artifacts"),
      POLICY_BOT_REPORT_DIR: join(tempRoot, "reports"),
    }),
    {
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
    }
  );

  try {
    const snapshot = await runtime.createCase({
      displayName: "Uniswap Labs",
      counterpartyKind: "entity",
      legalName: "Universal Navigation, Inc.",
      incorporationCountry: "US",
      incorporationState: "DE",
      website: null,
      registrySearchUrl: null,
      publicListingUrl: null,
      exchangeName: null,
      stockSymbol: null,
      requestedBy: "tester",
      notes: null,
      slackChannelId: null,
      slackThreadTs: null,
    });

    await runtime.workflow.runStep(snapshot.caseRecord.id, "entity_resolution");
    const finalSnapshot = await runtime.workflow.runStep(
      snapshot.caseRecord.id,
      "good_standing"
    );

    const reviewTask = finalSnapshot.reviewTasks.find(
      (task) =>
        task.status === "open" &&
        task.stepKey === "good_standing" &&
        /official registry good-standing/i.test(task.title)
    );
    assert.ok(reviewTask);
    assert.match(reviewTask!.instructions, /UNIVERSAL NAVIGATION INC\./i);
    assert.match(reviewTask!.instructions, /7053324/);
    assert.match(reviewTask!.instructions, /Delaware corporate status online/i);
    assert.match(reviewTask!.instructions, /paid/i);
  } finally {
    runtime.close();
  }
});

test("reputation search flags possible Google layout drift when result markup is missing", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "policy-bot-google-drift-"));
  const runtime = new PolicyBotRuntime(
    getConfig({
      POLICY_BOT_RUNTIME: "local",
      POLICY_BOT_POLICY_DIR: policyDirectory,
      POLICY_BOT_DB_PATH: join(tempRoot, "bot.sqlite"),
      POLICY_BOT_ARTIFACT_DIR: join(tempRoot, "artifacts"),
      POLICY_BOT_REPORT_DIR: join(tempRoot, "reports"),
    }),
    {
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
    }
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url.includes("google.com/search")) {
      return new Response(
        "<html><head><title>Google Search</title></head><body><form><input name=\"q\" value=\"test\"></form><div>Search tools</div><div>About 100 results</div></body></html>",
        {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }
      );
    }

    return originalFetch(input, init);
  };

  try {
    const snapshot = await runtime.createCase({
      displayName: "Drift Test Co",
      counterpartyKind: "entity",
      legalName: "Drift Test Co",
      incorporationCountry: "US",
      incorporationState: "DE",
      website: null,
      registrySearchUrl: null,
      publicListingUrl: null,
      exchangeName: null,
      stockSymbol: null,
      requestedBy: "tester",
      notes: null,
      slackChannelId: null,
      slackThreadTs: null,
    });

    const finalSnapshot = await runtime.workflow.runStep(
      snapshot.caseRecord.id,
      "reputation_search"
    );

    const driftIssue = finalSnapshot.issues.find(
      (issue) =>
        issue.stepKey === "reputation_search" &&
        /extraction may be degraded/i.test(issue.title)
    );
    assert.ok(driftIssue);
    assert.match(driftIssue!.detail, /layout_changed|thin_content/i);

    const summaryFact = finalSnapshot.facts.find(
      (fact) => fact.stepKey === "reputation_search" && fact.factKey === "reputation_search_summary"
    );
    assert.ok(summaryFact);
    const summaryValue = JSON.parse(summaryFact!.valueJson) as {
      pages?: Array<{ structureStatus?: string; structureSignals?: string[] }>;
    };
    assert.ok(
      summaryValue.pages?.every(
        (page) => page.structureStatus === "layout_changed" || page.structureStatus === "thin_content"
      )
    );

    const reviewTask = finalSnapshot.reviewTasks.find(
      (task) => task.stepKey === "reputation_search" && task.status === "open"
    );
    assert.ok(reviewTask);
    assert.match(reviewTask!.instructions, /layout drift/i);
  } finally {
    globalThis.fetch = originalFetch;
    runtime.close();
  }
});

test("bbb review flags possible site drift when expected business result markers are missing", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "policy-bot-bbb-drift-"));
  const runtime = new PolicyBotRuntime(
    getConfig({
      POLICY_BOT_RUNTIME: "local",
      POLICY_BOT_POLICY_DIR: policyDirectory,
      POLICY_BOT_DB_PATH: join(tempRoot, "bot.sqlite"),
      POLICY_BOT_ARTIFACT_DIR: join(tempRoot, "artifacts"),
      POLICY_BOT_REPORT_DIR: join(tempRoot, "reports"),
    }),
    {
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
    }
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url.includes("bbb.org/search")) {
      return new Response(
        "<html><head><title>BBB Search</title></head><body><h1>BBB</h1><div>Search for businesses, charities and reviews.</div></body></html>",
        {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }
      );
    }

    return originalFetch(input, init);
  };

  try {
    const snapshot = await runtime.createCase({
      displayName: "Drift Test Co",
      counterpartyKind: "entity",
      legalName: "Drift Test Co",
      incorporationCountry: "US",
      incorporationState: "DE",
      website: null,
      registrySearchUrl: null,
      publicListingUrl: null,
      exchangeName: null,
      stockSymbol: null,
      requestedBy: "tester",
      notes: null,
      slackChannelId: null,
      slackThreadTs: null,
    });

    const finalSnapshot = await runtime.workflow.runStep(snapshot.caseRecord.id, "bbb_review");
    const driftIssue = finalSnapshot.issues.find(
      (issue) => issue.stepKey === "bbb_review" && /extraction may be degraded/i.test(issue.title)
    );
    assert.ok(driftIssue);
    assert.match(driftIssue!.detail, /layout_changed|thin_content/i);

    const summaryFact = finalSnapshot.facts.find(
      (fact) => fact.stepKey === "bbb_review" && fact.factKey === "bbb_search_summary"
    );
    assert.ok(summaryFact);
    const summaryValue = JSON.parse(summaryFact!.valueJson) as {
      structureStatus?: string;
      structureSignals?: string[];
    };
    assert.match(summaryValue.structureStatus ?? "", /layout_changed|thin_content/);

    const reviewTask = finalSnapshot.reviewTasks.find(
      (task) => task.stepKey === "bbb_review" && task.status === "open"
    );
    assert.ok(reviewTask);
    assert.match(reviewTask!.instructions, /raw capture/i);
  } finally {
    globalThis.fetch = originalFetch;
    runtime.close();
  }
});

test("manual review resolution records reviewer source and carries step evidence ids", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "policy-bot-review-trace-"));
  const runtime = new PolicyBotRuntime(
    getConfig({
      POLICY_BOT_RUNTIME: "local",
      POLICY_BOT_POLICY_DIR: policyDirectory,
      POLICY_BOT_DB_PATH: join(tempRoot, "bot.sqlite"),
      POLICY_BOT_ARTIFACT_DIR: join(tempRoot, "artifacts"),
      POLICY_BOT_REPORT_DIR: join(tempRoot, "reports"),
    }),
    {
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
    }
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url === "https://docs.flashbots.net/policies/terms-of-service") {
      return new Response(
        "<html><body><h1>Flashbots Terms</h1><p>These terms govern services provided by Flashbots Ltd.</p></body></html>",
        {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }
      );
    }

    return originalFetch(input, init);
  };

  try {
    const snapshot = await runtime.createCase({
      displayName: "Flashbots",
      counterpartyKind: "entity",
      legalName: null,
      incorporationCountry: null,
      incorporationState: null,
      website: null,
      registrySearchUrl: null,
      publicListingUrl: null,
      exchangeName: null,
      stockSymbol: null,
      requestedBy: "tester",
      notes: null,
      slackChannelId: null,
      slackThreadTs: null,
    });

    const entitySnapshot = await runtime.workflow.runStep(
      snapshot.caseRecord.id,
      "entity_resolution"
    );
    const reviewTask = entitySnapshot.reviewTasks.find(
      (task) => task.stepKey === "entity_resolution" && task.status === "open"
    );
    assert.ok(reviewTask);

    const resolvedSnapshot = await runtime.workflow.resolveReviewTask(
      reviewTask!.id,
      "clear",
      "Confirmed the Cayman entity is in scope."
    );
    const resolutionFact = resolvedSnapshot.facts.find(
      (fact) => fact.factKey === "entity_resolution_review_resolution"
    );
    assert.ok(resolutionFact);
    assert.equal(resolutionFact!.sourceId, "manual_review");
    assert.ok(resolutionFact!.evidenceIds.length > 0);
  } finally {
    globalThis.fetch = originalFetch;
    runtime.close();
  }
});

async function startServer(body: string): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(body);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Server did not expose an address");
  }

  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: async () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}
