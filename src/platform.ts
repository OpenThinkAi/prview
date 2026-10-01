// Posting a submitted review to where the pull request lives. One adapter per platform, chosen by
// the document's `target.platform` and nothing else; a platform with no adapter (or no platform at
// all) is not an error, the written document is then the review. GitHub is here; Azure DevOps is
// src/platforms/azure.ts, registered below.
//
// What is posted is the human's own words and nothing more: the verdict, their summary comments as
// the body, their line comments on their lines. A finding reaches here only as a line comment in the human's layer:
// the one they saved with b or c, or, for a finding they ticked at submit, the finding's text they chose to post
// (submit-flow.ts applySelection). Never the write-up, never a finding's source, never a word about prview or any model. Commands run through an injected runner so tests never touch a network.

import { PostError, type Comment, type PostedItem, type Target, type Verdict } from "./document.ts";
import { azure } from "./platforms/azure.ts";

/** Runs one argv (no shell) and hands back what happened; the real one is `spawn` below. */
export type Runner = (argv: string[], opts: { cwd: string; stdin?: string }) => { exit: number | null; stdout: string; stderr: string };

export const spawn: Runner = (argv, { cwd, stdin }) => {
  try {
    const p = Bun.spawnSync(argv, { cwd, stdin: stdin === undefined ? "ignore" : Buffer.from(stdin), stdout: "pipe", stderr: "pipe" });
    return { exit: p.exitCode, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
  } catch (e) { return { exit: null, stdout: "", stderr: (e as Error).message }; }
};

/**
 * A reply to, or a resolve of, an earlier thread (earlier.ts), queued in a re-review and sent before the review: `text`
 * is the reply (the reader's own words; empty for a resolve), `place` where the comment it answers is, `key` its item.
 * The ids are the thread's: GitHub the review comment (`comment_id`, `node_id`); Azure DevOps the thread and its first comment.
 */
export type EarlierPost = {
  kind: "reply" | "resolve"; text: string; place: string; key: string; path?: string; line?: number; side?: "new" | "old";
  comment_id?: number; node_id?: string; thread_id?: number;
};

/** The human's layer, ready to post: verdict, the summary (general comments) and the line comments. */
export type Posting = {
  verdict: Verdict; body: string; /** The coverage line, when the human chose to add it: appended to the body, never counted as words of their own. */ coverage?: string; comments: { path: string; side: "new" | "old"; line: number; text: string }[];
  /** Comments on a whole file rather than a line: posted as file-level comments where the platform has them, else folded into the summary. */
  files?: { path: string; text: string }[];
  /** Replies and resolves on earlier threads (a re-review), sent first, in this order. */
  earlier?: EarlierPost[];
};

/**
 * A comment verdict with no words of its own but replies or resolves on earlier threads: only those go out, and no
 * review (GitHub will not take an empty comment review; Azure DevOps casts no vote for a comment anyway).
 */
export const onlyEarlier = (p: Posting): boolean =>
  p.verdict === "comment" && !p.body.trim() && !p.comments.length && !p.files?.length && !p.coverage && !!p.earlier?.length;

/** The earlier threads' part of a check on posted text: a reply is the reader's words, and each has the ids it needs. */
export function earlierProblem(p: Posting, platform: "github" | "azure-devops"): string | undefined {
  for (const e of p.earlier ?? []) {
    if (e.kind === "reply" && !e.text.trim()) return `the reply to ${e.place} is empty`;
    if (platform === "github" && !e.comment_id) return `${e.kind === "reply" ? "the reply to" : "resolving"} ${e.place} has no GitHub comment to act on`;
    if (platform === "azure-devops" && (!e.thread_id || (e.kind === "reply" && !e.comment_id))) return `${e.kind === "reply" ? "the reply to" : "resolving"} ${e.place} has no Azure DevOps thread to act on`;
  }
  return undefined;
}

/** The earlier threads in a few words, for a describe line: `2 replies and 1 resolve on earlier threads, first`. */
export function earlierText(p: Posting): string {
  const r = p.earlier?.filter((e) => e.kind === "reply").length ?? 0, s = (p.earlier?.length ?? 0) - r;
  const parts = [r ? `${r} repl${r === 1 ? "y" : "ies"}` : "", s ? `${s} resolve${s === 1 ? "" : "s"}` : ""].filter(Boolean);
  return parts.length ? `${parts.join(" and ")} on earlier threads` : "";
}

/** What reached the PR before a failure, for its message. */
const wentOut = (items: PostedItem[]) => items.map((i) => `${i.kind === "reply" ? "reply to" : i.kind === "resolve" ? "resolved" : `${i.kind} comment on`} ${i.path ? `${i.path}${i.line ? `:${i.line}` : ""}` : "the summary"}`).join("; ");

/** What a post put on the PR: its URL when known, and each posted item with the platform's ids (see PostedItem). */
export type Posted = { url?: string; /** GitHub: the submitted review's id. */ review_id?: number; items?: PostedItem[] };

export type Adapter = {
  platform: string;
  /** The verdicts this platform takes, in the order the submit radio lists them. */
  verdicts: Verdict[];
  /** One line for the submit preview: where this would post, or why it cannot. */
  describe(t: Target, p: Posting): string;
  /** The API calls post would make, as printable text, without making any. */
  dryRun(t: Target, p: Posting): string[];
  /**
   * Post it; rejects with a reason the reader can act on (a PostError when something already reached the PR, listing
   * it). Resolves to what was posted: the URL when known and every item with its ids. Async: a platform reached over
   * HTTP awaits each call.
   */
  post(t: Target, p: Posting, run: Runner, cwd: string): Promise<Posted>;
};

/**
 * The posting from a document's human layer. A comment on a hunk but no line, or on a hunk this diff
 * does not have, goes into the body under its file name, so nothing the human wrote is left out.
 */
export function postingOf(
  verdict: Verdict, comments: Comment[], pathOf: (hunk: string) => string | undefined,
  /** What the human chose to add: a coverage line. */
  extra: { coverage?: string } = {},
): Posting {
  const body: string[] = [], placed: Posting["comments"] = [], files: NonNullable<Posting["files"]> = [];
  for (const c of comments) {
    const path = c.hunk ? pathOf(c.hunk) : undefined;
    if (!c.hunk) body.push(c.text);
    else if (path && c.file) files.push({ path, text: c.text });
    else if (path && c.line !== null) placed.push({ path, side: c.side, line: c.line, text: c.text });
    else body.push(`${path ?? c.hunk.split("@")[0]}: ${c.text}`);
  }
  return { verdict, body: body.join("\n\n"), ...(extra.coverage ? { coverage: extra.coverage } : {}), comments: placed, ...(files.length ? { files } : {}) };
}

// ---------------------------------------------------------------- GitHub

const EVENT = { approve: "APPROVE", request_changes: "REQUEST_CHANGES", comment: "COMMENT" } as const;
const prOf = (t: Target) => t.url?.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);

