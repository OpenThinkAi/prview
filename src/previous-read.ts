// The reads behind "your previous comments" (previous.ts has the rules, pure). Two kinds, both failure-tolerant:
//
//   - local, while the review is built: the latest kept submission that reached the PR (history.ts), and, when the head
//     it reviewed is still in the clone (rereview.ts fetches it), how its files moved since (the "since your review"
//     layer's old→new diff, since.ts, or the same diff of just these files) and a few lines of code then and now around each item. A head that is gone leaves the statuses unknown, and says so.
//   - the platform's, in the background once the screen is up (never before: opening never waits on it): the replies
//     to each item and whether its thread is resolved. GitHub through `gh api` (the PR's review comments, every page,
//     and the review threads' resolution through GraphQL); Azure DevOps through its REST API (the PR's threads). A
//     failure is a reason shown beside the items, never an error.
//
// Everything read from the platform is the PR author's text: previous.ts cleans it before it is shown.

import { submissionsFor } from "./history.ts";
import { parseDiff } from "./diff.ts";
import { hasCommit } from "./pr.ts";
import { parseNameStatus, pathsToDiff, sinceFiles, type Since } from "./since.ts";
import type { Target } from "./document.ts";
import { itemKey, itemsOf, lastReached, located, matchAzure, matchGithub, movesOf, type Moves, type PrevItem, type Previous, type Remote, type Snippet } from "./previous.ts";
import { azure as azureSource } from "./azure.ts";
import { prApi, getJson } from "./azure-api.ts";
import { azSpawn, azureHttp, type Http } from "./azure-auth.ts";
import { loadConfig, realLookups } from "./config.ts";
import { clean } from "./sanitize.ts";
import { clip } from "./guide.ts";

