// Answering earlier threads in a re-review (R5): from an item of "your previous comments" (previous.ts), `r` writes a
// reply in the reader's own words and the resolve key marks its thread resolved. Neither goes out at once: both are
// queued with the stored review (`Review.earlier`, never the document) and sent with the next submit, BEFORE the new
// review's comments, by the platform's adapter (platform.ts for GitHub, platforms/azure.ts for Azure DevOps), which
// also holds the reply's text to the same posted-text check as every comment (githubProblem / azureProblem).
//
// A reply or resolve needs the platform's ids for the thread: the submission record's (R1) when it has them, else the
// ones the previous-comments read matched on the PR (a record from before ids were kept). With neither, it says why
// it cannot. Pure: the TUI queues, the submit flow lists, submit.ts sends and records.

import type { PostedItem } from "./document.ts";
import type { EarlierPost } from "./platform.ts";
import { placeOf, type PrevItem, type Thread } from "./previous.ts";
import { clean } from "./sanitize.ts";
import { clip } from "./guide.ts";

/** The platform ids a reply or resolve acts on: GitHub the review comment (`comment_id`, `node_id`); Azure DevOps the thread and its first comment. */
export type ThreadIds = Pick<PostedItem, "comment_id" | "node_id" | "thread_id">;

/**
 * What the reader queued on one earlier item: a reply (their words), a resolve, or both. `key` is the item's
 * (previous.ts itemKey), `place` and `line`/`path` where it was, `ids` the thread's, worked out when it was queued.
 */
export type EarlierAct = { key: string; place: string; path?: string; line?: number; side?: "new" | "old"; ids: ThreadIds; reply?: string; resolve?: true };
/** The queue, kept with the review: the head of the submission the items came from, so a newer submit's chapter drops it. */
export type EarlierQueue = { head: string; acts: EarlierAct[] };

const PLATFORMS = new Set(["github", "azure-devops"]);

/**
 * The thread an item's reply or resolve goes to: its recorded ids, else (a legacy record) what the read matched on the
 * PR; or why there is none. `what` is the action in words, for the reason.
 */
export function threadOf(item: PrevItem, thread: Thread | undefined, platform: string | undefined, remoteRead: "pending" | "failed" | "ok", what: "reply to" | "resolve"): { ids: ThreadIds } | { why: string } {
  if (!platform || !PLATFORMS.has(platform)) return { why: `cannot ${what} it: answering earlier threads is not on ${platform ?? "a review with no platform"} yet` };
  if (item.kind === "summary" && platform === "github") return { why: `cannot ${what} the summary: on GitHub it is the review's body, which has no thread` };
  const own: ThreadIds = platform === "github"
    ? { ...(item.comment_id ? { comment_id: item.comment_id } : {}), ...(item.node_id ? { node_id: item.node_id } : {}) }
    : { ...(item.thread_id ? { thread_id: item.thread_id } : {}), ...(item.comment_id ? { comment_id: item.comment_id } : {}) };
  const enough = (x: ThreadIds) => platform === "github" ? !!x.comment_id : !!x.thread_id && !!x.comment_id;
  if (enough(own)) return { ids: own };
  if (thread?.found && thread.ids && enough(thread.ids)) return { ids: thread.ids };
  const name = platform === "github" ? "GitHub" : "Azure DevOps";
  if (remoteRead === "pending") return { why: `cannot ${what} it yet: your submit did not record its ${name} id, and the PR's threads are still being read` };
  if (remoteRead === "failed") return { why: `cannot ${what} it: your submit did not record its ${name} id, and the PR's threads could not be read to find it` };
  return { why: `cannot ${what} it: your submit did not record its ${name} id, and no thread on the PR matches it (same place and text)` };
}

/** The reader's queued act on an item, if any. */
export const actOf = (q: EarlierQueue | undefined, key: string): EarlierAct | undefined => q?.acts.find((a) => a.key === key);

/** A fresh act for an item, before a reply or resolve is put on it. */
const freshAct = (item: PrevItem, key: string, ids: ThreadIds): EarlierAct => ({
  key, place: placeOf(item), ids, ...(item.path ? { path: item.path } : {}), ...(item.line !== undefined ? { line: item.line } : {}), ...(item.side ? { side: item.side } : {}),
});

/** The queue with `act` in place of the item's (none when it holds nothing any more), in the order the items were first acted on. */
function put(q: EarlierQueue | undefined, head: string, key: string, act: EarlierAct | undefined): EarlierQueue | undefined {
  const acts = (q && q.head === head ? q.acts : []);
  const i = acts.findIndex((a) => a.key === key);
  const keep = act && (act.reply !== undefined || act.resolve) ? act : undefined;
  const next = i < 0 ? (keep ? [...acts, keep] : acts) : keep ? acts.map((a, k) => k === i ? keep : a) : acts.filter((_, k) => k !== i);
  return next.length ? { head, acts: next } : undefined;
}

/** A reply typed for an item, as it is kept: the reader's words, control characters gone; blank removes the reply. */
export const replyText = (s: string): string => clip(clean(s).trim(), 20000);

/** `r` saved: the reply set, changed, or (blank) removed. */
export function setReply(q: EarlierQueue | undefined, head: string, item: PrevItem, key: string, ids: ThreadIds, text: string): EarlierQueue | undefined {
  const cur = actOf(q?.head === head ? q : undefined, key) ?? freshAct(item, key, ids);
  const t = replyText(text);
  const { reply: _, ...rest } = cur;
  return put(q, head, key, t ? { ...rest, ids, reply: t } : rest);
}