/** Why GitHub would refuse this posting before anything is sent, or undefined when it can go. */
function githubProblem(t: Target, p: Posting): string | undefined {
  if (!prOf(t)) return "no GitHub pull request URL in the document's target";
  const earlier = earlierProblem(p, "github");
  if (earlier) return earlier;
  if (onlyEarlier(p)) return undefined;
  // GitHub wants words with a change request or a comment; prview never writes them for you.
  const words = p.comments.length + (p.files?.length ?? 0);
  if (p.verdict !== "approve" && !p.body.trim() && !words) return `${p.verdict === "request_changes" ? "requesting changes" : "a comment"} needs a top-level comment or a ticked finding to post`;
  // The coverage line is opt-in and is never the whole review: there must be words of the human's own beside it.
  if (p.coverage && !p.body.trim() && !words) return "a coverage line needs a top-level comment or a ticked finding to go with it";
  return undefined;
}

/** One gh call as the adapter makes it: the argv after `gh api`, and the JSON body sent on stdin if any. */
type Call = { method: string; path: string; body?: unknown };
const argvOf = (c: Call) => ["gh", "api", "--method", c.method, c.path, ...(c.body === undefined ? [] : ["--input", "-"])];

/** Runs one call; a failure carries GitHub's own reason. */
function gh(run: Runner, cwd: string, c: Call): any {
  const r = run(argvOf(c), { cwd, ...(c.body === undefined ? {} : { stdin: JSON.stringify(c.body) }) });
  if (r.exit !== 0) {
    let msg = (r.stderr || r.stdout).trim();
    try { const j = JSON.parse(r.stdout); if (typeof j?.message === "string") msg = [j.message, ...(Array.isArray(j.errors) ? j.errors.map(String) : [])].join(": "); } catch {}
    throw new Error(`gh api failed${r.exit === null ? "" : ` (exit ${r.exit})`}: ${msg.split("\n")[0] || "no output"}`);
  }
  try { return JSON.parse(r.stdout); } catch { return {}; }
}

