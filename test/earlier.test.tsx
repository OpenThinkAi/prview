import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { cleanup, render } from "ink-testing-library";
import { inkTestHooks } from "./ink-hooks.ts";
import type { Review } from "../src/build.ts";
import { parseDiff } from "../src/diff.ts";
import { fit, parseDocument, PostError, SCHEMA, type Doc, type Target } from "../src/document.ts";
import {
  afterSubmit, earlierKeys, earlierOf, earlierPosts, keepQueue, queuedText, replyKey, resolveKey, setReply, threadOf, toggleResolve, type EarlierQueue,
} from "../src/earlier.ts";
import { github, type EarlierPost, type Posting, type Runner } from "../src/platform.ts";
import { azureAdapter } from "../src/platforms/azure.ts";
import type { Http, HttpReq, HttpRes } from "../src/azure-auth.ts";
import { itemKey, itemsOf, lastReached, rowText, type PrevItem } from "../src/previous.ts";
import { impliedVerdict, nextStep, selectionOf, startFlow, stepLines, toggle } from "../src/submit-flow.ts";
import { planOf, postPreview, submit } from "../src/submit.ts";
import { App, type Outcome } from "../src/tui.tsx";

// Re-review R5: replies and resolves on earlier threads, queued with the review and sent with the next submit, first.
// Every platform call goes to a fake (gh runner, Http): nothing reaches a network or a real pull request.
let tmp = "", saved: string | undefined;
beforeAll(() => { saved = process.env.PRVIEW_HOME; tmp = mkdtempSync(join(tmpdir(), "prview-earlier-")); process.env.PRVIEW_HOME = join(tmp, "home"); });
inkTestHooks();
afterAll(() => { cleanup(); rmSync(tmp, { recursive: true, force: true }); if (saved === undefined) delete process.env.PRVIEW_HOME; else process.env.PRVIEW_HOME = saved; });

const A = "a".repeat(40), B = "b".repeat(40);
const PR = "https://github.com/o/r/pull/7";
const line = (path: string, n: number, text: string, extra: Partial<PrevItem> = {}): PrevItem => ({ kind: "line", path, line: n, side: "new", text, ...extra });
const GH_ITEM = line("src/a.rs", 20, "first look", { comment_id: 101, node_id: "PRRC_101" });
const LEGACY = line("src/a.rs", 9, "no ids");

// ---------------------------------------------------------------- the queue (pure)

test("the thread: recorded ids first, else the read's match; a legacy item without one says why; GitHub's summary has none", () => {
  expect(threadOf(GH_ITEM, undefined, "github", "pending", "reply to")).toEqual({ ids: { comment_id: 101, node_id: "PRRC_101" } });
  const found = { found: true, replies: [], ids: { comment_id: 102, node_id: "PRRC_102" } };
  expect(threadOf(LEGACY, found, "github", "ok", "resolve")).toEqual({ ids: { comment_id: 102, node_id: "PRRC_102" } });
  expect(threadOf(LEGACY, undefined, "github", "pending", "reply to")).toEqual({ why: expect.stringContaining("still being read") });
  expect(threadOf(LEGACY, undefined, "github", "failed", "reply to")).toEqual({ why: expect.stringContaining("could not be read") });
  expect(threadOf(LEGACY, { found: false, replies: [] }, "github", "ok", "resolve")).toEqual({ why: "cannot resolve it: your submit did not record its GitHub id, and no thread on the PR matches it (same place and text)" });
  expect(threadOf({ kind: "summary", text: "x" }, undefined, "github", "ok", "reply to")).toEqual({ why: "cannot reply to the summary: on GitHub it is the review's body, which has no thread" });
  expect(threadOf(GH_ITEM, undefined, "gitlab", "ok", "reply to")).toEqual({ why: "cannot reply to it: answering earlier threads is not on gitlab yet" });
  // Azure DevOps: the thread and its first comment; the summary is a thread there.
  expect(threadOf({ kind: "summary", text: "x", thread_id: 9, comment_id: 1 }, undefined, "azure-devops", "pending", "resolve")).toEqual({ ids: { thread_id: 9, comment_id: 1 } });
  expect(threadOf(LEGACY, { found: true, replies: [], ids: { thread_id: 8, comment_id: 1 } }, "azure-devops", "ok", "reply to")).toEqual({ ids: { thread_id: 8, comment_id: 1 } });
});

