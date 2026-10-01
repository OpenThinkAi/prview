// "Your previous comments" (re-review R3): on a re-review, every comment your last submit put on the pull request (line
// comments, whole-file comments, the summary), where each one's line is now, and (when the platform can be read) the
// author's replies and whether the thread is resolved. Kept with the stored review (`Review.previous`), never in the
// document or anything posted. Pure: the git and platform reads that feed it are in previous-read.ts.
//
// The items come from the latest kept submission that reached the PR (history.ts): its record's `posted.items`, with
// the platform's ids; a record from before those (a legacy flat file) falls back to its document's comments and head.
// Those comments live here, in the chapter, and are not carried into the new head's layer as comments of your own
// (build.ts): nothing already posted can post again by default.

import type { PostedItem } from "./document.ts";
import type { Submitted } from "./history.ts";
import { pathOfHunk, placedKey } from "./carryover.ts";
import { clean, visible } from "./sanitize.ts";
import { clip } from "./guide.ts";
import { lineMaps, type Mapped, type Since } from "./since.ts";

/** How the reviewed head's lines and files moved to the new head. `line` is since.ts's mapping (renames followed). */
export type Moves = { line: (path: string, line: number) => Mapped; file: (path: string) => { kind: "same" | "changed" | "removed"; path: string } };

/** The moves an old→new diff describes (the "since your review" layer's files). A file it does not list did not move. */
export function movesOf(s: Pick<Since, "files">): Moves {
  const since = { head: "", at: "", files: s.files ?? [] };
  return {
    line: lineMaps(since),
    file(path) {
      const f = since.files.find((x) => (x.oldPath ?? x.path) === path && x.status !== "added");
      if (!f) return { kind: "same", path };
      return f.status === "removed" ? { kind: "removed", path } : { kind: f.hunks.length ? "changed" : "same", path: f.path };
    },
  };
}

/**
 * An item's status, worked out on this machine: a line `unchanged`, `line changed` or `moved` (to `to`); a whole file
 * `unchanged` or `file changed`; either `file removed`; `unknown` when the head you reviewed is not in the clone. A
 * summary has none.
 */
export type Status = "unchanged" | "line changed" | "moved" | "file changed" | "file removed" | "unknown";
/** A few numbered lines of a file at one head, around an item's line. */
export type Snippet = { start: number; lines: string[]; mark?: number };

/** One thing the last submit put on the PR, with its platform ids (document.ts PostedItem) and what is known of it now. */
export type PrevItem = PostedItem & { status?: Status; to?: { path: string; line?: number; side?: "new" | "old" }; old?: Snippet; now?: Snippet };
/**
 * The chapter: the head your last submit reviewed (`head`, `at`, which submit it was: `round`), the PR it went to and
 * the items. `note`: why statuses are unknown (the head you reviewed is not in this clone), when they are.
 */
export type Previous = { head: string; at: string; round: number; url?: string; platform?: string; items: PrevItem[]; note?: string };

/** Did this kept submission reach the PR (or, with no platform, was it written as the review)? A post that failed with nothing through did not. */
const reached = (s: Submitted): boolean => {
  const items = s.submission?.posted?.items ?? [];
  // A submit that only answered earlier threads (earlier.ts) posted no comments of its own: the chapter stays on the one before.
  if (items.length && items.every((i) => i.kind === "reply" || i.kind === "resolve")) return false;
  return !!items.length || !!s.submission?.posted?.ok || !s.submission?.posted;
};

/** The latest submission that reached the PR, from a newest-first list (history.ts submissionsFor), and which round it was. */
export function lastReached(subs: Submitted[]): { sub: Submitted; round: number } | undefined {
  const ok = subs.filter(reached);
  return ok.length ? { sub: ok[0]!, round: ok.length } : undefined;
}

/** What a submission posted: its record's items, else (a record from before them) its document's comments. */
export function itemsOf(s: Submitted): PrevItem[] {
  // Replies and resolves a submit sent on earlier threads (earlier.ts) are answers, not comments of this chapter.
  const items = s.submission?.posted?.items?.filter((i) => i.kind !== "reply" && i.kind !== "resolve");
  if (items?.length) return items.map((i) => ({ ...i }));
  return s.doc.human.comments.map((c): PrevItem => c.hunk === null
    ? { kind: "summary", text: c.text }
    : c.file ? { kind: "file", path: pathOfHunk(c.hunk), text: c.text }
    : { kind: "line", path: pathOfHunk(c.hunk), side: c.side, ...(c.line !== null ? { line: c.line } : {}), text: c.text });
}

/** An item's key as carryover.ts compares comments (postKey): a comment of the layer with this key is this item. */
export const itemKey = (i: PrevItem): string =>
  i.kind === "summary" ? placedKey("", "new", null, i.text) : placedKey(i.path ?? "", i.kind === "file" ? "file" : i.side ?? "new", i.kind === "file" ? null : i.line ?? null, i.text);