/** The calls, in order. The review is made pending with its line comments, then submitted with the verdict and the summary. */
function githubCalls(t: Target, p: Posting, reviewId: number | string = "<review id>") {
  const [, owner, repo, number] = prOf(t)!;
  const pr = `repos/${owner}/${repo}/pulls/${number}`;
  return {
    head: { method: "GET", path: pr } as Call,
    // No `event`: GitHub keeps a review without one pending, so nothing is visible until it is submitted.
    create: { method: "POST", path: `${pr}/reviews`, body: {
      commit_id: t.head,
      comments: p.comments.map((c) => ({ path: c.path, line: c.line, side: c.side === "old" ? "LEFT" : "RIGHT", body: c.text })),
    } } as Call,
    submit: { method: "POST", path: `${pr}/reviews/${reviewId}/events`, body: { event: EVENT[p.verdict], body: [p.body, p.coverage].filter(Boolean).join("\n\n") } } as Call,
    // A comment on a whole file: GitHub takes these one at a time, outside a pending review (subject_type file).
    file: (x: { path: string; text: string }): Call => ({ method: "POST", path: `${pr}/comments`, body: { commit_id: t.head, path: x.path, subject_type: "file", body: x.text } }),
    discard: { method: "DELETE", path: `${pr}/reviews/${reviewId}` } as Call,
    // Read back after the submit: the review's comments, for their ids (GitHub's create does not return them).
    comments: (page: number): Call => ({ method: "GET", path: `${pr}/reviews/${reviewId}/comments?per_page=100&page=${page}` }),
    // Earlier threads: a reply to a review comment, and (GraphQL) the review threads, to find a comment's, and resolving one.
    reply: (e: EarlierPost): Call => ({ method: "POST", path: `${pr}/comments/${e.comment_id ?? "<comment id>"}/replies`, body: { body: e.text } }),
    threads: (cursor: string | null): Call => ({ method: "POST", path: "graphql", body: { query: THREAD_IDS, variables: { o: owner, r: repo, n: Number(number), c: cursor } } }),
    resolve: (threadId: string): Call => ({ method: "POST", path: "graphql", body: { query: RESOLVE, variables: { id: threadId } } }),
  };
}

/** The PR's review threads, a page at a time, each with its first comment's ids: how a comment's thread is found. */
const THREAD_IDS = "query($o:String!,$r:String!,$n:Int!,$c:String){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:100,after:$c){pageInfo{hasNextPage endCursor} nodes{id isResolved comments(first:1){nodes{id databaseId}}}}}}}";
const RESOLVE = "mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}";

/** A GraphQL call through gh: GitHub can answer 200 with `errors`, which is a failure all the same. */
function graphql(run: Runner, cwd: string, c: Call): any {
  const j = gh(run, cwd, c);
  if (Array.isArray(j?.errors) && j.errors.length) throw new Error(`gh api graphql failed: ${String(j.errors[0]?.message ?? "an error").split("\n")[0]}`);
  return j;
}

/**
 * Sends the earlier threads' replies and resolves, in order, recording each as it goes out. A resolve finds its review
 * thread from the comment (its node id, else its id) among the PR's threads, read once. The first failure stops it: a
 * PostError carrying what already went out.
 */
function githubEarlier(run: Runner, cwd: string, c: ReturnType<typeof githubCalls>, earlier: EarlierPost[]): PostedItem[] {
  const items: PostedItem[] = [];
  let threads: { id: string; node?: string; db?: number }[] | undefined;
  const threadOf = (e: EarlierPost): string | undefined => {
    if (!threads) {
      threads = [];
      let cursor: string | null = null;
      for (let page = 0; page < 20; page++) {
        const t: any = graphql(run, cwd, c.threads(cursor))?.data?.repository?.pullRequest?.reviewThreads;
        for (const n of Array.isArray(t?.nodes) ? t.nodes : []) {
          const first = n?.comments?.nodes?.[0];
          if (typeof n?.id === "string") threads.push({ id: n.id, ...(typeof first?.id === "string" ? { node: first.id } : {}), ...(typeof first?.databaseId === "number" ? { db: first.databaseId } : {}) });
        }
        if (!t?.pageInfo?.hasNextPage || typeof t.pageInfo.endCursor !== "string") break;
        cursor = t.pageInfo.endCursor;
      }
    }
    return (e.node_id ? threads.find((x) => x.node === e.node_id) : undefined)?.id ?? threads.find((x) => x.db === e.comment_id)?.id;
  };
  for (const e of earlier) {
    const where = { ...(e.path ? { path: e.path } : {}), ...(e.line ? { line: e.line } : {}), ...(e.side ? { side: e.side } : {}) };
    try {
      if (e.kind === "reply") {
        const got = gh(run, cwd, c.reply(e));
        items.push({ kind: "reply", ...where, text: e.text, reply_to: e.comment_id!, ...commentIds(got) });
      } else {
        const id = threadOf(e);
        if (!id) throw new Error("its review thread is not on the pull request");
        graphql(run, cwd, c.resolve(id));
        items.push({ kind: "resolve", ...where, text: "", comment_id: e.comment_id!, thread_node_id: id });
      }
    } catch (err) {
      const what = `${e.kind === "reply" ? "the reply to" : "resolving"} ${e.place}`;
      throw new PostError(`${what} failed: ${(err as Error).message}. ${items.length ? `Already posted (left in place): ${wentOut(items)}` : "Nothing was posted"}. The review was not posted.`, items);
    }
  }
  return items;
}