test("queue: a reply set, edited and removed by an empty one; a resolve toggled; both on one item; another submission's queue is dropped", () => {
  const k = itemKey(GH_ITEM), ids = { comment_id: 101 };
  let q = setReply(undefined, A, GH_ITEM, k, ids, "  thanks, \x1b[31mlooks good  ");
  expect(q).toEqual({ head: A, acts: [{ key: k, place: "src/a.rs:20", path: "src/a.rs", line: 20, side: "new", ids, reply: "thanks, looks good" }] });
  q = setReply(q, A, GH_ITEM, k, ids, "edited");
  expect(q!.acts[0]!.reply).toBe("edited");
  q = toggleResolve(q, A, GH_ITEM, k, ids);
  expect(queuedText(q!.acts[0])).toBe("reply queued · resolve queued");
  q = setReply(q, A, GH_ITEM, k, ids, "   ");
  expect(q!.acts[0]).toMatchObject({ resolve: true });
  expect(q!.acts[0]!.reply).toBeUndefined();
  expect(toggleResolve(q, A, GH_ITEM, k, ids)).toBeUndefined();
  // A queue of another head's chapter is not built on.
  expect(toggleResolve({ head: B, acts: [{ key: "x", place: "p", ids: {}, resolve: true }] }, A, GH_ITEM, k, ids)?.acts.map((a) => a.key)).toEqual([k]);
});

const QUEUE: EarlierQueue = { head: A, acts: [
  { key: "k1", place: "src/a.rs:20", path: "src/a.rs", line: 20, side: "new", ids: { comment_id: 101, node_id: "PRRC_101" }, reply: "thanks, fixed", resolve: true },
  { key: "k2", place: "src/b.rs (whole file)", path: "src/b.rs", ids: { comment_id: 103 }, resolve: true },
] };

test("what posts: each reply before its resolve; an unticked one stays queued; what went out leaves the queue", () => {
  expect(earlierKeys(QUEUE)).toEqual([replyKey(QUEUE.acts[0]!), resolveKey(QUEUE.acts[0]!), resolveKey(QUEUE.acts[1]!)]);
  const all = earlierPosts(QUEUE);
  expect(all.map((e) => [e.kind, e.place])).toEqual([["reply", "src/a.rs:20"], ["resolve", "src/a.rs:20"], ["resolve", "src/b.rs (whole file)"]]);
  expect(all[0]).toEqual({ kind: "reply", text: "thanks, fixed", key: "k1", place: "src/a.rs:20", path: "src/a.rs", line: 20, side: "new", comment_id: 101, node_id: "PRRC_101" });
  const listed = earlierKeys(QUEUE), sel = { listed, include: listed.filter((k) => k !== resolveKey(QUEUE.acts[0]!)) };
  const some = earlierPosts(QUEUE, sel);
  expect(some.map((e) => `${e.kind} ${e.key}`)).toEqual(["reply k1", "resolve k2"]);
  // Both sent: the unticked resolve stays. Only the first sent (a failure after it): the rest stay.
  const { reply: _, ...firstLeft } = QUEUE.acts[0]!;
  expect(afterSubmit(QUEUE, some, [{ kind: "reply", text: "thanks, fixed" }, { kind: "resolve", text: "" }])).toEqual({ head: A, acts: [firstLeft] });
  expect(afterSubmit(QUEUE, all, [{ kind: "reply", text: "thanks, fixed" }])!.acts.map((a) => [a.key, a.reply, a.resolve])).toEqual([["k1", undefined, true], ["k2", undefined, true]]);
  expect(afterSubmit(QUEUE, all, [{ kind: "reply", text: "x" }, { kind: "resolve", text: "" }, { kind: "resolve", text: "" }, { kind: "line", text: "new" }])).toBeUndefined();
});

