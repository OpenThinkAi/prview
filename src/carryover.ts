// The reader's own comments across a moved head. When a PR's head moves the review is rebuilt, and only the reader's
// comments carry over (build.ts). Those were written on the old head, mostly on findings that no longer exist, and
// many of them already reached the PR in an earlier submit. So:
//
//   - `carry` re-anchors each carried comment on the hunk of the new diff that holds its line (else it keeps its old
//     hunk, and posting puts it in the summary under its file name), and records the head it came from;
//   - `postedBefore` reads what earlier submits of this pull request posted, from the kept submissions (history.ts);
//   - `ownComments` lists every comment of the reader's that posts but is not a current finding's (those are ticked
//     with their finding), each with what is known about it: posted before (when, which round), or carried over.
//
// The submit checklist lists these beside the findings so nothing posts that the reader cannot untick; one that was
// posted before starts unticked. Comparing is on what was posted (path, side, line, text), never on ids, so a reader of
// recorded platform ids could stand in for `postedBefore` without anything else changing.

import type { FileDiff } from "./diff.ts";
import { hunksOf } from "./guide.ts";
import type { Comment, Doc, Human } from "./document.ts";
import { submissionsFor } from "./history.ts";

/** A comment's file, from its hunk id (`path@old:new`, `path@file`). */
export const pathOfHunk = (hunk: string) => hunk.replace(/@[^@]*$/, "");

/** A comment as compared with what posted: where it is and what it says. A summary comment (no hunk) has no path. */
export const postKey = (c: Pick<Comment, "hunk" | "side" | "line" | "text" | "file">) =>
  placedKey(c.hunk === null ? "" : pathOfHunk(c.hunk), c.file ? "file" : c.side, c.file ? null : c.line, c.text);
/** The same key for a comment as a posting holds it (platform.ts Posting): a line comment, or a whole-file one (`side` "file"). */
export const placedKey = (path: string, side: "new" | "old" | "file", line: number | null, text: string) => [path, side, line ?? "", text.trim()].join("\0");

/** A comment as one entry of the submit checklist: stable while the flow is open. */
export const ownKey = (c: Comment) => `\0own\0${[c.hunk, c.side, c.line ?? "", c.file ? "file" : "", c.text].join("\0")}`;
export const isOwnKey = (id: string) => id.startsWith("\0own\0");

/** Something an earlier submit of this review put on the PR: its post key, when, the head it reviewed and the round (1 = the first submit). */
export type Earlier = { key: string; at: string; head: string; round: number };

/** What earlier submits posted, for one review. The default reads the files; a history reader can stand in for it. */
export type EarlierReader = (slug: string, doc: Doc) => Earlier[];

/**
 * The default reader, over the kept submissions of this pull request (history.ts: every submit's document, the legacy
 * flat file included). What a submit posted is its record's `posted.items` where it has them (also after a partial
 * failure); a record from before those, whose post went through, posted its document's line, file and summary comments.
 */
export const postedBefore: EarlierReader = (slug, doc) => {
  const kept = submissionsFor(doc.target.url ?? slug);
  const posts = kept.flatMap((k) => {
    const posted = k.submission?.posted, items = posted?.items ?? [];
    const keys = items.length
      ? items.flatMap((i) => i.kind === "line" && i.path ? [placedKey(i.path, i.side ?? "new", i.line ?? null, i.text)] : i.kind === "file" && i.path ? [placedKey(i.path, "file", null, i.text)] : [])
      : posted?.ok ? k.doc.human.comments.filter((c) => c.hunk !== null).map(postKey) : [];
    // The summary as the reader wrote it (the posted body may carry a coverage line or folded file comments besides).
    if (posted?.ok || items.some((i) => i.kind === "summary")) keys.push(...k.doc.human.comments.filter((c) => c.hunk === null).map(postKey));
    return keys.length ? [{ at: k.at, head: k.head, keys }] : [];
  });
  // One round per submit, in time order.
  const ats = [...new Set(posts.map((p) => p.at))].sort();
  const out = new Map<string, Earlier>();
  for (const p of posts.sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0)) {
    for (const key of p.keys) if (!out.has(key)) out.set(key, { key, at: p.at, head: p.head, round: ats.indexOf(p.at) + 1 });
  }
  return [...out.values()];
};

/** Where carried comments came from: post key to the head they were written on. Kept with the review, not the document. */
export type Carried = Record<string, string>;

/**
 * The reader's comments from `prior`, ready for the review at the new head: a line comment moves to the hunk of the new
 * diff on the same file whose lines hold its line (same side); a file comment to the file's first hunk. Anything else keeps
 * its hunk. `carried` records the head each came from (an older origin, from an earlier carry, is kept).
 */
export function carry(prior: { human: Human; head: string; carried?: Carried }, files: FileDiff[]): { comments: Comment[]; carried: Carried } {
  const hunks = hunksOf(files);
  const carried: Carried = {};
  const comments = prior.human.comments.map((c): Comment => {
    const from = prior.carried?.[postKey(c)] ?? prior.head;
    let out = c;
    if (c.hunk !== null) {
      const path = pathOfHunk(c.hunk);
      const same = hunks.filter((h) => h.file.path === path);
      const to = c.file ? same[0] : same.find((h) => h.hunk && c.line !== null && h.hunk.lines.some((l) => (c.side === "new" ? l.n : l.o) === c.line));
      if (to) out = { ...c, hunk: to.id };
    }
    carried[postKey(out)] = from;
    return out;
  });
  return { comments, carried };
}

/** One of the reader's comments in the submit checklist. `posted`: an earlier submit already put it on the PR. `carried`: the head it came from. */
export type Own = { key: string; comment: Comment; posted?: Earlier; carried?: string };

/**
 * The reader's comments that post but are not a current finding's: every comment on a hunk (line or whole file) that no
 * decision of a finding in the review points at. Summary comments are the top-level comment's, not listed here.
 */
export function ownComments(h: Pick<Human, "comments" | "decisions">, findingIds: Iterable<string>, earlier: Earlier[] = [], carried: Carried = {}): Own[] {
  const ids = new Set(findingIds);
  const linked = new Set(Object.entries(h.decisions ?? {}).flatMap(([id, d]) => ids.has(id) && d.comment ? [d.comment] : []));
  const before = new Map(earlier.map((e) => [e.key, e]));
  const seen = new Set<string>();
  return h.comments.flatMap((c): Own[] => {
    if (c.hunk === null || (c.id && linked.has(c.id))) return [];
    const key = ownKey(c);
    if (seen.has(key)) return [];
    seen.add(key);
    const posted = before.get(postKey(c)), from = carried[postKey(c)];
    return [{ key, comment: c, ...(posted ? { posted } : {}), ...(from ? { carried: from } : {}) }];
  });
}

/** Summary texts an earlier submit posted: the top-level comment box does not start from one of these again. */
export const postedSummaries = (h: Pick<Human, "comments">, earlier: Earlier[]): Set<string> => {
  const keys = new Set(earlier.map((e) => e.key));
  return new Set(h.comments.filter((c) => c.hunk === null && keys.has(postKey(c))).map((c) => c.text));
};

/** How an entry is labelled in the checklist, the preview and the code: "posted 2026-09-30 (round 1)", "carried over from 1a2b3c4". */
export function ownLabel(o: Pick<Own, "posted" | "carried">): string | undefined {
  if (o.posted) return `posted ${o.posted.at.slice(0, 10)} (round ${o.posted.round})`;
  if (o.carried) return `carried over from ${o.carried.slice(0, 7)}`;
  return undefined;
}
