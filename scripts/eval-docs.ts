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
  ["what key goes down one row", "code.down"],
  ["take me up a few lines", "code.up"],
  ["skip the rest of this section and start the next one", "code.next_chapter"],
  ["where did the chapter before this one go", "code.prev_chapter"],
  ["take me to whatever the model flagged next", "go.next_finding"],
  ["does the line I'm looking at have an issue", "code.open_finding"],
  ["make long lines fold instead of disappearing", "view.wrap"],
  ["why did the model put this chapter here", "code.to_toc"],
  ["I don't get what this code is doing, can I ask", "ai.ask"],
  ["this finding is a false positive", "finding.ignore"],
  ["I can't approve this until that's fixed", "finding.block"],
  ["respond to the finding with a remark but don't hold up the merge", "finding.comment"],
  ["close this popup", "finding.close"],
  ["send the finding text to my clipboard", "finding.copy"],
  ["copy the path and line number", "review.copy"],
  ["open vim on this file", "view.editor"],
  ["write a remark on a specific line", "code.new_finding"],
  ["I'm done, post it to GitHub", "review.submit"],
  ["exit without losing anything", "review.quit"],
  ["go back to the finding I just looked at", "go.prev_finding"],
  ["only show me the high severity stuff", "filter.high"],
  ["take me to line 42", "go.line"],
  ["show the overview of the PR again", "ai.info"],
  ["hide the sidebar so the code is wider", "view.zen"],
  ["how do I rebind a key", "review.settings"],
  ["what's the most serious problem here", "go.next_severity"],
  ["only the high and medium findings please", "filter.medium"],
  ["I want to see everything the model found again", "filter.all"],
  ["give the code the whole screen so I can read the answer", "view.fullscreen"],
  ["take me to the last line of this file", "go.end"],
  ["go to chapter 3", "go.chapter"],
  ["I want to question the model about this finding", "ai.ask"],
  ["the model's reply about the finding was wrong, drop it", "ai.discard"],
  ["apply what the model suggested to the finding", "ai.accept"],
  ["have the model write my review for me", "ai.draft"],
  ["open the preferences", "review.settings"],
  ["look up how to do something in prview", "review.search_docs"],
  ["fold up a chapter in the sidebar", "toc.collapse"],
  ["I want to comment on the file as a whole, not a line", "go.top"],
  ["the author pushed fixes, which parts are new since I reviewed", "view.since"],
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
