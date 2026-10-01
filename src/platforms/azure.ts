// Posting a submitted review to an Azure DevOps pull request. The read side (URL and remote parsing, fetching the
// PR) is src/azure.ts; credentials are src/azure-auth.ts and nowhere else.
//
// Azure DevOps has no pending review: every thread is visible, and notifies, the moment it is created. So posting is
// not atomic, and the adapter is built around that:
//   1. preflight everything before the first write: the text check (azureProblem), the PR's head still being the
//      reviewed commit, every commented path in the latest iteration's change list (its changeTrackingId), every
//      commented line's length (for the end offset), and who "you" are when a vote is to be cast;
//   2. then line threads, whole-file threads, the summary thread, and the vote LAST;
//   3. any failure stops there: no vote is cast, and the error lists what was already posted. Nothing is rolled back
//      (deleting a thread leaves a marker and the notification already went out).
//
// What is posted is the human's own words and nothing more, exactly as on GitHub: no properties bag, no bot marker,
// no mention of prview or a model. The token is added by azureHttp and never seen here; every error is redacted.

import { azureHttp, redact, type Http } from "../azure-auth.ts";
import { getIterations, lastIteration, prApi } from "../azure-api.ts";
import { azure as azureSource } from "../azure.ts";
import { loadConfig, realLookups } from "../config.ts";
import { PostError, type PostedItem, type Target, type Verdict } from "../document.ts";
import type { Adapter, Posting, Runner } from "../platform.ts";

/** Azure's vote for each verdict; `comment` casts none (writing 0 would reset a vote the reader already gave). */
export const VOTE: Record<Verdict, number | undefined> = { approve: 10, request_changes: -5, comment: undefined };
/** The same votes as `az repos pr set-vote` names them: the fallback when the caller's identity cannot be read. */
const AZ_VOTE: Record<number, string> = { 10: "approve", [-5]: "wait-for-author" };
const VOTE_TEXT: Record<Verdict, string> = { approve: "approve (vote 10)", request_changes: "wait for author (vote -5)", comment: "comment (your vote is left as it is)" };

/** The PR a target names, with each part still URL-encoded (as it goes into an API route), or undefined. */
function prOf(t: Target): { org: string; project: string; repo: string; id: number; url: string } | undefined {
  const ref = t.url ? azureSource.parse(t.url) : undefined;
  const m = ref?.url.match(/^https:\/\/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)$/);
  return m ? { org: m[1]!, project: m[2]!, repo: m[3]!, id: Number(m[4]), url: ref!.url } : undefined;
}

/** Why Azure DevOps should not be sent this posting, or undefined when it can go. Mirrors githubProblem: the one check on posted text. */
export function azureProblem(t: Target, p: Posting): string | undefined {
  if (!prOf(t)) return "no Azure DevOps pull request URL in the document's target";
  // Azure would take a bare -5, but prview never asks for changes without words, and a comment with nothing in it is nothing.
  const words = p.comments.length + (p.files?.length ?? 0);
  if (p.verdict !== "approve" && !p.body.trim() && !words) return `${p.verdict === "request_changes" ? "requesting changes" : "a comment"} needs a top-level comment or a ticked finding to post`;
  // The coverage line is opt-in and is never the whole review: there must be words of the human's own beside it.
  if (p.coverage && !p.body.trim() && !words) return "a coverage line needs a top-level comment or a ticked finding to go with it";
  return undefined;
}

type Pos = { line: number; offset: number | string };
type Thread = {
  comments: { parentCommentId: 0; content: string; commentType: 1 }[];
  status: 1;
  threadContext?: { filePath: string; rightFileStart?: Pos; rightFileEnd?: Pos; leftFileStart?: Pos; leftFileEnd?: Pos };
  pullRequestThreadContext?: { changeTrackingId: number | string; iterationContext: { firstComparingIteration: 1; secondComparingIteration: number | string } };
};
type Call = { method: string; url: string; body?: unknown };

/** Azure's paths are repo-rooted with a leading slash. */
const slash = (path: string) => `/${path.replace(/^\/+/, "")}`;
const thread = (content: string, ctx?: Pick<Thread, "threadContext" | "pullRequestThreadContext">): Thread => ({ comments: [{ parentCommentId: 0, content, commentType: 1 }], status: 1, ...ctx });
const prCtx = (changeTrackingId: number | string, last: number | string): NonNullable<Thread["pullRequestThreadContext"]> =>
  ({ changeTrackingId, iterationContext: { firstComparingIteration: 1, secondComparingIteration: last } });