/** A GitHub id as a number, or undefined. */
const numId = (v: unknown): number | undefined => {
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : undefined;
};
/** A posted GitHub comment's ids, from what the API returned for it. */
const commentIds = (j: any): Pick<PostedItem, "comment_id" | "node_id"> => {
  const id = numId(j?.id);
  return { ...(id ? { comment_id: id } : {}), ...(typeof j?.node_id === "string" && j.node_id ? { node_id: j.node_id } : {}) };
};

/**
 * Each line comment's ids, matched from the review's comments as GitHub lists them: same path, line, side and text
 * first, then same path and text, each used once. A comment it cannot match (or a read that fails) has no ids; the
 * review id is still known, and a later re-review can match by path, line and text.
 */
function lineIds(run: Runner, cwd: string, c: ReturnType<typeof githubCalls>, posted: Posting["comments"]): Pick<PostedItem, "comment_id" | "node_id">[] {
  if (!posted.length) return []; // nothing to read back
  const listed: any[] = [];
  try {
    for (let page = 1; page <= 30; page++) {
      const got = gh(run, cwd, c.comments(page));
      if (!Array.isArray(got)) break;
      listed.push(...got);
      if (got.length < 100) break;
    }
  } catch { return posted.map(() => ({})); }
  const used = new Set<number>();
  const take = (ok: (x: any) => boolean) => { const i = listed.findIndex((x, k) => !used.has(k) && ok(x)); if (i < 0) return undefined; used.add(i); return listed[i]; };
  const same = (x: any, q: Posting["comments"][number]) => x?.path === q.path && x?.body === q.text;
  const exact = posted.map((q) => take((x) => same(x, q) && (x.line ?? x.original_line) === q.line && x.side === (q.side === "old" ? "LEFT" : "RIGHT")));
  return posted.map((q, i) => commentIds(exact[i] ?? take((x) => same(x, q))));
}

export const github: Adapter = {
  platform: "github",
  verdicts: ["approve", "request_changes", "comment"],
  describe(t, p) {
    const why = githubProblem(t, p);
    if (why) return `not posted: ${why}`;
    const n = p.comments.length, w = p.files?.length ?? 0, first = earlierText(p);
    if (onlyEarlier(p)) return `posts to ${t.url} with gh: only ${first} (no review: a comment with no words of its own)`;
    return `posts to ${t.url} with gh: ${first ? `first ${first}; then ` : ""}${EVENT[p.verdict].toLowerCase().replace("_", " ")}${p.body.trim() ? ", your summary" : ""}${n ? `, ${n} line comment${n === 1 ? "" : "s"}` : ""}${w ? `, ${w} whole-file comment${w === 1 ? "" : "s"}` : ""}${p.coverage ? ", a coverage line" : ""}`;
  },
  dryRun(t, p) {
    const why = githubProblem(t, p);
    if (why) return [`would not post: ${why}`];
    const c = githubCalls(t, p);
    const show = (x: Call, note: string) => [`# ${note}`, `gh api --method ${x.method} ${x.path}${x.body === undefined ? "" : " --input -"}`, ...(x.body === undefined ? [] : [JSON.stringify(x.body, null, 2)])].join("\n");
    const earlier = (p.earlier ?? []).flatMap((e) => e.kind === "reply"
      ? [show(c.reply(e), `reply to your earlier comment on ${e.place} (sent before the review)`)]
      : [show(c.threads(null), `find the review thread of your earlier comment on ${e.place} (paged; read once)`), show(c.resolve("<thread id>"), `resolve that thread (sent before the review)`)]);
    if (onlyEarlier(p)) return [show(c.head, `the head must still be ${t.head}; if it moved, nothing is posted`), ...earlier, "# no review: a comment with no words of its own posts only the earlier threads"];
    return [
      show(c.head, `the head must still be ${t.head}; if it moved, nothing is posted`),
      ...earlier,
      show(c.create, "a pending review holding the line comments (side RIGHT is the new file, LEFT the old)"),
      ...(p.files ?? []).map((x) => show(c.file(x), "a comment on the whole file; if GitHub refuses it, it goes into the summary instead")),
      show(c.submit, "submit it with the verdict"),
      ...(p.comments.length ? [show(c.comments(1), "read back the review's comments (paged) for their ids, kept in the submission record")] : []),
    ];
  },
  async post(t, p, run, cwd) {
    const why = githubProblem(t, p);
    if (why) throw new Error(why);
    const c = githubCalls(t, p);
    // A comment anchored to line 11 of one commit is wrong on another: refuse rather than mis-anchor.
    const now = gh(run, cwd, c.head)?.head?.sha;
    if (typeof now !== "string" || !now) throw new Error("could not read the pull request's head commit");
    if (now !== t.head) throw new Error(`the pull request head is now ${now.slice(0, 8)}, but this review is of ${t.head.slice(0, 8)}: reopen it to review the new commits`);
    // Earlier threads first: a failure there stops everything, the review included.
    const earlier = githubEarlier(run, cwd, c, p.earlier ?? []);
    if (onlyEarlier(p)) return { url: t.url, items: earlier };
    try { return await githubReview(t, p, run, cwd, c, earlier); }
    catch (e) {
      // Whatever went out before the failure, the replies and resolves included, stays on the PR and is recorded.
      if (!earlier.length) throw e;
      const later = e instanceof PostError ? e.items : [];
      throw new PostError(`${(e as Error).message} (already posted on earlier threads, left in place: ${wentOut(earlier)})`, [...earlier, ...later]);
    }
  },
};