test("stored: the queue re-read drops what is not one; on reopen it stays only for the same submission's items", () => {
  expect(earlierOf(JSON.parse(JSON.stringify(QUEUE)))).toEqual(QUEUE);
  expect(earlierOf({ head: "nope", acts: [] })).toBeUndefined();
  expect(earlierOf({ head: A, acts: [{ key: "k", place: "p", ids: { comment_id: -1 }, reply: "  " }, { key: "j", place: "q", ids: { comment_id: 5 }, reply: "\x1b[2Jhi" }] })).toEqual({ head: A, acts: [{ key: "j", place: "q", ids: { comment_id: 5 }, reply: "hi" }] });
  expect(keepQueue(QUEUE, A, new Set(["k2"]))?.acts.map((a) => a.key)).toEqual(["k2"]);
  expect(keepQueue(QUEUE, B, new Set(["k1", "k2"]))).toBeUndefined();
});

test("the record: reply and resolve items parse back; the chapter leaves them out, and a submit of only those is not the one it reads", () => {
  const doc = parseDocument({
    schema: SCHEMA, target: { repo: "r", base: A, head: B }, plan: {}, findings: [], human: { comments: [], visited: [] },
    submissions: [{ at: "2026-10-01T00:00:00Z", file: "f", head: B, posted: { platform: "github", ok: true, items: [
      { kind: "reply", path: "src/a.rs", line: 20, side: "new", text: "thanks", reply_to: 101, comment_id: 900, node_id: "PRRC_900" },
      { kind: "resolve", path: "src/a.rs", line: 20, side: "new", text: "", comment_id: 101, thread_node_id: "PRRT_1" },
    ] } }],
  });
  const items = doc.submissions![0]!.posted!.items!;
  expect(items[0]).toEqual({ kind: "reply", path: "src/a.rs", line: 20, side: "new", text: "thanks", reply_to: 101, comment_id: 900, node_id: "PRRC_900" });
  expect(items[1]).toEqual({ kind: "resolve", path: "src/a.rs", line: 20, side: "new", text: "", comment_id: 101, thread_node_id: "PRRT_1" });
  const only = { file: "f", doc, at: "2026-10-01T00:00:00Z", head: B, legacy: false, slug: "s", submission: doc.submissions![0]! };
  expect(itemsOf(only)).toEqual([]);
  expect(lastReached([only])).toBeUndefined();
});

// ---------------------------------------------------------------- GitHub

const ghTarget: Target = { repo: "o/r", base: A, head: B, url: PR, platform: "github", title: "T", body: "", label: "o/r#7" };
const REPLY: EarlierPost = { kind: "reply", text: "thanks, fixed", key: "k1", place: "src/a.rs:20", path: "src/a.rs", line: 20, side: "new", comment_id: 101, node_id: "PRRC_101" };
const RESOLVE: EarlierPost = { kind: "resolve", text: "", key: "k1", place: "src/a.rs:20", path: "src/a.rs", line: 20, side: "new", comment_id: 101, node_id: "PRRC_101" };
type Call = { argv: string[]; body?: any };