/** Each item with its status and new location, from how the files moved; with no moves known, `unknown`. */
export function located(items: PrevItem[], moves: Moves | undefined): PrevItem[] {
  return items.map((i): PrevItem => {
    if (i.kind === "summary" || !i.path) return i;
    if (!moves) return { ...i, status: "unknown" };
    const f = moves.file(i.path);
    if (f.kind === "removed") return { ...i, status: "file removed" };
    if (i.kind === "file") return { ...i, status: f.kind === "changed" ? "file changed" : f.path !== i.path ? "moved" : "unchanged", to: { path: f.path } };
    // A comment on the old side is on a line the PR removed: the new head does not move it.
    if (i.side === "old" || i.line === undefined) return { ...i, status: "unchanged", to: { path: f.path, ...(i.line !== undefined ? { line: i.line, side: "old" as const } : {}) } };
    const m = moves.line(i.path, i.line);
    if (m.kind === "removed") return { ...i, status: "file removed" };
    if (m.kind === "changed") return { ...i, status: "line changed", to: { path: m.path, line: m.near } };
    return { ...i, status: m.line === i.line && m.path === i.path ? "unchanged" : "moved", to: { path: m.path, line: m.line } };
  });
}

/** How an item's place reads: `src/a.ts:12`, `src/a.ts (whole file)`, `summary`. */
export const placeOf = (i: PrevItem): string =>
  i.kind === "summary" ? "summary" : i.kind === "file" ? `${i.path} (whole file)` : `${i.path}${i.line !== undefined ? `:${i.line}` : ""}${i.side === "old" ? " (old side)" : ""}`;

/** The status in words: `moved to L14` (or to another file), `unchanged`, … ; nothing for a summary. */
export function statusText(i: PrevItem): string {
  if (!i.status) return "";
  if (i.status === "unknown") return "status unknown";
  if (i.status !== "moved") return i.status;
  if (i.kind === "file") return `moved to ${i.to?.path}`;
  return i.to?.path && i.to.path !== i.path ? `moved to ${i.to.path}:L${i.to.line}` : `moved to L${i.to?.line}`;
}

// ---------------------------------------------------------------- the platform's side: replies and resolution

/** A reply on an earlier comment's thread: who, when, what (cleaned: it is the author's text, untrusted). */
export type Reply = { author: string; at: string; text: string };
/**
 * What the platform says about one item: `found` it on the PR, its replies, and whether its thread is resolved (undefined:
 * not known). `ids`: the thread as found (GitHub its first comment's id and node id; Azure DevOps the thread and its
 * first comment), which a reply or resolve uses when the submission record has none (earlier.ts).
 */
export type Thread = { found: boolean; replies: Reply[]; resolved?: boolean; ids?: Pick<PostedItem, "comment_id" | "node_id" | "thread_id"> };
/** The read: per item (by index) when it worked, else why not. */
export type Remote = { ok: true; threads: Thread[] } | { ok: false; reason: string };

const text = (v: unknown, n: number) => typeof v === "string" ? clip(clean(v).trim(), n) : "";
const reply = (author: unknown, at: unknown, body: unknown): Reply => ({ author: text(author, 80) || "someone", at: text(at, 40), text: text(body, 4000) });
const sameText = (a: unknown, b: string) => typeof a === "string" && a.trim() === b.trim();

/**
 * GitHub: the PR's review comments (`pulls/<n>/comments`, every page) and each review thread's resolution (GraphQL,
 * keyed by its first comment's id). An item is matched by its recorded comment id, else (a legacy record) by path, line
 * and text; its replies are the comments answering it (`in_reply_to_id`), oldest first. The summary is the review's
 * body on GitHub, which has no thread: not found, no replies.
 */
export function matchGithub(items: PrevItem[], comments: unknown[], resolved: Map<number, boolean> | undefined): Thread[] {
  const all = comments.filter((c): c is Record<string, any> => typeof c === "object" && c !== null && typeof (c as any).id === "number");
  const tops = all.filter((c) => !c.in_reply_to_id);
  const used = new Set<number>();
  return items.map((i): Thread => {
    if (i.kind === "summary") return { found: false, replies: [] };
    const top = (i.comment_id ? tops.find((c) => c.id === i.comment_id) : undefined)
      ?? tops.find((c) => !used.has(c.id) && c.path === i.path && sameText(c.body, i.text) && (i.kind === "file" ? c.subject_type === "file" || c.line == null : (c.original_line ?? c.line) === i.line));
    if (!top) return { found: false, replies: [] };
    used.add(top.id);
    const replies = all.filter((c) => c.in_reply_to_id === top.id).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
      .map((c) => reply(c.user?.login, c.created_at, c.body));
    const r = resolved?.get(top.id);
    const ids = { comment_id: top.id as number, ...(typeof top.node_id === "string" && top.node_id ? { node_id: top.node_id as string } : {}) };
    return { found: true, replies, ...(r !== undefined ? { resolved: r } : {}), ids };
  });
}