/** The resolve key: on, or off again when it was on. */
export function toggleResolve(q: EarlierQueue | undefined, head: string, item: PrevItem, key: string, ids: ThreadIds): EarlierQueue | undefined {
  const cur = actOf(q?.head === head ? q : undefined, key) ?? freshAct(item, key, ids);
  const { resolve, ...rest } = cur;
  return put(q, head, key, resolve ? rest : { ...rest, ids, resolve: true });
}

/** What is queued on an item, in a few words: `reply queued · resolve queued`. */
export const queuedText = (a: EarlierAct | undefined): string => [a?.reply !== undefined ? "reply queued" : "", a?.resolve ? "resolve queued" : ""].filter(Boolean).join(" · ");

// ---------------------------------------------------------------- the submit flow and what posts

/** The submit checklist's entries for the queue: a reply and a resolve are ticked (and unticked) on their own. */
export const replyKey = (a: EarlierAct) => `\0reply\0${a.key}`;
export const resolveKey = (a: EarlierAct) => `\0resolve\0${a.key}`;
export const isEarlierKey = (id: string) => id.startsWith("\0reply\0") || id.startsWith("\0resolve\0");
/** Every checklist key of the queue, in the order they are sent: each item's reply, then its resolve. */
export const earlierKeys = (q: EarlierQueue | undefined): string[] => (q?.acts ?? []).flatMap((a) => [...(a.reply !== undefined ? [replyKey(a)] : []), ...(a.resolve ? [resolveKey(a)] : [])]);

/**
 * What posts on earlier threads, in order (each item's reply before its resolve, so the reply lands on an open thread).
 * With a selection, only the ticked ones: an entry the checklist listed and left unticked stays queued and does not post.
 */
export function earlierPosts(q: EarlierQueue | undefined, sel?: { listed: string[]; include: string[] }): EarlierPost[] {
  const on = (k: string) => !sel || !sel.listed.includes(k) || sel.include.includes(k);
  const where = (a: EarlierAct) => ({ place: a.place, ...(a.path ? { path: a.path } : {}), ...(a.line !== undefined ? { line: a.line } : {}), ...(a.side ? { side: a.side } : {}), ...a.ids });
  return (q?.acts ?? []).flatMap((a): EarlierPost[] => [
    ...(a.reply !== undefined && on(replyKey(a)) ? [{ kind: "reply" as const, text: a.reply, key: a.key, ...where(a) }] : []),
    ...(a.resolve && on(resolveKey(a)) ? [{ kind: "resolve" as const, text: "", key: a.key, ...where(a) }] : []),
  ]);
}

/**
 * The queue after a submit: what went out leaves it. The adapters send the earlier posts in order and stop at the first
 * failure, recording each one sent, so the ones that went out are the first as many as the record has replies and
 * resolves; an unticked one, and any after a failure, stay queued for the next submit.
 */
export function afterSubmit(q: EarlierQueue | undefined, posts: EarlierPost[], items: PostedItem[]): EarlierQueue | undefined {
  if (!q) return q;
  const n = items.filter((i) => i.kind === "reply" || i.kind === "resolve").length;
  let out: EarlierQueue | undefined = q;
  for (const p of posts.slice(0, n)) {
    const a = actOf(out, p.key);
    if (!a) continue;
    const { reply: _r, resolve: _s, ...rest } = a;
    const next: EarlierAct = { ...rest, ...(p.kind === "reply" ? (a.resolve ? { resolve: true as const } : {}) : (a.reply !== undefined ? { reply: a.reply } : {})) };
    out = put(out, q.head, p.key, next);
  }
  return out;
}

/** A stored queue, re-read: anything that is not one dropped. */
export function earlierOf(v: unknown): EarlierQueue | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.head !== "string" || !/^[0-9a-f]{7,64}$/i.test(o.head) || !Array.isArray(o.acts)) return undefined;
  const id = (x: unknown) => typeof x === "number" && Number.isSafeInteger(x) && x > 0 ? x : undefined;
  const acts = o.acts.flatMap((a: any): EarlierAct[] => {
    if (typeof a?.key !== "string" || typeof a.place !== "string") return [];
    const ids: ThreadIds = { ...(id(a.ids?.comment_id) ? { comment_id: id(a.ids.comment_id) } : {}), ...(typeof a.ids?.node_id === "string" && a.ids.node_id ? { node_id: clip(a.ids.node_id, 200) } : {}), ...(id(a.ids?.thread_id) ? { thread_id: id(a.ids.thread_id) } : {}) };
    const reply = typeof a.reply === "string" ? replyText(a.reply) : "";
    if (!reply && a.resolve !== true) return [];
    return [{
      key: a.key, place: clip(clean(a.place), 1000), ids,
      ...(typeof a.path === "string" ? { path: a.path } : {}), ...(id(a.line) ? { line: a.line } : {}), ...(a.side === "new" || a.side === "old" ? { side: a.side } : {}),
      ...(reply ? { reply } : {}), ...(a.resolve === true ? { resolve: true as const } : {}),
    }];
  });
  return acts.length ? { head: o.head, acts } : undefined;
}

/** The queue as it carries to a reopened review: only while the chapter is of the same submission, and only its items. */
export function keepQueue(q: EarlierQueue | undefined, head: string | undefined, keys: ReadonlySet<string>): EarlierQueue | undefined {
  if (!q || !head || q.head !== head) return undefined;
  const acts = q.acts.filter((a) => keys.has(a.key));
  return acts.length ? { head, acts } : undefined;
}