/** A line comment's context: the whole line, offset 1 to its length + 1, on the right (new) or left (old) side. */
function lineCtx(path: string, side: "new" | "old", line: number, end: number | string): NonNullable<Thread["threadContext"]> {
  const [s, e] = side === "old" ? ["leftFileStart", "leftFileEnd"] as const : ["rightFileStart", "rightFileEnd"] as const;
  return { filePath: slash(path), [s]: { line, offset: 1 }, [e]: { line, offset: end } };
}

function routes(t: Target) {
  const pr = prOf(t)!, ref = azureSource.parse(pr.url)!;
  return {
    pr,
    ref,
    iterations: prApi(ref, "iterations"),
    changes: (last: number | string, skip: number) => prApi(ref, `iterations/${last}/changes`, { $top: 2000, $skip: skip }),
    threads: prApi(ref, "threads"),
    reviewer: (me: string) => prApi(ref, `reviewers/${me}`),
    identity: `https://dev.azure.com/${pr.org}/_apis/connectionData`,
  };
}

const ok = (status: number) => status >= 200 && status < 300;
/** Azure's own reason for a refusal, redacted. */
function reason(res: { status: number; json: unknown; text: string }): string {
  const j = res.json as { message?: unknown } | undefined;
  const said = typeof j?.message === "string" ? j.message : res.text.trim().split("\n")[0] ?? "";
  return redact(`HTTP ${res.status}${said ? `: ${said.slice(0, 300)}` : ""}`);
}

async function getJson(http: Http, url: string, what: string): Promise<any> {
  const res = await http({ method: "GET", url, headers: { Accept: "application/json" } });
  if (!ok(res.status)) throw new Error(`could not read ${what}: ${reason(res)}`);
  return res.json;
}

/** One file's text at a commit, through git in the review's worktree; undefined when git has no such file there. */
function fileAt(run: Runner, cwd: string, rev: string, path: string): string[] | undefined {
  const r = run(["git", "show", `${rev}:${path.replace(/^\/+/, "")}`], { cwd });
  if (r.exit !== 0) return undefined;
  const lines = r.stdout.split("\n").map((l) => l.replace(/\r$/, ""));
  if (lines.at(-1) === "") lines.pop(); // the newline that ends the last line starts no line of its own
  return lines;
}

/** What post needs: an Http (built lazily, only when something is really posted) and a way to run git and az. */
export type AzureDeps = { http: (run: Runner) => Http };

/** The real Http: config's [azure] credential (az run through the adapter's runner) over fetch. Built only by a real post; minted on first use. */
const realHttp = (run: Runner): Http => azureHttp(loadConfig(), realLookups(), run);

