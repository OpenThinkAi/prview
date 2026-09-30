#!/usr/bin/env bun
// Holds docs search to a bar: for each real question below, the action that answers it must be in the top 3 hits.
// The questions were written from what a reviewer would type, not from docs/recipes.toml; do not tune a question to
// pass. A miss means the recipes or the action descriptions are missing words a reviewer uses, so fix those (and
// rebuild the index), never the model.
//
//   bun scripts/eval-docs.ts          prints each question, where the answer ranked, and the two rates
//   bun scripts/eval-docs.ts --quiet  only the summary
//
// Offline, and instant. Exit 0 when at least 85% of questions have their action in the top 3.

import { search } from "../src/docs-index.ts";

export const PASS_RATE = 0.85;

/** [question, the action that answers it] */
export const QUESTIONS: [string, string][] = [
  ["what key goes down one row", "nav.line_down"],
  ["take me up a few lines", "nav.line_up"],
  ["I want to see the next piece of the diff", "nav.next_hunk"],
  ["jump to the previous hunk", "nav.prev_hunk"],
  ["skip the rest of this section and start the next one", "nav.next_chapter"],
  ["where did the chapter before this one go", "nav.prev_chapter"],
  ["take me to whatever the model flagged next", "nav.next_finding"],
  ["does the hunk I'm looking at have any issues", "nav.finding_here"],
  ["my line is cut off on the right, how do I see the rest", "nav.pan_right"],
  ["make long lines fold instead of disappearing", "nav.wrap"],
  ["why did the model put this chapter here", "nav.why"],
  ["I don't get what this code is doing, can I ask", "nav.ask"],
  ["the findings are hidden and I want to peek", "nav.reveal"],
  ["this finding is a false positive", "finding.not_an_issue"],
  ["I can't approve this until that's fixed", "finding.block"],
  ["respond to the finding with a remark but don't hold up the merge", "finding.comment"],
  ["oops, wrong button on that finding", "finding.undo"],
  ["close this popup", "finding.hide"],
  ["send the finding text to my clipboard", "finding.copy"],
  ["copy the path and line number", "nav.copy"],
  ["open vim on this file", "nav.edit"],
  ["write a remark on a specific line", "nav.note"],
  ["I want to say something about the PR overall", "nav.general_note"],
  ["what are all the shortcuts", "nav.bindings"],
  ["I'm done, post it to GitHub", "nav.submit"],
  ["exit without losing anything", "nav.quit"],
  ["copy the summary shown in the box", "info.copy"],
  ["go back to the finding I just looked at", "nav.prev_finding"],
];

/** Runs every question; `rank` is 1-based, 0 when the answer is not in the top 10. */
export function evaluate(): { q: string; want: string; rank: number; got: string[] }[] {
  return QUESTIONS.map(([q, want]) => {
    const hits = search(q, 10);
    return { q, want, rank: hits.findIndex((h) => h.action === want) + 1, got: hits.slice(0, 3).map((h) => h.action) };
  });
}

if (import.meta.main) {
  const quiet = process.argv.includes("--quiet");
  const results = evaluate();
  const top3 = results.filter((r) => r.rank >= 1 && r.rank <= 3).length;
  const top1 = results.filter((r) => r.rank === 1).length;
  if (!quiet) for (const r of results) console.log(`${r.rank >= 1 && r.rank <= 3 ? "ok  " : "MISS"} ${r.rank || "-"}\t${r.q}  ->  ${r.want}${r.rank === 0 || r.rank > 3 ? `   got ${r.got.join(", ")}` : ""}`);
  const pct = (n: number) => `${((100 * n) / results.length).toFixed(1)}%`;
  console.log(`${results.length} questions: top-3 ${top3} (${pct(top3)}), top-1 ${top1} (${pct(top1)}), bar ${PASS_RATE * 100}%`);
  process.exit(top3 / results.length >= PASS_RATE ? 0 : 1);
}
