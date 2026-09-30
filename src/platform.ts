// Posting a submitted review to where the pull request lives. One adapter per platform, chosen by
// the document's `target.platform` and nothing else; a platform with no adapter (or no platform at
// all) is not an error, the written document is then the review.
//
// What is posted is the human's own words and nothing more: the verdict, their summary comments as
// the body, their line comments on their lines. A finding the human decided to block on or comment
// on reaches here only as the line comment they saved for it. Never the write-up, never a finding's
// own text, never a word about prview or any model. Commands run through an injected runner so tests never touch a network.

import type { Comment, Target, Verdict } from "./document.ts";

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

export type Adapter = {
  platform: string;
  /** One line for the submit preview: where this would post, or why it cannot. */
  describe(t: Target, p: Posting): string;
  /** The API calls post would make, as printable text, without making any. */
  dryRun(t: Target, p: Posting): string[];
  /** Post it; throws with a reason the reader can act on. Returns the URL of what was posted when known. */
  post(t: Target, p: Posting, run: Runner, cwd: string): { url?: string };
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
  if (p.verdict !== "approve" && !p.body.trim() && !words) return `${p.verdict === "request_changes" ? "requesting changes" : "a comment"} needs a summary comment (N) or a line comment (n) to post`;
  // The coverage line is opt-in and is never the whole review: there must be words of the human's own beside it.
  if (p.coverage && !p.body.trim() && !words) return "a coverage line needs a summary comment (N) or a line comment (n) to go with it";
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
  };
}

export const github: Adapter = {
  platform: "github",
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
    ];
  },
  post(t, p, run, cwd) {
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
    try {
      // Whole-file comments go after the pending review took the line comments (so a bad one is caught first). One GitHub
      // will not take still reaches the PR, in the summary, under its file name.
      const folded: string[] = [];
      for (const x of p.files ?? []) { try { gh(run, cwd, later.file(x)); } catch { folded.push(`${x.path}: ${x.text}`); } }
      const summary = { ...later.submit, body: { ...(later.submit.body as object), body: [p.body, ...folded, p.coverage].filter(Boolean).join("\n\n") } };
      const done = gh(run, cwd, summary);
      return { url: typeof done?.html_url === "string" ? done.html_url : t.url };
    } catch (e) {
      // Never leave a pending review behind: it would sit half-made on the PR and block the next attempt.
      try { gh(run, cwd, later.discard); } catch {}
      throw e;
    }
  },
};

const ADAPTERS: Record<string, Adapter> = { github };

/** The adapter for a platform, if prview has one. GitLab and Azure DevOps come later, as more entries here. */
export const adapterFor = (platform: string | undefined): Adapter | undefined => platform ? ADAPTERS[platform.toLowerCase()] : undefined;