export function azureAdapter(deps: AzureDeps = { http: realHttp }): Adapter {
  return {
    platform: "azure-devops",
    verdicts: ["approve", "request_changes", "comment"],
    describe(t, p) {
      const why = azureProblem(t, p);
      if (why) return `not posted: ${why}`;
      const n = p.comments.length, w = p.files?.length ?? 0;
      return `posts to ${prOf(t)!.url} with your Azure DevOps login: ${VOTE_TEXT[p.verdict]}${p.body.trim() ? ", your summary" : ""}${n ? `, ${n} line comment${n === 1 ? "" : "s"}` : ""}${w ? `, ${w} whole-file comment${w === 1 ? "" : "s"}` : ""}${p.coverage ? ", a coverage line" : ""}; each thread is visible as soon as it is posted`;
    },
    dryRun(t, p) {
      const why = azureProblem(t, p);
      if (why) return [`would not post: ${why}`];
      // Static, like GitHub's: no network and no credential. What only the network could tell is a placeholder.
      const r = routes(t), last = "<last iteration>", me = "<your identity id>";
      const id = (path: string) => `<tracking id of ${slash(path)}>`;
      const show = (c: Call, note: string) => [`# ${note}`, `${c.method} ${c.url}`, ...(c.body === undefined ? [] : [JSON.stringify(c.body, null, 2)])].join("\n");
      const summary = [p.body, p.coverage].filter((x) => x?.trim()).join("\n\n");
      const vote = VOTE[p.verdict];
      return [
        show({ method: "GET", url: r.iterations }, `the last iteration's head must still be ${t.head}; if it moved, nothing is posted`),
        show({ method: "GET", url: r.changes(last, 0) }, "the change list of that iteration (paged): each commented file's tracking id; a file not in it goes into the summary instead"),
        ...(vote === undefined ? [] : [show({ method: "GET", url: r.identity }, "who you are, for the vote (if this fails, the vote goes through `az repos pr set-vote` instead)")]),
        ...p.comments.map((c) => show({ method: "POST", url: r.threads, body: thread(c.text, { threadContext: lineCtx(c.path, c.side, c.line, `<length of line ${c.line} + 1>`), pullRequestThreadContext: prCtx(id(c.path), last) }) },
          `a line comment on the ${c.side === "old" ? "old (left)" : "new (right)"} side, posted active`)),
        ...(p.files ?? []).map((x) => show({ method: "POST", url: r.threads, body: thread(x.text, { threadContext: { filePath: slash(x.path) }, pullRequestThreadContext: prCtx(id(x.path), last) }) }, "a comment on the whole file, posted active")),
        ...(summary ? [show({ method: "POST", url: r.threads, body: thread(summary) }, "your summary, on the pull request itself")] : []),
        vote === undefined ? "# no vote: a comment leaves your vote as it is"
          : show({ method: "PUT", url: r.reviewer(me), body: { vote, id: me } }, `the vote, last: ${VOTE_TEXT[p.verdict]}; if anything before it failed, no vote is cast`),
      ];
    },
    async post(t, p, run, cwd) {
      const why = azureProblem(t, p);
      if (why) throw new Error(why);
      const r = routes(t), http = deps.http(run);

      // ---- 1. preflight: nothing is written until every check has passed.
      // A comment anchored to line 11 of one commit is wrong on another: refuse rather than mis-anchor.
      const lastIt = lastIteration(await getIterations(http, r.ref));
      const now = lastIt?.sourceRefCommit?.commitId;
      if (typeof now !== "string" || !now || !lastIt) throw new Error("could not read the pull request's head commit");
      if (now !== t.head) throw new Error(`the pull request head is now ${now.slice(0, 8)}, but this review is of ${t.head.slice(0, 8)}: reopen it to review the new commits`);
      const last: number = lastIt.id;
      // The base goes into a git argv: only ever a commit id (a document is untrusted input; `--output=…` is not a commit).
      if (!/^[0-9a-f]{7,64}$/i.test(t.base)) throw new Error(`the review's base (${t.base.slice(0, 40)}) is not a commit id`);

      // Every changed path's tracking id (and where a renamed file came from, for reading its old side).
      const tracked = new Map<string, { id: number; from?: string }>();
      const wanted = p.comments.length + (p.files?.length ?? 0) > 0;
      for (let skip = 0, pages = 0; wanted && pages < 100; pages++) {
        const page = await getJson(http, r.changes(last, skip), "the pull request's changed files");
        for (const e of Array.isArray(page?.changeEntries) ? page.changeEntries : []) {
          const path = e?.item?.path;
          if (typeof path === "string" && typeof e.changeTrackingId === "number") tracked.set(slash(path), { id: e.changeTrackingId, ...(typeof e.originalPath === "string" ? { from: e.originalPath } : {}) });
        }
        if (!(typeof page?.nextSkip === "number" && page.nextSkip > skip)) break;
        skip = page.nextSkip;
      }

      // Each line's end offset, from the reviewed commits. A comment Azure cannot place still reaches the PR, in the summary under its file.
      // Each write goes with the item it records once posted (its ids are added from Azure's answer).
      type Write = { call: Call; item: PostedItem };
      const folded: string[] = [], lines: Write[] = [], wholeFiles: Write[] = [];
      const cache = new Map<string, string[] | undefined>();
      const read = (rev: string, path: string) => { const k = `${rev}:${path}`; if (!cache.has(k)) cache.set(k, fileAt(run, cwd, rev, path)); return cache.get(k); };
      for (const c of p.comments) {
        const at = tracked.get(slash(c.path));
        const text = at && (c.side === "old" ? read(t.base, at.from ?? c.path) : read(t.head, c.path))?.[c.line - 1];
        if (!at || text === undefined || c.line < 1) { folded.push(`${c.path}:${c.line}: ${c.text}`); continue; }
        lines.push({ call: { method: "POST", url: r.threads, body: thread(c.text, { threadContext: lineCtx(c.path, c.side, c.line, text.length + 1), pullRequestThreadContext: prCtx(at.id, last) }) }, item: { kind: "line", path: c.path, line: c.line, side: c.side, text: c.text } });
      }
      for (const x of p.files ?? []) {
        const at = tracked.get(slash(x.path));
        if (!at) { folded.push(`${x.path}: ${x.text}`); continue; }
        wholeFiles.push({ call: { method: "POST", url: r.threads, body: thread(x.text, { threadContext: { filePath: slash(x.path) }, pullRequestThreadContext: prCtx(at.id, last) }) }, item: { kind: "file", path: x.path, text: x.text } });
      }
      const summary = [p.body, ...folded, p.coverage].filter((x) => x?.trim()).join("\n\n");

      // Who casts the vote: connectionData, or `az repos pr set-vote` (which works out the caller itself) when that is refused.
      const vote = VOTE[p.verdict];
      let me: string | undefined;
      if (vote !== undefined) {
        const res = await http({ method: "GET", url: r.identity, headers: { Accept: "application/json" } });
        const id = ok(res.status) ? (res.json as any)?.authenticatedUser?.id : undefined;
        if (typeof id === "string" && id) me = id;
        else if (ok(res.status) || res.status >= 500) throw new Error(`could not read who you are on Azure DevOps: ${reason(res)}`);
      }

      // ---- 2. the writes, in order; 3. a failure stops them and says what is already on the PR.
      // `items` is the record of what is on the PR, with Azure's ids: kept on success and carried by a failure alike.
      const posted: string[] = [], items: PostedItem[] = [];
      const fail = (what: string, err: string): never => {
        const list = posted.length ? `already posted (left in place): ${posted.join("; ")}` : "nothing was posted";
        throw new PostError(redact(`${what} failed: ${err}. ${list}. No vote was cast.`), items);
      };
      const send = async ({ call: c, item }: Write, what: string) => {
        let res;
        try { res = await http({ method: c.method, url: c.url, headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(c.body) }); }
        catch (e) { return fail(what, (e as Error).message); }
        if (!ok(res.status)) return fail(what, reason(res));
        const j = res.json as any, id = j?.id, first = Array.isArray(j?.comments) ? j.comments[0]?.id : undefined;
        const whole = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
        items.push({ ...item, ...(whole(id) ? { thread_id: id } : {}), ...(whole(first) ? { comment_id: first } : {}) });
        posted.push(`thread ${id ?? "?"} (${what}${typeof id === "number" ? `, ${r.pr.url}?discussionId=${id}` : ""})`);
      };
      const where = (c: Call) => { const x = (c.body as Thread).threadContext!; const s = x.rightFileStart ?? x.leftFileStart; return `${x.filePath.slice(1)}${s ? `:${s.line}${x.leftFileStart ? " (old side)" : ""}` : ""}`; };
      for (const w of lines) await send(w, `line comment on ${where(w.call)}`);
      for (const w of wholeFiles) await send(w, `whole-file comment on ${where(w.call)}`);
      if (summary) await send({ call: { method: "POST", url: r.threads, body: thread(summary) }, item: { kind: "summary", text: summary } }, "summary");

      if (vote !== undefined) {
        if (me) {
          let res;
          try { res = await http({ method: "PUT", url: r.reviewer(me), headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ vote, id: me }) }); }
          catch (e) { return fail("the vote", (e as Error).message); }
          if (!ok(res.status)) fail("the vote", reason(res));
        } else {
          const v = run(["az", "repos", "pr", "set-vote", "--id", String(r.pr.id), "--vote", AZ_VOTE[vote]!, "--org", `https://dev.azure.com/${r.pr.org}`], { cwd });
          if (v.exit !== 0) fail("the vote (az repos pr set-vote)", (v.stderr || v.stdout).trim().split("\n")[0] || `exit ${v.exit ?? "?"}`);
        }
      }
      return { url: r.pr.url, items };
    },
  };
}

export const azure: Adapter = azureAdapter();
