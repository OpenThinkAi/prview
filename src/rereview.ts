// Detecting a re-review, and the git behind the "since your review" layer (since.ts has the rules, pure). A re-review is
// a review of something you already submitted on, opened again at a newer head: the latest kept submission for the PR
// (by its canonical URL; a range by its review's name) reviewed another head than the one being opened. The head you
// reviewed is fetched when the clone no longer has it (through the PR's platform, by commit id); when it cannot be had,
// the review says so and shows the whole PR. A rebase never fails it: the diff is still old head → new head.

import { submissionsFor, type Submitted } from "./history.ts";
import { parseDiff, type FileDiff } from "./diff.ts";
import { git, type PrRef } from "./pr.ts";
import { parseRef, sourceOf } from "./registry.ts";
import { GONE_NOTE, parseNameStatus, pathsToDiff, REBASED_NOTE, sinceFiles, sinceLabel, type Since } from "./since.ts";
import type { Target } from "./document.ts";
import { keyOf } from "./keys.ts";

const ok = (args: string[], repo: string) => Bun.spawnSync(["git", ...args], { cwd: repo, stdin: "ignore", env: process.env }).exitCode === 0;
const has = (repo: string, c: string) => ok(["cat-file", "-e", `${c}^{commit}`], repo);

/** The ref that keeps the reviewed head in the clone once fetched (removed with the review's other refs by `prview done`). */
export const reviewedRef = (n: number) => `refs/prview/pr-${n}/reviewed`;

/** The paths your submission put comments on (its posted items, and its document's comments): where the next chapter looks. */
export function commentedPaths(s: Submitted): string[] {
  const out = new Set<string>();
  for (const it of s.submission?.posted?.items ?? []) if (it.path) out.add(it.path);
  for (const c of s.doc.human.comments) if (c.hunk) out.add(c.hunk.replace(/@[^@]*$/, ""));
  return [...out];
}

/** The latest submission for the review being opened: the PR's (by its canonical URL), else the review's own (by name). */
export function latestSubmission(t: Target, slug: string): Submitted | undefined {
  try { return (t.url ? submissionsFor(t.url) : submissionsFor(slug))[0]; } catch { return undefined; }
}

/** Make sure the reviewed head is in the clone, fetched through the PR's platform (by commit id) when it is not, and kept there by a ref. */
function haveHead(repo: string, pr: PrRef | undefined, head: string): boolean {
  const src = pr && sourceOf(pr.platform);
  if (!has(repo, head) && src) { try { src.fetch(repo, pr, true, head); } catch {} }
  if (!has(repo, head)) return false;
  if (pr) ok(["update-ref", reviewedRef(pr.number), head], repo);
  return true;
}

/**
 * The re-review layer for a review being opened at `t.head`, or undefined when it is not a re-review (nothing submitted
 * yet, or the last submit was at this head). `files` is the PR's diff (base..new head). `say` gets the startup line.
 */
export function rereviewOf(repo: string, slug: string, t: Target, files: FileDiff[], say: (s: string) => void = () => {}, latest = latestSubmission(t, slug)): Since | undefined {
  if (!latest || !latest.head || latest.head === t.head) return undefined;
  const base: Since = { head: latest.head, at: latest.at };
  if (!haveHead(repo, parseRef(t.url), latest.head)) {
    say(`re-review · since ${sinceLabel(base)}: ${GONE_NOTE}`);
    return { ...base, gone: true };
  }
  try {
    const rebased = !ok(["merge-base", "--is-ancestor", latest.head, t.head], repo);
    const names = parseNameStatus(Bun.spawnSync(["git", "diff", "-M", "--name-status", "-z", latest.head, t.head], { cwd: repo, stdin: "ignore", env: process.env }).stdout.toString());
    const paths = pathsToDiff(names, files, commentedPaths(latest));
    const diff = paths.length ? parseDiff(git(["diff", "-M", "--no-color", "--no-ext-diff", "--unified=0", latest.head, t.head, "--", ...paths], repo)) : [];
    const s: Since = { ...base, ...(rebased ? { rebased: true as const } : {}), files: sinceFiles(diff) };
    const moved = new Set(s.files!.map((f) => f.path)), n = files.filter((f) => moved.has(f.path)).length;
    say(`re-review · since ${sinceLabel(base)}: ${n} file${n === 1 ? "" : "s"} of the PR changed since your review${rebased ? ` (${REBASED_NOTE})` : ""}; ${keyOf("view.since")} shows only those`);
    return s;
  } catch {
    say(`re-review · since ${sinceLabel(base)}: ${GONE_NOTE}`);
    return { ...base, gone: true };
  }
}