/** The review itself, after the head check and the earlier threads: pending review, whole-file comments, submit, ids. */
async function githubReview(t: Target, p: Posting, run: Runner, cwd: string, c: ReturnType<typeof githubCalls>, earlier: PostedItem[]): Promise<Posted> {
  const id = gh(run, cwd, c.create)?.id;
  if (typeof id !== "number" && typeof id !== "string") throw new Error("gh api did not return the pending review's id");
  const later = githubCalls(t, p, id);
  const fileItems: PostedItem[] = [];
  let body: string, done: any;
  try {
    // Whole-file comments go after the pending review took the line comments (so a bad one is caught first). One GitHub
    // will not take still reaches the PR, in the summary, under its file name.
    const folded: string[] = [];
    for (const x of p.files ?? []) {
      let got: any;
      try { got = gh(run, cwd, later.file(x)); } catch { folded.push(`${x.path}: ${x.text}`); continue; }
      fileItems.push({ kind: "file", path: x.path, text: x.text, ...commentIds(got) });
    }
    body = [p.body, ...folded, p.coverage].filter(Boolean).join("\n\n");
    const summary = { ...later.submit, body: { ...(later.submit.body as object), body } };
    done = gh(run, cwd, summary);
  } catch (e) {
    // Never leave a pending review behind: it would sit half-made on the PR and block the next attempt.
    try { gh(run, cwd, later.discard); } catch {}
    // The whole-file comments are not part of the review: those already taken stay on the PR, and are recorded.
    throw fileItems.length ? new PostError((e as Error).message, fileItems) : e;
  }
  // Submitted: what is on the PR now, with the ids a later re-review answers and resolves by.
  const review_id = numId(id) ?? numId(done?.id);
  const rid = review_id ? { review_id } : {};
  const ids = lineIds(run, cwd, later, p.comments);
  const items: PostedItem[] = [
    ...earlier,
    ...p.comments.map((q, i): PostedItem => ({ kind: "line", path: q.path, line: q.line, side: q.side, text: q.text, ...rid, ...ids[i] })),
    ...fileItems,
    ...(body.trim() ? [{ kind: "summary" as const, text: body, ...rid }] : []),
  ];
  return { url: typeof done?.html_url === "string" ? done.html_url : t.url, ...rid, items };
}

const ADAPTERS: Record<string, Adapter> = { github, "azure-devops": azure };

/** The adapter for a platform, if prview has one: keyed by the same id as its read side in registry.ts. More platforms are more entries here. */
export const adapterFor = (platform: string | undefined): Adapter | undefined => platform ? ADAPTERS[platform.toLowerCase()] : undefined;

/** Every verdict a document can record: what the submit radio offers when no adapter posts (the file is the review). */
export const ALL_VERDICTS: Verdict[] = ["approve", "request_changes", "comment"];
/** The verdicts the submit radio offers for a platform: its adapter's, or every one the document can record. */
export const verdictsFor = (platform: string | undefined): Verdict[] => adapterFor(platform)?.verdicts ?? ALL_VERDICTS;