/** A fake gh for the earlier threads and the review; `fail` names a call that fails. */
function fakeGh(fail?: "reply" | "threads" | "resolve" | "create") {
  const calls: Call[] = [];
  const run: Runner = (argv, o) => {
    const body = o.stdin === undefined ? undefined : JSON.parse(o.stdin);
    calls.push({ argv, body });
    const method = argv[3]!, path = argv[4]!;
    const no = { exit: 1, stdout: JSON.stringify({ message: "Validation Failed" }), stderr: "" };
    if (method === "GET" && path === "repos/o/r/pulls/7") return { exit: 0, stdout: JSON.stringify({ head: { sha: B } }), stderr: "" };
    if (path.endsWith("/replies")) return fail === "reply" ? no : { exit: 0, stdout: JSON.stringify({ id: 900, node_id: "PRRC_900" }), stderr: "" };
    if (path === "graphql" && body.query.startsWith("query")) {
      if (fail === "threads") return no;
      const page2 = body.variables.c === "C1";
      const nodes = page2 ? [{ id: "PRRT_1", isResolved: false, comments: { nodes: [{ id: "PRRC_101", databaseId: 101 }] } }] : [{ id: "PRRT_0", isResolved: false, comments: { nodes: [{ id: "PRRC_50", databaseId: 50 }] } }];
      return { exit: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: !page2, endCursor: "C1" }, nodes } } } } }), stderr: "" };
    }
    if (path === "graphql") return fail === "resolve" ? { exit: 0, stdout: JSON.stringify({ errors: [{ message: "Resource not accessible" }] }), stderr: "" } : { exit: 0, stdout: JSON.stringify({ data: { resolveReviewThread: { thread: { id: body.variables.id, isResolved: true } } } }), stderr: "" };
    if (path.endsWith("/reviews")) return fail === "create" ? no : { exit: 0, stdout: JSON.stringify({ id: 99 }), stderr: "" };
    if (path.endsWith("/events")) return { exit: 0, stdout: JSON.stringify({ html_url: `${PR}#pullrequestreview-99` }), stderr: "" };
    if (method === "GET") return { exit: 0, stdout: "[]", stderr: "" };
    return { exit: 0, stdout: "{}", stderr: "" };
  };
  const shown = () => calls.map((c) => c.argv[4] === "graphql" ? `graphql ${c.body.query.split("(")[0]}` : `${c.argv[3]} ${c.argv[4]}`);
  return { calls, run, shown };
}

const words = (verdict: Posting["verdict"], extra: Partial<Posting> = {}): Posting => ({ verdict, body: "Looks right now.", comments: [], earlier: [REPLY, RESOLVE], ...extra });

test("github: the head check, then the reply and the resolve (its thread found from the comment), then the review; all recorded", async () => {
  const gh = fakeGh();
  const got = await github.post(ghTarget, words("approve"), gh.run, "/wt");
  expect(gh.shown()).toEqual([
    "GET repos/o/r/pulls/7", "POST repos/o/r/pulls/7/comments/101/replies", "graphql query", "graphql query", "graphql mutation",
    "POST repos/o/r/pulls/7/reviews", "POST repos/o/r/pulls/7/reviews/99/events",
  ]);
  expect(gh.calls[1]!.body).toEqual({ body: "thanks, fixed" });
  expect(gh.calls[4]!.body.variables).toEqual({ id: "PRRT_1" });
  expect(got.items).toEqual([
    { kind: "reply", path: "src/a.rs", line: 20, side: "new", text: "thanks, fixed", reply_to: 101, comment_id: 900, node_id: "PRRC_900" },
    { kind: "resolve", path: "src/a.rs", line: 20, side: "new", text: "", comment_id: 101, thread_node_id: "PRRT_1" },
    { kind: "summary", text: "Looks right now.", review_id: 99 },
  ]);
  expect(github.describe(ghTarget, words("approve"))).toBe(`posts to ${PR} with gh: first 1 reply and 1 resolve on earlier threads; then approve, your summary`);
});

test("github: a comment with no words of its own posts only the earlier threads, no review", async () => {
  const gh = fakeGh();
  const p = words("comment", { body: "" });
  expect(github.describe(ghTarget, p)).toBe(`posts to ${PR} with gh: only 1 reply and 1 resolve on earlier threads (no review: a comment with no words of its own)`);
  const got = await github.post(ghTarget, p, gh.run, "/wt");
  expect(gh.shown().some((s) => s.includes("/reviews"))).toBe(false);
  expect(got.items!.map((i) => i.kind)).toEqual(["reply", "resolve"]);
  // A coverage line is still never the whole of it.
  expect(github.describe(ghTarget, { ...p, coverage: "I read 1 of 2 hunks." })).toMatch(/^not posted: /);
});

