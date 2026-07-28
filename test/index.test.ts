import assert from "node:assert/strict";
import test from "node:test";

import { registerShutdownHandlers } from "../src/index.js";

/**
 * These tests register real process signal listeners, so each one removes its
 * own afterwards. They deliberately never emit the signal — the handler calls
 * process.exit, which would take the test runner down with it.
 */
function withCleanSignalListeners(
  body: () => void | Promise<void>
): () => Promise<void> {
  return async () => {
    const before = {
      SIGTERM: process.listeners("SIGTERM"),
      SIGINT: process.listeners("SIGINT"),
    };
    try {
      await body();
    } finally {
      for (const signal of ["SIGTERM", "SIGINT"] as const) {
        for (const listener of process.listeners(signal)) {
          if (!before[signal].includes(listener)) {
            process.removeListener(signal, listener);
          }
        }
      }
    }
  };
}

test(
  "registerShutdownHandlers listens for both termination signals",
  withCleanSignalListeners(() => {
    const sigtermBefore = process.listenerCount("SIGTERM");
    const sigintBefore = process.listenerCount("SIGINT");

    registerShutdownHandlers(async () => {});

    assert.equal(process.listenerCount("SIGTERM"), sigtermBefore + 1);
    assert.equal(process.listenerCount("SIGINT"), sigintBefore + 1);
  })
);

test(
  "registerShutdownHandlers uses once-listeners so a repeated signal cannot double-stop",
  withCleanSignalListeners(() => {
    const before = new Set(process.rawListeners("SIGTERM"));

    registerShutdownHandlers(async () => {});

    // rawListeners() exposes the once-wrapper itself; Node documents that a
    // wrapper created by `once` carries the original handler on `.listener`.
    // That self-removing wrapper is what stops a duplicate SIGTERM from
    // racing two shutdowns.
    const added = process
      .rawListeners("SIGTERM")
      .filter((listener) => !before.has(listener));

    assert.equal(added.length, 1);
    assert.equal(
      typeof (added[0] as { listener?: unknown })?.listener,
      "function",
      "expected a once-wrapper, not a persistent listener"
    );
  })
);