/** Azure DevOps: a thread's status that means it is done with. */
const CLOSED = new Set(["fixed", "closed", "wontfix", "bydesign"]);

/**
 * Azure DevOps: the PR's threads. An item is matched by its recorded thread id, else (a legacy record) by path, line and
 * text (the summary: a thread with no file and the same text); its replies are the thread's later comments (not system
 * ones, not deleted); resolved is a status of fixed, closed, won't fix or by design.
 */
export function matchAzure(items: PrevItem[], threads: unknown[]): Thread[] {
  const all = threads.filter((t): t is Record<string, any> => typeof t === "object" && t !== null && typeof (t as any).id === "number" && !(t as any).isDeleted);
  const first = (t: Record<string, any>) => (Array.isArray(t.comments) ? t.comments : []).find((c: any) => c && !c.isDeleted && c.commentType !== "system");
  const lineOf = (t: Record<string, any>) => t.threadContext?.rightFileStart?.line ?? t.threadContext?.leftFileStart?.line;
  const path = (p: unknown) => typeof p === "string" ? p.replace(/^\/+/, "") : undefined;
  const used = new Set<number>();
  return items.map((i): Thread => {
    const t = (i.thread_id ? all.find((x) => x.id === i.thread_id) : undefined) ?? all.find((x) => {
      if (used.has(x.id) || !sameText(first(x)?.content, i.text)) return false;
      if (i.kind === "summary") return !x.threadContext?.filePath;
      return path(x.threadContext?.filePath) === i.path && (i.kind === "file" ? lineOf(x) === undefined : lineOf(x) === i.line);
    });
    if (!t) return { found: false, replies: [] };
    used.add(t.id);
    const head = first(t);
    const replies = (Array.isArray(t.comments) ? t.comments : [])
      .filter((c: any) => c && c !== head && !c.isDeleted && c.commentType !== "system" && (i.comment_id === undefined || c.id !== i.comment_id))
      .sort((a: any, b: any) => String(a.publishedDate).localeCompare(String(b.publishedDate)))
      .map((c: any) => reply(c.author?.displayName ?? c.author?.uniqueName, c.publishedDate, c.content));
    const ids = { thread_id: t.id as number, ...(typeof head?.id === "number" && head.id > 0 ? { comment_id: head.id as number } : {}) };
    return { found: true, replies, ...(typeof t.status === "string" ? { resolved: CLOSED.has(t.status.toLowerCase()) } : {}), ids };
  });
}

/** The platform's side in a few words: `2 replies · resolved`, `no replies · open`, `replies unavailable (<reason>)`, `reading replies…`. */
export function remoteText(remote: Remote | undefined, n: number, item: PrevItem, platform: string | undefined): string {
  if (!platform) return "";
  if (!remote) return "reading replies…";
  if (!remote.ok) return `replies unavailable (${remote.reason})`;
  const t = remote.threads[n];
  if (!t || !t.found) return item.kind === "summary" && platform === "github" ? "" : "not found on the PR";
  const k = t.replies.length;
  return [k ? `${k} repl${k === 1 ? "y" : "ies"}` : "no replies", t.resolved === true ? "resolved" : t.resolved === false ? "open" : ""].filter(Boolean).join(" · ");
}

/** One row of the chapter in the table of contents: place, status, the platform's side, and what you queued on it (earlier.ts queuedText). */
export const rowText = (i: PrevItem, n: number, p: Previous, remote: Remote | undefined, queued = ""): string =>
  [i.kind === "summary" ? "summary" : i.kind === "file" ? `${i.path?.split("/").pop()} (file)` : `${i.path?.split("/").pop()}:${i.line ?? ""}`, statusText(i), remoteText(remote, n, i, p.platform), queued].filter(Boolean).join(" · ");

/** Code as the content area shows it, line for line (not reflowed): the PR's text, its control characters made visible. */
const snippetText = (s: Snippet | undefined, label: string): string => {
  if (!s?.lines.length) return "";
  const w = String(s.start + s.lines.length - 1).length;
  return [label, ...s.lines.map((l, k) => `${s.start + k === s.mark ? "›" : " "} ${String(s.start + k).padStart(w)}  ${visible(l)}`)].join("\n");
};