test("github: a failure on an earlier thread stops everything, and says what already went out; a later failure keeps those recorded", async () => {
  const gh = fakeGh("resolve");
  const e = await github.post(ghTarget, words("approve"), gh.run, "/wt").then(() => undefined, (x) => x);
  expect(e).toBeInstanceOf(PostError);
  expect(e.message).toBe("resolving src/a.rs:20 failed: gh api graphql failed: Resource not accessible. Already posted (left in place): reply to src/a.rs:20. The review was not posted.");
  expect(e.items.map((i: any) => i.kind)).toEqual(["reply"]);
  expect(gh.shown().some((s) => s.includes("/reviews"))).toBe(false);
  const first = fakeGh("reply");
  const e1 = await github.post(ghTarget, words("approve"), first.run, "/wt").then(() => undefined, (x) => x);
  expect(e1.message).toStartWith("the reply to src/a.rs:20 failed: gh api failed (exit 1): Validation Failed. Nothing was posted.");
  expect(e1.items).toEqual([]);
  const late = fakeGh("create");
  const e2 = await github.post(ghTarget, words("approve"), late.run, "/wt").then(() => undefined, (x) => x);
  expect(e2).toBeInstanceOf(PostError);
  expect(e2.message).toContain("(already posted on earlier threads, left in place: reply to src/a.rs:20; resolved src/a.rs:20)");
  expect(e2.items.map((i: any) => i.kind)).toEqual(["reply", "resolve"]);
});

test("github: the posted-text check holds a reply to the reader's words; the dry run prints the calls", () => {
  expect(github.describe(ghTarget, words("approve", { earlier: [{ ...REPLY, text: "  " }] }))).toBe("not posted: the reply to src/a.rs:20 is empty");
  expect(github.describe(ghTarget, words("approve", { earlier: [{ ...RESOLVE, comment_id: undefined }] }))).toBe("not posted: resolving src/a.rs:20 has no GitHub comment to act on");
  const dry = github.dryRun(ghTarget, words("approve")).join("\n\n");
  expect(dry).toContain("# reply to your earlier comment on src/a.rs:20 (sent before the review)\ngh api --method POST repos/o/r/pulls/7/comments/101/replies --input -");
  expect(dry).toContain("resolveReviewThread");
  expect(dry.indexOf("replies")).toBeLessThan(dry.indexOf("pulls/7/reviews"));
});

// ---------------------------------------------------------------- Azure DevOps

const AZ_URL = "https://dev.azure.com/contoso/web/_git/web/pullrequest/42";
const ROOT = "https://dev.azure.com/contoso/web/_apis/git/repositories/web/pullRequests/42";
const azTarget: Target = { repo: "contoso/web/web", base: A, head: B, url: AZ_URL, platform: "azure-devops", title: "T", body: "", label: "web!42" };
const AZ_REPLY: EarlierPost = { kind: "reply", text: "thanks, fixed", key: "k1", place: "src/a.rs:20", path: "src/a.rs", line: 20, side: "new", thread_id: 7, comment_id: 1 };
const AZ_RESOLVE: EarlierPost = { ...AZ_REPLY, kind: "resolve", text: "" };

