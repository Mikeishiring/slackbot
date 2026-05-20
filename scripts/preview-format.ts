/**
 * Preview the Slack-bound text for a handful of realistic Claude outputs.
 *
 * Not a test — a side-by-side visual check. Useful when tweaking the
 * converter or the system prompt: paste in a real response, see what
 * Slack would render.
 *
 * Run: npx tsx scripts/preview-format.ts
 */

import { toSlackMrkdwn } from "../src/format.js";

interface Fixture {
  name: string;
  raw: string;
}

const fixtures: Fixture[] = [
  {
    name: "Tool-result summary with bolded items",
    raw:
      "Found 3 items this week:\n\n" +
      "- **Project Alpha** — launched Mon, 12 signups\n" +
      "- **Beta Feedback** — Sarah K. flagged 2 perf regressions\n" +
      "- **Eng All-Hands** — Wed 3pm, agenda in [the doc](https://example.com/agenda)\n\n" +
      "Want me to dig into any of them?",
  },
  {
    name: "Multi-section answer with headings",
    raw:
      "## Summary\n" +
      "Three things changed since last Friday.\n\n" +
      "## Details\n" +
      "1. The migration finally landed — see [PR #4421](https://github.com/example/repo/pull/4421).\n" +
      "2. Latency on the *write path* dropped from 240ms p99 to 180ms.\n" +
      "3. **Two new errors** showed up in the queue worker — both look transient.\n\n" +
      "## Next\n" +
      "Worth a quick standup mention. The errors are the only thing I'd watch.",
  },
  {
    name: "Empty-results fallback",
    raw:
      "I couldn't find anything matching **\"q3 roadmap\"** in the data.\n\n" +
      "Some things to try:\n" +
      "- Search for a related team — e.g. *platform* or *growth*\n" +
      "- Use a date filter instead of a topic\n" +
      "- Check spelling — closest matches were *q4 roadmap* and *q2 retro*",
  },
  {
    name: "Single fact with citation",
    raw:
      "The *Beta Feedback* doc was last edited on **2026-05-18** by Sarah K.\n" +
      "Link: [Beta Feedback (Notion)](https://example.com/docs/beta-feedback)",
  },
  {
    name: "Nested list with mixed emphasis",
    raw:
      "Here's what each team owns:\n\n" +
      "- **Platform**\n" +
      "  - Auth, [SSO docs](https://example.com/sso)\n" +
      "  - Database migrations\n" +
      "- **Growth**\n" +
      "  - Onboarding funnel\n" +
      "  - *Experimentation framework* (in progress)\n" +
      "- **Eng Ops**\n" +
      "  - CI/CD, [runbook](https://example.com/runbook)",
  },
  {
    name: "Edge case — code block + inline code + URL",
    raw:
      "To reproduce, run `npm run check` and watch for the failure.\n\n" +
      "The relevant line is in `src/format.ts`:\n" +
      "```\nfunction convertBold(text: string): string\n```\n\n" +
      "Reference: https://api.slack.com/reference/surfaces/formatting",
  },
];

const divider = "─".repeat(70);

for (const fixture of fixtures) {
  console.log(`\n${divider}`);
  console.log(`  ${fixture.name}`);
  console.log(divider);
  console.log("\n[RAW — what Claude emits]\n");
  console.log(fixture.raw);
  console.log("\n[CONVERTED — what Slack sees]\n");
  console.log(toSlackMrkdwn(fixture.raw));
  console.log();
}
