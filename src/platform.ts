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

/** The human's layer, ready to post: verdict, the summary (general comments) and the line comments. */
export type Posting = {
  verdict: Verdict; body: string; /** The coverage line, when the human chose to add it: appended to the body, never counted as words of their own. */ coverage?: string; comments: { path: string; side: "new" | "old"; line: number; text: string }[];
  /** Comments on a whole file rather than a line: posted as file-level comments where the platform has them, else folded into the summary. */
  files?: { path: string; text: string }[];
};

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
  };
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
    const n = p.comments.length, w = p.files?.length ?? 0;
    return `posts to ${t.url} with gh: ${EVENT[p.verdict].toLowerCase().replace("_", " ")}${p.body.trim() ? ", your summary" : ""}${n ? `, ${n} line comment${n === 1 ? "" : "s"}` : ""}${w ? `, ${w} whole-file comment${w === 1 ? "" : "s"}` : ""}${p.coverage ? ", a coverage line" : ""}`;
  },
  dryRun(t, p) {
    const why = githubProblem(t, p);
    if (why) return [`would not post: ${why}`];
    const c = githubCalls(t, p);
    const show = (x: Call, note: string) => [`# ${note}`, `gh api --method ${x.method} ${x.path}${x.body === undefined ? "" : " --input -"}`, ...(x.body === undefined ? [] : [JSON.stringify(x.body, null, 2)])].join("\n");
    return [
      show(c.head, `the head must still be ${t.head}; if it moved, nothing is posted`),
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
      ...p.comments.map((q, i): PostedItem => ({ kind: "line", path: q.path, line: q.line, side: q.side, text: q.text, ...rid, ...ids[i] })),
      ...fileItems,
      ...(body.trim() ? [{ kind: "summary" as const, text: body, ...rid }] : []),
    ];
    return { url: typeof done?.html_url === "string" ? done.html_url : t.url, ...rid, items };
  },
};

const ADAPTERS: Record<string, Adapter> = { github, "azure-devops": azure };

/** The adapter for a platform, if prview has one: keyed by the same id as its read side in registry.ts. More platforms are more entries here. */
export const adapterFor = (platform: string | undefined): Adapter | undefined => platform ? ADAPTERS[platform.toLowerCase()] : undefined;

/** Every verdict a document can record: what the submit radio offers when no adapter posts (the file is the review). */
export const ALL_VERDICTS: Verdict[] = ["approve", "request_changes", "comment"];
/** The verdicts the submit radio offers for a platform: its adapter's, or every one the document can record. */
export const verdictsFor = (platform: string | undefined): Verdict[] => adapterFor(platform)?.verdicts ?? ALL_VERDICTS;
