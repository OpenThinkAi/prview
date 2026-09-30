// Posting a submitted review to where the pull request lives. One adapter per platform, chosen by
// the document's `target.platform` and nothing else; a platform with no adapter (or no platform at
// all) is not an error, the written document is then the review.
//
// What is posted is the human's own words and nothing more: the verdict, their summary comments as
// the body, their line comments on their lines. Never the write-up, never a finding, never a word
// about prview or any model. Commands run through an injected runner so tests never touch a network.

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
export type Posting = { verdict: Verdict; body: string; comments: { path: string; side: "new" | "old"; line: number; text: string }[] };

export type Adapter = {
  platform: string;
  /** One line for the submit preview: where this would post, or why it cannot. */
  describe(t: Target, p: Posting): string;
  /** Post it; throws with a reason the reader can act on. Returns the URL of what was posted when known. */
  post(t: Target, p: Posting, run: Runner, cwd: string): { url?: string };
};

/**
 * The posting from a document's human layer. A comment on a hunk but no line, or on a hunk this diff
 * does not have, goes into the body under its file name, so nothing the human wrote is left out.
 */
export function postingOf(verdict: Verdict, comments: Comment[], pathOf: (hunk: string) => string | undefined): Posting {
  const body: string[] = [], placed: Posting["comments"] = [];
  for (const c of comments) {
    const path = c.hunk ? pathOf(c.hunk) : undefined;
    if (!c.hunk) body.push(c.text);
    else if (path && c.line !== null) placed.push({ path, side: c.side, line: c.line, text: c.text });
    else body.push(`${path ?? c.hunk.split("@")[0]}: ${c.text}`);
  }
  return { verdict, body: body.join("\n\n"), comments: placed };
}

// ---------------------------------------------------------------- GitHub

const EVENT = { approve: "APPROVE", request_changes: "REQUEST_CHANGES", comment: "COMMENT" } as const;
const prOf = (t: Target) => t.url?.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);

/** Why GitHub would refuse this posting before anything is sent, or undefined when it can go. */
function githubProblem(t: Target, p: Posting): string | undefined {
  if (!prOf(t)) return "no GitHub pull request URL in the document's target";
  // GitHub wants words with a change request or a comment; prview never writes them for you.
  if (p.verdict !== "approve" && !p.body.trim() && !p.comments.length) return `${p.verdict === "request_changes" ? "requesting changes" : "a comment"} needs a summary comment (N) or a line comment (n) to post`;
  return undefined;
}

export const github: Adapter = {
  platform: "github",
  describe(t, p) {
    const why = githubProblem(t, p);
    if (why) return `not posted: ${why}`;
    const n = p.comments.length;
    return `posts to ${t.url} with gh: ${EVENT[p.verdict].toLowerCase().replace("_", " ")}${p.body.trim() ? ", your summary" : ""}${n ? `, ${n} line comment${n === 1 ? "" : "s"}` : ""}`;
  },
  post(t, p, run, cwd) {
    const why = githubProblem(t, p);
    if (why) throw new Error(why);
    const [, owner, repo, number] = prOf(t)!;
    // One review holds everything, so the PR gets a single notification and the comments sit on the reviewed commit.
    const payload = {
      commit_id: t.head, event: EVENT[p.verdict], body: p.body,
      comments: p.comments.map((c) => ({ path: c.path, line: c.line, side: c.side === "old" ? "LEFT" : "RIGHT", body: c.text })),
    };
    const r = run(["gh", "api", "--method", "POST", `repos/${owner}/${repo}/pulls/${number}/reviews`, "--input", "-"], { cwd, stdin: JSON.stringify(payload) });
    if (r.exit !== 0) {
      let msg = (r.stderr || r.stdout).trim();
      try { const j = JSON.parse(r.stdout); if (typeof j?.message === "string") msg = [j.message, ...(Array.isArray(j.errors) ? j.errors.map(String) : [])].join(": "); } catch {}
      throw new Error(`gh api failed${r.exit === null ? "" : ` (exit ${r.exit})`}: ${msg.split("\n")[0] || "no output"}`);
    }
    try { const j = JSON.parse(r.stdout); if (typeof j?.html_url === "string") return { url: j.html_url }; } catch {}
    return { url: t.url };
  },
};

const ADAPTERS: Record<string, Adapter> = { github };

/** The adapter for a platform, if prview has one. GitLab and Azure DevOps come later, as more entries here. */
export const adapterFor = (platform: string | undefined): Adapter | undefined => platform ? ADAPTERS[platform.toLowerCase()] : undefined;