const gitOut = (repo: string, args: string[]): string | undefined => {
  try {
    const p = Bun.spawnSync(["git", ...args], { cwd: repo, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    return p.exitCode === 0 ? p.stdout.toString() : undefined;
  } catch { return undefined; }
};
const SHA = /^[0-9a-f]{7,64}$/i;

/** The latest submission for the review being opened that reached the PR: the PR's (by its canonical URL), else the review's own (by name). */
function latest(t: Target, slug: string) {
  try { return lastReached(t.url ? submissionsFor(t.url) : submissionsFor(slug)); } catch { return undefined; }
}

/** The chapter's items for a review being opened at `t.head`, before anything is read from git: undefined unless it is a re-review. */
export function previousItems(t: Target, slug: string): { items: PrevItem[]; keys: Set<string>; head: string; at: string; round: number; /** false when the submit had no platform to post to: it was only recorded. */ posted: boolean } | undefined {
  const l = latest(t, slug);
  if (!l || !l.sub.head || l.sub.head === t.head) return undefined;
  const items = itemsOf(l.sub);
  return { items, keys: new Set(items.map(itemKey)), head: l.sub.head, at: l.sub.at, round: l.round, posted: !l.sub.submission || !!l.sub.submission.posted };
}

/** How the reviewed head's files moved to the new one, through git (since.ts reads the diff); undefined when the old head is not in the clone. */
export function gitMoves(repo: string, old: string, now: string, paths: string[]): Moves | undefined {
  if (!SHA.test(old) || !SHA.test(now) || !hasCommit(repo, old)) return undefined;
  // Which entries touch an item's file (by either name of a rename), then the diff of just those, both names, so git pairs a rename.
  const z = gitOut(repo, ["diff", "-M", "--name-status", "-z", old, now]);
  if (z === undefined) return undefined;
  const pick = pathsToDiff(parseNameStatus(z), [], paths);
  if (!pick.length) return movesOf({ files: [] });
  const diff = gitOut(repo, ["diff", "-M", "--no-color", "--no-ext-diff", "--unified=0", old, now, "--", ...pick]);
  return diff === undefined ? undefined : movesOf({ files: sinceFiles(parseDiff(diff)) });
}

/** Up to `around` lines either side of `line` of `path` at commit `rev`, as git has them; undefined when it has no such file. */
function snippet(repo: string, rev: string, path: string, line: number | undefined, around = 3): Snippet | undefined {
  if (line === undefined || !SHA.test(rev)) return undefined;
  const text = gitOut(repo, ["show", `${rev}:${path}`]);
  if (text === undefined) return undefined;
  const all = text.split("\n");
  if (all.at(-1) === "") all.pop();
  const from = Math.max(1, line - around), to = Math.min(all.length, line + around);
  if (from > to) return undefined;
  return { start: from, lines: all.slice(from - 1, to).map((l) => clip(l.replace(/\t/g, "    "), 300)), mark: line };
}

/**
 * The chapter for a review being opened at `t.head` in `repo`, or undefined when it is not a re-review. `pre` is what
 * `previousItems` found (build.ts reads it first, to keep these comments out of the carried layer). `since`: the "since
 * your review" layer of the same head (rereview.ts), whose diff already covers these files; unset, git is asked.
 */
export function previousOf(repo: string, t: Target, pre: NonNullable<ReturnType<typeof previousItems>>, since?: Pick<Since, "files">): Previous {
  const paths = [...new Set(pre.items.flatMap((i) => i.path ? [i.path] : []))];
  const m = since?.files ? movesOf(since) : gitMoves(repo, pre.head, t.head, paths);
  const items = located(pre.items, m).map((i): PrevItem => {
    if (i.kind !== "line" || !m) return i;
    const old = i.side === "old" ? undefined : snippet(repo, pre.head, i.path!, i.line);
    const now = i.to?.line !== undefined && i.to.side !== "old" ? snippet(repo, t.head, i.to.path, i.to.line) : undefined;
    return { ...i, ...(old ? { old } : {}), ...(now ? { now } : {}) };
  });
  return {
    head: pre.head, at: pre.at, round: pre.round, ...(t.url ? { url: t.url } : {}), ...(t.platform ? { platform: t.platform } : {}), items,
    ...(m ? {} : { note: `The head you reviewed (${pre.head.slice(0, 7)}) is not in this clone, so where each comment's line is now is unknown.` }),
  };
}

// ---------------------------------------------------------------- the platform's side

/** Runs one argv without a shell and without blocking the screen; the real one spawns, tests pass a fake. */
export type AsyncRunner = (argv: string[], opts: { cwd: string }) => Promise<{ exit: number | null; stdout: string; stderr: string }>;
export const asyncSpawn: AsyncRunner = async (argv, { cwd }) => {
  try {
    const p = Bun.spawn(argv, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { exit, stdout, stderr };
  } catch (e) { return { exit: null, stdout: "", stderr: (e as Error).message }; }
};

/** What a platform read uses: `gh` for GitHub, an Http for Azure DevOps (unset: the credentialed real one, built only when used), and where to run. */
export type RemoteDeps = { run?: AsyncRunner; http?: Http; cwd?: string };

/** A short reason, one line, safe to show. */
const why = (e: unknown) => clip(clean(String(e instanceof Error ? e.message : e)).split("\n")[0] ?? "", 160) || "unknown error";

async function gh(run: AsyncRunner, cwd: string, args: string[]): Promise<unknown> {
  const r = await run(["gh", "api", ...args], { cwd });
  if (r.exit !== 0) {
    let msg = (r.stderr || r.stdout).trim();
    try { const j = JSON.parse(r.stdout); if (typeof j?.message === "string") msg = j.message; } catch {}
    throw new Error(`gh api failed${r.exit === null ? "" : ` (exit ${r.exit})`}: ${msg.split("\n")[0] || "no output"}`);
  }
  try { return JSON.parse(r.stdout); } catch { throw new Error("gh api did not return JSON"); }
}

const THREADS = "query($o:String!,$r:String!,$n:Int!,$c:String){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:100,after:$c){pageInfo{hasNextPage endCursor} nodes{isResolved comments(first:1){nodes{databaseId}}}}}}}";

/** GitHub: the PR's review comments, every page, then each thread's resolution (a GraphQL failure only leaves it unknown). */
export async function readGithub(p: Pick<Previous, "url" | "items">, run: AsyncRunner, cwd: string): Promise<Remote> {
  const m = p.url?.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) return { ok: false, reason: "no GitHub pull request URL" };
  const [, owner, repo, n] = m;
  const comments: unknown[] = [];
  try {
    for (let page = 1; page <= 30; page++) {
      const got = await gh(run, cwd, [`repos/${owner}/${repo}/pulls/${n}/comments?per_page=100&page=${page}`]);
      if (!Array.isArray(got)) throw new Error("gh api did not return a list of comments");
      comments.push(...got);
      if (got.length < 100) break;
    }
  } catch (e) { return { ok: false, reason: why(e) }; }
  let resolved: Map<number, boolean> | undefined = new Map();
  try {
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const j = await gh(run, cwd, ["graphql", "-f", `query=${THREADS}`, "-f", `o=${owner}`, "-f", `r=${repo}`, "-F", `n=${n}`, ...(cursor ? ["-f", `c=${cursor}`] : [])]) as any;
      const t = j?.data?.repository?.pullRequest?.reviewThreads;
      for (const node of Array.isArray(t?.nodes) ? t.nodes : []) {
        const id = node?.comments?.nodes?.[0]?.databaseId;
        if (typeof id === "number" && typeof node.isResolved === "boolean") resolved.set(id, node.isResolved);
      }
      if (!t?.pageInfo?.hasNextPage || typeof t.pageInfo.endCursor !== "string") break;
      cursor = t.pageInfo.endCursor;
    }
  } catch { resolved = undefined; }
  return { ok: true, threads: matchGithub(p.items, comments, resolved) };
}

/** Azure DevOps: the PR's threads, through the Http (which adds the credential). */
export async function readAzure(p: Pick<Previous, "url" | "items">, http: Http): Promise<Remote> {
  const ref = p.url ? azureSource.parse(p.url) : undefined;
  if (!ref) return { ok: false, reason: "no Azure DevOps pull request URL" };
  try {
    const j = await getJson<{ value?: unknown }>(http, prApi(ref, "threads"), `the threads of ${ref.label}`);
    return { ok: true, threads: matchAzure(p.items, Array.isArray(j.value) ? j.value : []) };
  } catch (e) { return { ok: false, reason: why(e) }; }
}

/** The platform's side of the chapter, by the PR's platform; a platform prview does not read says so. Never throws. */
export async function readRemote(p: Previous, deps: RemoteDeps = {}): Promise<Remote> {
  try {
    if (p.platform === "github") return await readGithub(p, deps.run ?? asyncSpawn, deps.cwd ?? process.cwd());
    if (p.platform === "azure-devops") return await readAzure(p, deps.http ?? azureHttp(loadConfig(), realLookups(), azSpawn));
    return { ok: false, reason: `not on ${p.platform ?? "this platform"} yet` };
  } catch (e) { return { ok: false, reason: why(e) }; }
}