/** The chapter's overview, for its own row: what it holds and how to read it. */
export function overviewText(p: Previous, remote: Remote | undefined, keys: { open: string; copy: string; reply?: string; resolve?: string }): string {
  const lines = p.items.map((i, n) => `- ${placeOf(i)}${statusText(i) ? ` · ${statusText(i)}` : ""}${remoteText(remote, n, i, p.platform) ? ` · ${remoteText(remote, n, i, p.platform)}` : ""}`);
  return [
    `Your last submit (${p.at.slice(0, 10)}, round ${p.round}, at ${p.head.slice(0, 7)}) posted ${p.items.length} item${p.items.length === 1 ? "" : "s"}. They are not posted again; new comments you write now are new.`,
    lines.join("\n"),
    p.note ?? "",
    `Move onto one to see your text, the code then and now, and the replies; ${keys.open} goes to where it is now in the code, ${keys.copy} copies it.`,
    keys.reply && keys.resolve ? `On one, ${keys.reply} writes a reply and ${keys.resolve} marks its thread resolved: both are queued and go out with your next submit, before the new review.` : "",
  ].filter(Boolean).join("\n\n");
}

/** A stretch of the content area's text: prose is reflowed to its width; `pre` (code) keeps every line and its indentation. */
export type Part = { text: string; pre?: true };

/** One item in the content area: your text, the code then and now, the replies; `copy` is the item itself (place and text). */
export function itemText(i: PrevItem, n: number, p: Previous, remote: Remote | undefined, queued?: { reply?: string; resolve?: boolean; keys: { reply: string; resolve: string } }): { title: string; body: string; copy: string; parts: Part[] } {
  const status = statusText(i), side = remoteText(remote, n, i, p.platform);
  const thread = remote?.ok ? remote.threads[n] : undefined;
  const replies = thread?.replies.length ? ["Replies:", ...thread.replies.map((r) => `${r.author}${r.at ? ` · ${r.at.slice(0, 16).replace("T", " ")}` : ""}\n${r.text}`)].join("\n\n") : "";
  const where = i.to?.line !== undefined && (i.to.line !== i.line || i.to.path !== i.path) ? `Now at ${i.to.path}:${i.to.line}.` : "";
  const parts: Part[] = ([
    { text: `You wrote (${p.at.slice(0, 10)}, at ${p.head.slice(0, 7)}):\n${i.text}` },
    { text: snippetText(i.old, `Then (${p.head.slice(0, 7)}):`), pre: true },
    { text: snippetText(i.now, "Now:"), pre: true },
    { text: where },
    { text: i.status === "unknown" ? p.note ?? "" : "" },
    { text: side ? `On the PR: ${side}.` : "" },
    { text: replies },
    { text: queued ? queuedPart(queued) : "" },
  ] as Part[]).filter((x) => x.text);
  return {
    title: `Your previous comment · ${placeOf(i)}${status ? ` · ${status}` : ""}`,
    body: parts.map((x) => x.text).join("\n\n"), parts,
    copy: `${placeOf(i)}\n\n${i.text}`,
  };
}

/** What is queued on an item for the next submit (earlier.ts), and the keys that change it. */
function queuedPart(q: { reply?: string; resolve?: boolean; keys: { reply: string; resolve: string } }): string {
  const what = [q.reply !== undefined ? `Your reply, queued:\n${q.reply}` : "", q.resolve ? "Resolve its thread: queued." : ""].filter(Boolean);
  if (!what.length) return `${q.keys.reply} writes a reply, ${q.keys.resolve} marks the thread resolved; both go out with your next submit, before the new review.`;
  return [...what, `Sent with your next submit, before the new review. ${q.keys.reply} edits the reply (empty removes it), ${q.keys.resolve} ${q.resolve ? "un-queues the resolve" : "marks the thread resolved"}.`].join("\n\n");
}

// ---------------------------------------------------------------- moving in the chapter

/** Where the cursor is in the chapter: its own row (-1) or item n. */
export type PrevMove = "down" | "up" | "expand" | "collapse";
/**
 * One key in the chapter, which sits above the table of contents' chapters: ↓/↑ walk its row and items (↓ off the last
 * leaves it, `out: "down"`); → expands it, or on an item `enter`s the code there; ← on an item goes up to its row, on
 * the row collapses it. A collapsed chapter is one stop.
 */
export function prevMove(count: number, collapsed: boolean, at: number, move: PrevMove): { at: number; collapsed: boolean; out?: "down"; enter?: true } {
  const last = collapsed ? -1 : count - 1;
  switch (move) {
    case "down": return at < last ? { at: at + 1, collapsed } : { at, collapsed, out: "down" };
    case "up": return { at: Math.max(-1, at - 1), collapsed };
    case "expand": return at >= 0 ? { at, collapsed, enter: true } : collapsed ? { at, collapsed: false } : count ? { at: 0, collapsed } : { at, collapsed };
    case "collapse": return at >= 0 ? { at: -1, collapsed } : { at, collapsed: true };
  }
}