function fakeAzure(fail?: "reply" | "resolve") {
  const calls: (HttpReq & { json?: any })[] = [];
  const res = (status: number, json: unknown): HttpRes => ({ status, json, text: JSON.stringify(json) });
  const http: Http = async (req) => {
    calls.push({ ...req, ...(req.body ? { json: JSON.parse(req.body) } : {}) });
    const u = req.url;
    if (u === `${ROOT}/iterations?api-version=7.1`) return res(200, { value: [{ id: 3, sourceRefCommit: { commitId: B } }] });
    if (u === "https://dev.azure.com/contoso/_apis/connectionData") return res(200, { authenticatedUser: { id: "me-1" } });
    if (u === `${ROOT}/threads/7/comments?api-version=7.1`) return fail === "reply" ? res(403, { message: "TF401027: no permission" }) : res(200, { id: 4, parentCommentId: 1 });
    if (u === `${ROOT}/threads/7?api-version=7.1` && req.method === "PATCH") return fail === "resolve" ? res(400, { message: "bad status" }) : res(200, { id: 7, status: "fixed" });
    if (u === `${ROOT}/threads?api-version=7.1`) return res(200, { id: 50, comments: [{ id: 1 }] });
    if (u === `${ROOT}/reviewers/me-1?api-version=7.1`) return res(200, { vote: 10 });
    return res(404, { message: `unexpected ${req.method} ${u}` });
  };
  const run: Runner = () => { throw new Error("no git or az here"); };
  return { calls, http, run, adapter: azureAdapter({ http: () => http }), writes: () => calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.url.replace(ROOT, "").replace(/\?api-version=7\.1$/, "")}`) };
}

test("azure: the preflight, then the reply (under the thread's first comment) and the resolve (fixed), then the summary and the vote last", async () => {
  const f = fakeAzure();
  const got = await f.adapter.post(azTarget, { verdict: "approve", body: "Looks right now.", comments: [], earlier: [AZ_REPLY, AZ_RESOLVE] }, f.run, "/wt");
  expect(f.writes()).toEqual(["POST /threads/7/comments", "PATCH /threads/7", "POST /threads", "PUT /reviewers/me-1"]);
  expect(f.calls.find((c) => c.method === "POST")!.json).toEqual({ parentCommentId: 1, content: "thanks, fixed", commentType: 1 });
  expect(f.calls.find((c) => c.method === "PATCH")!.json).toEqual({ status: "fixed" });
  expect(got.items).toEqual([
    { kind: "reply", path: "src/a.rs", line: 20, side: "new", thread_id: 7, text: "thanks, fixed", reply_to: 1, comment_id: 4 },
    { kind: "resolve", path: "src/a.rs", line: 20, side: "new", thread_id: 7, text: "", comment_id: 1 },
    { kind: "summary", text: "Looks right now.", thread_id: 50, comment_id: 1 },
  ]);
});

test("azure: a failure stops there, no vote; only earlier threads post no summary and no vote; dry run and check", async () => {
  const f = fakeAzure("resolve");
  const e = await f.adapter.post(azTarget, { verdict: "approve", body: "ok", comments: [], earlier: [AZ_REPLY, AZ_RESOLVE] }, f.run, "/wt").then(() => undefined, (x) => x);
  expect(e).toBeInstanceOf(PostError);
  expect(e.message).toStartWith("resolving src/a.rs:20 failed: HTTP 400: bad status. already posted (left in place): reply on thread 7 (src/a.rs:20");
  expect(e.message).toEndWith("No vote was cast.");
  expect(e.items.map((i: any) => i.kind)).toEqual(["reply"]);
  expect(f.writes()).toEqual(["POST /threads/7/comments", "PATCH /threads/7"]);
  const only = fakeAzure();
  const got = await only.adapter.post(azTarget, { verdict: "comment", body: "", comments: [], earlier: [AZ_RESOLVE] }, only.run, "/wt");
  expect(only.writes()).toEqual(["PATCH /threads/7"]);
  expect(got.items!.map((i) => i.kind)).toEqual(["resolve"]);
  const dry = only.adapter.dryRun(azTarget, { verdict: "request_changes", body: "no", comments: [], earlier: [AZ_REPLY, AZ_RESOLVE] }).join("\n\n");
  expect(dry).toContain(`POST ${ROOT}/threads/7/comments?api-version=7.1`);
  expect(dry).toContain(`PATCH ${ROOT}/threads/7?api-version=7.1\n{\n  "status": "fixed"\n}`);
  expect(dry.indexOf("threads/7/comments")).toBeLessThan(dry.indexOf("PUT"));
  expect(only.adapter.describe(azTarget, { verdict: "approve", body: "", comments: [], earlier: [{ ...AZ_REPLY, thread_id: undefined }] })).toBe("not posted: the reply to src/a.rs:20 has no Azure DevOps thread to act on");
});

// ---------------------------------------------------------------- the submit flow and submit

const DIFF = `diff --git a/src/a.rs b/src/a.rs
index 1..2 100644
--- a/src/a.rs
+++ b/src/a.rs
@@ -20,3 +20,5 @@ fn main() {
 keep
-old
+new1
+new2
+new3
 keep2
`;
const files = parseDiff(DIFF);
let n = 0;
function review(platform: "github" | "azure-devops" = "github", queue: EarlierQueue | null = QUEUE): Review {
  const worktree = mkdtempSync(join(tmp, "wt-"));
  const doc: Doc = {
    schema: SCHEMA, target: { repo: "o/r", base: "e".repeat(40), head: B, title: "A change", body: "", label: "o/r#7", url: platform === "github" ? PR : AZ_URL, platform },
    plan: { summary: "", chapters: [], mechanical: [], by: "files" }, findings: [], human: { comments: [], visited: [] },
  };
  return {
    slug: `earlier-${++n}`, repo: worktree, worktree, context: 3, created: "now", pos: { item: 0, line: 0 }, doc: fit(doc, files), ...(queue ? { earlier: queue } : {}),
    previous: { head: A, at: "2026-09-30T10:00:00.000Z", round: 1, url: platform === "github" ? PR : AZ_URL, platform, items: [
      { ...GH_ITEM, status: "moved", to: { path: "src/a.rs", line: 23 } },
      { ...LEGACY, status: "unchanged", to: { path: "src/a.rs", line: 9 } },
      { kind: "summary", text: "Overall fine." },
    ] },
  };
}

test("flow: the queued replies and resolves are in the checklist, ticked, under Earlier threads; unticking one leaves it out of what posts", () => {
  const r = review();
  let fl = startFlow([], r.doc.human, ["approve", "request_changes", "comment"], undefined, undefined, { earlier: r.earlier });
  expect(fl.listed).toEqual(earlierKeys(QUEUE));
  expect(fl.ticked).toEqual(earlierKeys(QUEUE));
  expect(impliedVerdict([], {}, fl.ticked)).toBe("comment");
  const show = { findings: [], h: {}, place: () => "", label: (v: string) => v, keys: { tick: "Space", all: "a", editor: "v e", next: "Tab", back: "⇧Tab" } } as const;
  const text = stepLines(fl, show as any).map((l) => l.text);
  expect(text).toContain("Earlier threads, sent first (before the review):");
  expect(text).toContain("[x] reply · src/a.rs:20 · thanks, fixed");
  expect(text).toContain("[x] resolve · src/b.rs (whole file)");
  fl = toggle({ ...fl, at: 1 });
  fl = nextStep(fl, [], {});
  expect(fl.verdict).toBe("comment");
  const plan = planOf(r, files, { selection: selectionOf(fl) });
  expect(plan.posting!.earlier!.map((e) => `${e.kind} ${e.place}`)).toEqual(["reply src/a.rs:20", "resolve src/b.rs (whole file)"]);
  const preview = postPreview(plan, (v) => v);
  expect(preview).toContain("Earlier threads (2, sent first, before the review):\n  reply to src/a.rs:20\n    thanks, fixed\n  resolve src/b.rs (whole file)");
});

test("submit: sent first, recorded in the submission with ids, and what went out leaves the queue (the unticked one stays)", async () => {
  const r = review();
  let fl = startFlow([], r.doc.human, ["approve", "request_changes", "comment"], undefined, undefined, { earlier: r.earlier });
  fl = toggle({ ...fl, at: 2 }); // leave the whole-file resolve for later
  const gh = fakeGh();
  // A dry run prints the calls and changes nothing.
  const dry = await submit(r, files, { allowHook: false, selection: { ...selectionOf(fl), verdict: "comment" }, run: gh.run, dryRun: true });
  expect(dry.summary).toContain("comments/101/replies");
  expect(gh.calls).toEqual([]);
  expect(r.earlier).toEqual(QUEUE);
  const res = await submit(r, files, { allowHook: false, selection: { ...selectionOf(fl), verdict: "comment" }, run: gh.run, now: () => new Date("2026-10-01T10:00:00.000Z") });
  expect(res.ok).toBe(true);
  expect(res.submission.posted!.items!.map((i) => [i.kind, i.path])).toEqual([["reply", "src/a.rs"], ["resolve", "src/a.rs"]]);
  expect(res.submission.posted!.items![0]).toMatchObject({ reply_to: 101, comment_id: 900 });
  expect(res.submission.posted!.items![1]).toMatchObject({ comment_id: 101, thread_node_id: "PRRT_1" });
  expect(r.earlier).toEqual({ head: A, acts: [QUEUE.acts[1]!] });
  const written = parseDocument(readFileSync(res.submission.file, "utf8"));
  expect(written.submissions!.at(-1)!.posted!.items!.map((i) => i.kind)).toEqual(["reply", "resolve"]);
});

// ---------------------------------------------------------------- on the screen

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = async (app?: { lastFrame(): string | undefined }) => {
  await sleep(30);
  if (!app) return;
  let prev = app.lastFrame();
  for (let i = 0; i < 50; i++) { await sleep(20); const f = app.lastFrame(); if (f === prev) return; prev = f; }
};
const KEY = /\x1b\[[0-9;]*[A-Za-z~]|./gsu;

/** A fake gh for the background read: the PR's review comments (the legacy item is found there) and no threads. */
const readGh = async (argv: string[]) => argv[2] === "graphql"
  ? { exit: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } } }), stderr: "" }
  : { exit: 0, stdout: JSON.stringify([{ id: 101, node_id: "PRRC_101", path: "src/a.rs", line: 20, original_line: 20, body: "first look" }, { id: 102, node_id: "PRRC_102", path: "src/a.rs", line: 9, original_line: 9, body: "no ids" }]), stderr: "" };

test("screen: r writes a reply (r again edits it), R queues a resolve (again undoes); the row and the item say so; the submit flow lists them; the summary says why not", async () => {
  const r = review("github", null);
  const outcomes: Outcome[] = [];
  const app = render(<App review={r} files={files} onDone={(o) => outcomes.push(o)} size={{ cols: 120, rows: 60 }} remote={{ run: readGh }} copier={() => ({ ok: true, chars: 0, via: "test" })} />);
  await settle(app);
  const press = async (keys: string) => { for (const k of keys.match(KEY) ?? []) { app.stdin.write(k); await settle(app); } };
  const frame = () => (app.lastFrame() ?? "").replace(/\x1b\[[0-9;]*m/g, "");
  await press("gp");
  // On the chapter's own row: no reply key.
  expect(frame()).not.toMatch(/r\s+reply/);
  await press("\x1b[B");
  expect(frame()).toMatch(/r\s+reply/);
  expect(frame()).toMatch(/R\s+resolve/);
  await press("r");
  expect(frame()).toContain("Reply to your comment on src/a.rs:20");
  await press("thanks, fixed");
  await press("\r");
  expect(frame()).toContain("reply queued: it is sent with your next submit (s), before the new review");
  expect(rowText(r.previous!.items[0]!, 0, r.previous!, undefined, queuedText(r.earlier?.acts[0]))).toBe("a.rs:20 · moved to L23 · reading replies… · reply queued");
  expect(frame()).toContain("Your reply, queued:");
  // r again: prefilled with the queued reply, to edit.
  await press("r");
  expect(frame()).toContain("reply › thanks, fixed");
  await press("\x1b");
  await press("R");
  expect(frame()).toContain("resolve queued");
  expect(queuedText(r.earlier?.acts[0])).toBe("reply queued · resolve queued");
  await press("R");
  expect(frame()).toContain("resolve removed: the thread is left as it is");
  await press("R");
  expect(r.earlier?.acts).toEqual([{ key: itemKey(GH_ITEM), place: "src/a.rs:20", path: "src/a.rs", line: 20, side: "new", ids: { comment_id: 101, node_id: "PRRC_101" }, reply: "thanks, fixed", resolve: true }]);
  // The legacy item (no ids recorded) was found on the PR by the read: its thread's ids are used.
  await press("\x1b[B");
  await press("R");
  expect(r.earlier?.acts[1]).toMatchObject({ place: "src/a.rs:9", ids: { comment_id: 102, node_id: "PRRC_102" }, resolve: true });
  // The summary on GitHub has no thread.
  await press("\x1b[B");
  await press("r");
  expect(frame()).toContain("cannot reply to the summary: on GitHub it is the review's body, which has no thread");
  // The submit flow: the checklist lists them, ticked, and the send step shows them first.
  await press("s");
  expect(frame()).toContain("Earlier threads, sent first (before the review):");
  expect(frame()).toContain("[x] reply · src/a.rs:20 · thanks, fixed");
  expect(frame()).toContain("[x] resolve · src/a.rs:9");
  await press("\t");
  await press("\t");
  await press("\x1b");
  await press("\t");
  expect(frame()).toContain("Earlier threads (3, sent first, before the review):");
  expect(frame()).toContain("with gh: only 1 reply and 2");
  app.unmount();
});
