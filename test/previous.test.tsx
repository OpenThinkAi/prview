import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { cleanup, render } from "ink-testing-library";
import { inkTestHooks } from "./ink-hooks.ts";
import { build, filesOf, save, type Review } from "../src/build.ts";
import { parseDiff } from "../src/diff.ts";
import { fit, SCHEMA, type Doc } from "../src/document.ts";
import { hunksOf } from "../src/guide.ts";
import { submissionsFor } from "../src/history.ts";
import {
  itemsOf, itemText, lastReached, located, matchAzure, matchGithub, movesOf, overviewText, prevMove, remoteText, statusText,
  type PrevItem, type Previous,
} from "../src/previous.ts";
import { readAzure, readGithub, readRemote, type AsyncRunner } from "../src/previous-read.ts";
import { ownFinding } from "../src/rows.ts";
import { selectionOf, startFlow } from "../src/submit-flow.ts";
import { submit } from "../src/submit.ts";
import { sinceFiles } from "../src/since.ts";
import type { Http, HttpReq } from "../src/azure-auth.ts";
import { App, type Outcome } from "../src/tui.tsx";

// The previous-comments chapter (re-review R3): which items, where each is now, and the platform's replies. Scratch
// repos, a fake gh (an AsyncRunner) and a fake Http: nothing reaches a network or a real pull request.
let tmp = "", savedHome: string | undefined;
beforeAll(() => {
  savedHome = process.env.PRVIEW_HOME;
  tmp = mkdtempSync(join(tmpdir(), "prview-prev-"));
  process.env.PRVIEW_HOME = join(tmp, "home");
});
inkTestHooks();
afterAll(() => {
  cleanup();
  rmSync(tmp, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.PRVIEW_HOME; else process.env.PRVIEW_HOME = savedHome;
});

const A = "a".repeat(40), B = "b".repeat(40);
const line = (path: string, n: number, text: string, extra: Partial<PrevItem> = {}): PrevItem => ({ kind: "line", path, line: n, side: "new", text, ...extra });

// ---------------------------------------------------------------- where each item is now

// The old head → new head diff: in src/a.ts, 3 lines added after line 2 and line 10 edited; src/b.ts removed; src/c.ts
// renamed to src/d.ts with a line added at the top; src/e.ts untouched.
const MOVES = parseDiff(`diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -2,0 +3,3 @@
+x
+y
+z
@@ -10 +13 @@
-old ten
+new ten
diff --git a/src/b.ts b/src/b.ts
deleted file mode 100644
--- a/src/b.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-one
-two
diff --git a/src/c.ts b/src/d.ts
similarity index 90%
rename from src/c.ts
rename to src/d.ts
--- a/src/c.ts
+++ b/src/d.ts
@@ -0,0 +1 @@
+top
`);

test("located: every status, from the old→new diff", () => {
  const items: PrevItem[] = [
    line("src/a.ts", 1, "above the insert"), line("src/a.ts", 5, "below it"), line("src/a.ts", 10, "on the edit"),
    line("src/b.ts", 1, "file gone"), line("src/c.ts", 4, "renamed"), line("src/e.ts", 7, "untouched"),
    { kind: "file", path: "src/a.ts", text: "whole a" }, { kind: "file", path: "src/e.ts", text: "whole e" }, { kind: "file", path: "src/b.ts", text: "whole b" },
    line("src/a.ts", 6, "old side", { side: "old" }), { kind: "summary", text: "overall" },
  ];
  const out = located(items, movesOf({ files: sinceFiles(MOVES) }));
  expect(out.map((i) => statusText(i))).toEqual([
    "unchanged", "moved to L8", "line changed", "file removed", "moved to src/d.ts:L5", "unchanged",
    "file changed", "unchanged", "file removed", "unchanged", "",
  ]);
  expect(out[2]!.to).toEqual({ path: "src/a.ts", line: 13 });
  expect(out[9]!.to).toEqual({ path: "src/a.ts", line: 6, side: "old" });
  expect(out[10]!.status).toBeUndefined();
  // The head you reviewed is not in the clone: every status is unknown, and a summary still has none.
  expect(located(items, undefined).map((i) => statusText(i))).toEqual([...Array(9).fill("status unknown"), "status unknown", ""]);
});

test("the chapter's items: the record's posted items with their ids; a legacy record falls back to its document's comments", () => {
  const doc = (head: string, comments: Doc["human"]["comments"], subs?: Doc["submissions"]): Doc => ({
    schema: SCHEMA, target: { repo: "r", base: "e".repeat(40), head, title: "T", body: "", label: "o/r#7", url: "https://github.com/o/r/pull/7", platform: "github" },
    plan: { summary: "", chapters: [], mechanical: [], by: "files" }, findings: [], human: { comments, visited: [] }, ...(subs ? { submissions: subs } : {}),
  });
  const withIds = { file: "f", doc: doc(A, []), at: "2026-09-30T10:00:00.000Z", head: A, legacy: false, slug: "s",
    submission: { at: "2026-09-30T10:00:00.000Z", file: "f", head: A, posted: { platform: "github", ok: true, items: [{ kind: "line" as const, path: "a.ts", line: 3, side: "new" as const, text: "hi", comment_id: 11 }] } } };
  expect(itemsOf(withIds)).toEqual([{ kind: "line", path: "a.ts", line: 3, side: "new", text: "hi", comment_id: 11 }]);
  const legacyDoc = doc(B, [
    { hunk: "a.ts@1:1", side: "new", line: 2, text: "on a line", at: "x" }, { hunk: "a.ts@1:1", side: "new", line: null, text: "on the file", at: "x", file: true },
    { hunk: null, side: "new", line: null, text: "the summary", at: "x" },
  ]);
  const legacy = { file: "g", doc: legacyDoc, at: "2026-09-29T10:00:00.000Z", head: B, legacy: true, slug: "s", submission: { at: "2026-09-29T10:00:00.000Z", file: "g", posted: { platform: "github", ok: true } } };
  expect(itemsOf(legacy)).toEqual([
    { kind: "line", path: "a.ts", side: "new", line: 2, text: "on a line" }, { kind: "file", path: "a.ts", text: "on the file" }, { kind: "summary", text: "the summary" },
  ]);
  // A post that failed with nothing through is not the last submit that reached the PR; rounds count those that did.
  const failed = { ...withIds, at: "2026-10-01T00:00:00.000Z", submission: { at: "2026-10-01T00:00:00.000Z", file: "h", head: B, posted: { platform: "github", ok: false, error: "boom" } } };
  const l = lastReached([failed, withIds, legacy]);
  expect(l?.sub).toBe(withIds);
  expect(l?.round).toBe(2);
});

// ---------------------------------------------------------------- the platform's side

const ITEMS: PrevItem[] = [
  line("src/a.ts", 5, "rename this", { comment_id: 101 }),
  line("src/a.ts", 9, "legacy, no id"),
  { kind: "file", path: "src/b.ts", text: "whole file note" },
  { kind: "summary", text: "Overall fine." },
];

const GH_COMMENTS = [
  { id: 101, path: "src/a.ts", line: null, original_line: 5, body: "rename this", user: { login: "me" }, created_at: "2026-09-30T10:00:00Z" },
  { id: 102, path: "src/a.ts", line: 9, original_line: 9, body: "legacy, no id", user: { login: "me" }, created_at: "2026-09-30T10:00:00Z" },
  { id: 103, path: "src/b.ts", line: null, subject_type: "file", body: "whole file note", user: { login: "me" }, created_at: "2026-09-30T10:00:00Z" },
  { id: 201, in_reply_to_id: 101, body: "done \x1b]0;pwned\x07in the next push", user: { login: "author" }, created_at: "2026-09-30T12:00:00Z" },
  { id: 200, in_reply_to_id: 101, body: "good point", user: { login: "author" }, created_at: "2026-09-30T11:00:00Z" },
  { id: 202, in_reply_to_id: 102, body: "won't fix", user: { login: "author" }, created_at: "2026-09-30T13:00:00Z" },
];

test("GitHub: matched by id, else path, line and text; replies oldest first, cleaned; resolved from the threads", () => {
  const t = matchGithub(ITEMS, GH_COMMENTS, new Map([[101, true], [102, false]]));
  expect(t[0]).toEqual({ found: true, resolved: true, replies: [
    { author: "author", at: "2026-09-30T11:00:00Z", text: "good point" }, { author: "author", at: "2026-09-30T12:00:00Z", text: "done in the next push" },
  ], ids: { comment_id: 101 } });
  // The thread as found, for a reply or resolve on a legacy item (earlier.ts): its first comment's id.
  expect(t[1]).toMatchObject({ found: true, resolved: false, replies: [{ text: "won't fix" }], ids: { comment_id: 102 } });
  expect(t[2]).toEqual({ found: true, replies: [], ids: { comment_id: 103 } });
  expect(t[3]).toEqual({ found: false, replies: [] });
  const remote = { ok: true as const, threads: t };
  expect(ITEMS.map((i, n) => remoteText(remote, n, i, "github"))).toEqual(["2 replies · resolved", "1 reply · open", "no replies", ""]);
});

/** A fake gh: review comments in pages of `per`, and the GraphQL threads; `fail` names a call that fails. */
function fakeGh(comments: unknown[], opts: { fail?: "comments" | "graphql"; per?: number } = {}) {
  const calls: string[][] = [];
  const run: AsyncRunner = async (argv) => {
    calls.push(argv);
    if (argv[0] !== "gh" || argv[1] !== "api") return { exit: 1, stdout: "", stderr: "not gh api" };
    if (argv[2] === "graphql") {
      if (opts.fail === "graphql") return { exit: 1, stdout: "", stderr: "GraphQL: forbidden" };
      const after = argv.find((a) => a.startsWith("c="));
      const nodes = after ? [{ isResolved: false, comments: { nodes: [{ databaseId: 102 }] } }] : [{ isResolved: true, comments: { nodes: [{ databaseId: 101 }] } }];
      return { exit: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: !after, endCursor: "CUR" }, nodes } } } } }), stderr: "" };
    }
    if (opts.fail === "comments") return { exit: 1, stdout: JSON.stringify({ message: "Not Found" }), stderr: "" };
    const page = Number(argv[2]!.match(/page=(\d+)$/)![1]), per = opts.per ?? 100;
    // The fake's own page size stands in for GitHub's 100: a full page means there may be more.
    const slice = comments.slice((page - 1) * per, page * per);
    return { exit: 0, stdout: JSON.stringify(per === 100 ? slice : [...slice, ...Array(slice.length === per ? 100 - per : 0).fill({})]), stderr: "" };
  };
  return { run, calls };
}

test("GitHub read: every page of review comments, the GraphQL threads paged, through gh api only", async () => {
  const gh = fakeGh(GH_COMMENTS, { per: 2 });
  const r = await readGithub({ url: "https://github.com/o/r/pull/7", items: ITEMS }, gh.run, "/x");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.threads.map((t) => [t.found, t.replies.length, t.resolved])).toEqual([[true, 2, true], [true, 1, false], [true, 0, undefined], [false, 0, undefined]]);
  expect(gh.calls.every((c) => c[0] === "gh" && c[1] === "api")).toBe(true);
  expect(gh.calls.filter((c) => c[2]!.startsWith("repos/o/r/pulls/7/comments?per_page=100&page=")).length).toBe(4);
  expect(gh.calls.filter((c) => c[2] === "graphql").length).toBe(2);
});

test("GitHub read failures: the comments failing is a reason; the threads failing only leaves resolved unknown", async () => {
  const bad = await readGithub({ url: "https://github.com/o/r/pull/7", items: ITEMS }, fakeGh(GH_COMMENTS, { fail: "comments" }).run, "/x");
  expect(bad).toEqual({ ok: false, reason: "gh api failed (exit 1): Not Found" });
  expect(remoteText(bad, 0, ITEMS[0]!, "github")).toBe("replies unavailable (gh api failed (exit 1): Not Found)");
  const half = await readGithub({ url: "https://github.com/o/r/pull/7", items: ITEMS }, fakeGh(GH_COMMENTS, { fail: "graphql" }).run, "/x");
  expect(half.ok && half.threads[0]).toEqual({ found: true, replies: expect.any(Array), ids: { comment_id: 101 } });
  // gh not there at all: a reason, never a throw.
  const none: AsyncRunner = async () => { throw new Error("spawn gh ENOENT"); };
  expect(await readRemote({ head: A, at: "", round: 1, url: "https://github.com/o/r/pull/7", platform: "github", items: ITEMS }, { run: none })).toEqual({ ok: false, reason: "spawn gh ENOENT" });
  expect(await readRemote({ head: A, at: "", round: 1, platform: "gitlab", items: ITEMS })).toEqual({ ok: false, reason: "not on gitlab yet" });
});

const AZ_URL = "https://dev.azure.com/contoso/web/_git/web/pullrequest/42";
const AZ_ITEMS: PrevItem[] = [
  line("src/a.ts", 5, "rename this", { thread_id: 7, comment_id: 1 }),
  line("src/a.ts", 9, "legacy, no id"),
  { kind: "file", path: "src/b.ts", text: "whole file note" },
  { kind: "summary", text: "Overall fine.", thread_id: 10 },
];
const AZ_THREADS = [
  { id: 7, status: "fixed", threadContext: { filePath: "/src/a.ts", rightFileStart: { line: 5, offset: 1 } }, comments: [
    { id: 1, parentCommentId: 0, content: "rename this", author: { displayName: "Me" }, publishedDate: "2026-09-30T10:00:00Z", commentType: "text" },
    { id: 3, parentCommentId: 1, content: "done\x1b[2J", author: { displayName: "Author" }, publishedDate: "2026-09-30T12:00:00Z", commentType: "text" },
    { id: 2, parentCommentId: 1, content: "on it", author: { displayName: "Author" }, publishedDate: "2026-09-30T11:00:00Z", commentType: "text" },
    { id: 4, parentCommentId: 0, content: "Author changed the status to Fixed", author: { displayName: "Author" }, publishedDate: "2026-09-30T12:01:00Z", commentType: "system" },
    { id: 5, parentCommentId: 1, content: "deleted", author: { displayName: "Author" }, publishedDate: "2026-09-30T12:02:00Z", commentType: "text", isDeleted: true },
  ] },
  { id: 8, status: "active", threadContext: { filePath: "/src/a.ts", rightFileStart: { line: 9, offset: 1 } }, comments: [
    { id: 1, parentCommentId: 0, content: "legacy, no id", author: { displayName: "Me" }, publishedDate: "2026-09-30T10:00:00Z", commentType: "text" },
  ] },
  { id: 9, status: "wontFix", threadContext: { filePath: "/src/b.ts" }, comments: [
    { id: 1, parentCommentId: 0, content: "whole file note", author: { displayName: "Me" }, publishedDate: "2026-09-30T10:00:00Z", commentType: "text" },
    { id: 2, parentCommentId: 1, content: "by design", author: { displayName: "Author" }, publishedDate: "2026-09-30T11:00:00Z", commentType: "text" },
  ] },
  { id: 10, status: "closed", comments: [
    { id: 1, parentCommentId: 0, content: "Overall fine.", author: { displayName: "Me" }, publishedDate: "2026-09-30T10:00:00Z", commentType: "text" },
  ] },
];

test("Azure DevOps: matched by thread id, else path, line and text; replies are the later comments; resolved from the status", () => {
  const t = matchAzure(AZ_ITEMS, AZ_THREADS);
  expect(t[0]).toEqual({ found: true, resolved: true, replies: [
    { author: "Author", at: "2026-09-30T11:00:00Z", text: "on it" }, { author: "Author", at: "2026-09-30T12:00:00Z", text: "done" },
  ], ids: { thread_id: 7, comment_id: 1 } });
  expect(t[1]).toEqual({ found: true, resolved: false, replies: [], ids: { thread_id: 8, comment_id: 1 } });
  expect(t[2]).toMatchObject({ found: true, resolved: true, replies: [{ text: "by design" }] });
  expect(t[3]).toEqual({ found: true, resolved: true, replies: [], ids: { thread_id: 10, comment_id: 1 } });
  expect(AZ_ITEMS.map((i, n) => remoteText({ ok: true, threads: t }, n, i, "azure-devops"))).toEqual(["2 replies · resolved", "no replies · open", "1 reply · resolved", "no replies · resolved"]);
});

test("Azure DevOps read: GET the PR's threads through the Http; a refusal is a reason", async () => {
  const seen: HttpReq[] = [];
  const http: Http = async (req) => { seen.push(req); return { status: 200, json: { value: AZ_THREADS }, text: "" }; };
  const r = await readAzure({ url: AZ_URL, items: AZ_ITEMS }, http);
  expect(r.ok && r.threads.map((t) => t.found)).toEqual([true, true, true, true]);
  expect(seen).toEqual([{ method: "GET", url: "https://dev.azure.com/contoso/web/_apis/git/repositories/web/pullRequests/42/threads?api-version=7.1", headers: { Accept: "application/json" } }]);
  const denied: Http = async () => ({ status: 401, json: { message: "TF400813: not authorized" }, text: "" });
  const bad = await readRemote({ head: A, at: "", round: 1, url: AZ_URL, platform: "azure-devops", items: AZ_ITEMS }, { http: denied });
  expect(bad.ok).toBe(false);
  expect(remoteText(bad, 0, AZ_ITEMS[0]!, "azure-devops")).toMatch(/^replies unavailable \(azure: not allowed to read the threads of .*HTTP 401/);
});

test("the item's text: yours, the code then and now, the replies; the overview lists every item", () => {
  const p: Previous = { head: A, at: "2026-09-30T10:00:00.000Z", round: 1, platform: "github", url: "https://github.com/o/r/pull/7", items: [
    { ...line("src/a.ts", 5, "rename this", { comment_id: 101 }), status: "moved", to: { path: "src/a.ts", line: 8 }, old: { start: 4, lines: ["four", "five", "six"], mark: 5 }, now: { start: 7, lines: ["seven", "five", "nine"], mark: 8 } },
  ] };
  const remote = { ok: true as const, threads: [{ found: true, resolved: true, replies: [{ author: "author", at: "2026-09-30T11:00:00Z", text: "good point" }] }] };
  const t = itemText(p.items[0]!, 0, p, remote);
  expect(t.title).toBe("Your previous comment · src/a.ts:5 · moved to L8");
  expect(t.body).toContain("You wrote (2026-09-30, at aaaaaaa):\nrename this");
  expect(t.body).toContain("Then (aaaaaaa):\n  4  four\n› 5  five\n  6  six");
  expect(t.body).toContain("Now:\n  7  seven\n› 8  five\n  9  nine");
  expect(t.body).toContain("On the PR: 1 reply · resolved.");
  expect(t.body).toContain("author · 2026-09-30 11:00\ngood point");
  expect(t.copy).toBe("src/a.ts:5\n\nrename this");
  expect(overviewText(p, remote, { open: "→", copy: "y" })).toContain("- src/a.ts:5 · moved to L8 · 1 reply · resolved");
});

test("moving in the chapter: its row, then its items; off the end goes on; a collapsed chapter is one stop", () => {
  expect(prevMove(2, false, -1, "down")).toEqual({ at: 0, collapsed: false });
  expect(prevMove(2, false, 1, "down")).toEqual({ at: 1, collapsed: false, out: "down" });
  expect(prevMove(2, false, 0, "up")).toEqual({ at: -1, collapsed: false });
  expect(prevMove(2, false, 0, "expand")).toEqual({ at: 0, collapsed: false, enter: true });
  expect(prevMove(2, false, 1, "collapse")).toEqual({ at: -1, collapsed: false });
  expect(prevMove(2, false, -1, "collapse")).toEqual({ at: -1, collapsed: true });
  expect(prevMove(2, true, -1, "down")).toEqual({ at: -1, collapsed: true, out: "down" });
  expect(prevMove(2, true, -1, "expand")).toEqual({ at: -1, collapsed: false });
});

// ---------------------------------------------------------------- built from a real repo

const git = (cwd: string, ...args: string[]) => {
  const p = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
};

test("a range submitted at one head and reopened at another: the chapter's statuses and code, and nothing of it carried", async () => {
  const repo = join(tmp, "range");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  const ten = Array.from({ length: 20 }, (_, i) => `a${i + 1}`);
  writeFileSync(join(repo, "a.ts"), ten.join("\n") + "\n");
  writeFileSync(join(repo, "b.ts"), "b1\nb2\n");
  git(repo, "add", "."); git(repo, "commit", "-qm", "base");
  git(repo, "checkout", "-q", "-b", "feature");
  writeFileSync(join(repo, "a.ts"), ten.map((l, i) => i === 4 || i === 9 || i === 14 ? `${l} changed` : l).join("\n") + "\n");
  writeFileSync(join(repo, "b.ts"), "b1 changed\nb2\n");
  git(repo, "add", "."); git(repo, "commit", "-qm", "one");
  const first = git(repo, "rev-parse", "HEAD");
  const r1 = await build(repo, "main..feature", { ai: null });
  const files1 = filesOf(r1), hs = hunksOf(files1);
  const hunkOf = (path: string, n: number) => hs.find((h) => h.file.path === path && h.hunk?.lines.some((l) => l.n === n))!.id;
  for (const [path, n, text] of [["a.ts", 5, "on five"], ["a.ts", 10, "on ten"], ["a.ts", 15, "on fifteen"], ["b.ts", 1, "on b"]] as const) {
    const made = ownFinding(r1.doc.findings, r1.doc.human, { hunk: hunkOf(path, n), side: "new", line: n }, "medium", text, "2026-09-30T10:00:00.000Z");
    r1.doc.findings.push(made.finding); r1.doc.human = made.human;
  }
  const fl = startFlow(r1.doc.findings, r1.doc.human, ["approve", "request_changes", "comment"]);
  const res = await submit(r1, files1, { allowHook: false, selection: { ...selectionOf(fl), verdict: "comment" }, now: () => new Date("2026-09-30T10:05:00.000Z") });
  expect(res.ok).toBe(true);
  expect(submissionsFor(r1.slug)[0]?.head).toBe(first);
  save(r1);

  // The author adds two lines at the top of a.ts (five and fifteen move down two), rewrites line ten, and removes b.ts.
  const now = ten.map((l, i) => i === 4 || i === 14 ? `${l} changed` : i === 9 ? "a10 rewritten" : l);
  writeFileSync(join(repo, "a.ts"), ["new top", "another", ...now].join("\n") + "\n");
  rmSync(join(repo, "b.ts"));
  git(repo, "add", "-A"); git(repo, "commit", "-qm", "two");
  const said: string[] = [];
  const r2 = await build(repo, "main..feature", { ai: null, say: (s) => said.push(s) });
  expect(r2.previous?.head).toBe(first);
  expect(r2.previous?.items.map((i) => [i.text, statusText(i)])).toEqual([["on five", "moved to L7"], ["on ten", "line changed"], ["on fifteen", "moved to L17"], ["on b", "file removed"]]);
  expect(r2.previous?.items[0]?.old?.lines).toContain("a5 changed");
  expect(r2.previous?.items[0]?.now).toEqual({ start: 4, lines: ["a2", "a3", "a4", "a5 changed", "a6", "a7", "a8"], mark: 7 });
  expect(said.some((s) => s.startsWith("re-review: your last submit") && s.includes("recorded 4 items") && !s.includes("posted") && s.includes("g p"))).toBe(true);
  // What that submit posted is the chapter, not comments of the reader's at the new head: nothing of it can post again.
  expect(r2.doc.human.comments).toEqual([]);
});

// ---------------------------------------------------------------- on the screen

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = async (app?: { lastFrame(): string | undefined }) => {
  await sleep(30);
  if (!app) return;
  let prev = app.lastFrame();
  for (let i = 0; i < 50; i++) { await sleep(20); const f = app.lastFrame(); if (f === prev) return; prev = f; }
};
const KEY = /\x1b\[[0-9;]*[A-Za-z~]|./gsu;

function screenReview(platform: string | undefined): Review {
  const doc: Doc = {
    schema: SCHEMA, target: { repo: "/nowhere", base: "e".repeat(40), head: B, title: "A change", body: "", label: "o/r#7", ...(platform ? { url: "https://github.com/o/r/pull/7", platform } : {}) },
    plan: { summary: "", chapters: [], mechanical: [], by: "files" }, findings: [], human: { comments: [], visited: [] },
  };
  return {
    slug: "screen-prev", repo: "/nowhere", worktree: "/nowhere", context: 3, created: "now", pos: { item: 0, line: 0 }, doc: fit(doc, files),
    previous: { head: A, at: "2026-09-30T10:00:00.000Z", round: 1, ...(platform ? { url: "https://github.com/o/r/pull/7", platform } : {}), items: [
      { ...line("src/a.rs", 20, "first look", { comment_id: 101 }), status: "moved", to: { path: "src/a.rs", line: 23 } },
      { ...line("src/gone.rs", 3, "about a file now gone"), status: "file removed" },
      { kind: "summary", text: "Overall fine." },
    ] },
  };
}

test("screen: the chapter heads the table of contents; g p goes to it; ↓ shows an item with its replies; → goes to its line; y copies it", async () => {
  const r = screenReview("github");
  const copied: string[] = [];
  const gh = fakeGh([
    { id: 101, path: "src/a.rs", line: 20, original_line: 20, body: "first look", user: { login: "me" }, created_at: "2026-09-30T10:00:00Z" },
    { id: 300, in_reply_to_id: 101, body: "fixed \x1b[31mit", user: { login: "author" }, created_at: "2026-09-30T11:00:00Z" },
  ]);
  const outcomes: Outcome[] = [];
  const app = render(<App review={r} files={files} onDone={(o) => outcomes.push(o)} size={{ cols: 120, rows: 60 }} remote={{ run: gh.run }} copier={(t) => { copied.push(t); return { ok: true, chars: t.length, via: "test" }; }} />);
  await settle(app);
  const press = async (keys: string) => { for (const k of keys.match(KEY) ?? []) { app.stdin.write(k); await settle(app); } };
  const frame = () => (app.lastFrame() ?? "").replace(/\x1b\[[0-9;]*m/g, "");
  expect(frame()).toContain("▾ Your previous comments (3)");
  expect(frame()).toContain("a.rs:20 · moved to L23");
  expect(frame()).toContain("gone.rs:3 · file removed");
  // g p: on the chapter's own row, its overview in the content area, every item with its status and the replies.
  await press("\x1b[C"); // into the code first
  await press("gp");
  expect(frame()).toContain("Your previous comments · 3");
  expect(frame()).toContain("posted 3 items");
  expect(frame()).toContain("- src/a.rs:20 · moved to L23 · 1 reply");
  expect(frame()).toContain("- src/gone.rs:3 · file removed · not found on the PR");
  // ↓: the first item, its text, its reply (cleaned) and the code at its new line.
  await press("\x1b[B");
  expect(frame()).toContain("Your previous comment · src/a.rs:20 · moved to L23");
  expect(frame()).toContain("You wrote (2026-09-30, at aaaaaaa):");
  expect(frame()).toContain("fixed it");
  expect(frame()).not.toContain("\x1b[31mit");
  await press("y");
  expect(copied).toEqual(["src/a.rs:20\n\nfirst look"]);
  // →: into the code at line 23, the item still in the content area.
  await press("\x1b[C");
  expect(frame()).toContain("keys"); // the code's key panel
  expect(frame()).toMatch(/23 .*\+new3/);
  expect(frame()).toContain("Your previous comment · src/a.rs:20");
  // Back in the chapter, the removed file has nowhere to go; ↓ past the last item goes on to the first chapter.
  await press("gp");
  await press("\x1b[B\x1b[B\x1b[C");
  expect(frame()).toContain("its file is gone at this head");
  await press("\x1b[B\x1b[B");
  expect(frame()).toContain("1 · ");
  // ↑ from the first chapter's row comes back into the chapter, at its last item.
  await press("\x1b[A");
  expect(frame()).toContain("Your previous comment · summary");
  app.unmount();
});

test("screen: a failed read says why beside every item; no platform reads nothing; g p outside a re-review says so", async () => {
  const fail = fakeGh([], { fail: "comments" });
  const app = render(<App review={screenReview("github")} files={files} onDone={() => {}} size={{ cols: 140, rows: 40 }} remote={{ run: fail.run }} />);
  await settle(app);
  const frame = () => (app.lastFrame() ?? "").replace(/\x1b\[[0-9;]*m/g, "");
  for (const k of ["g", "p"]) { app.stdin.write(k); await settle(app); }
  expect(frame()).toContain("- src/a.rs:20 · moved to L23 · replies unavailable (gh api failed (exit 1): Not Found)");
  app.unmount();

  const calls: string[][] = [];
  const quiet = render(<App review={screenReview(undefined)} files={files} onDone={() => {}} size={{ cols: 120, rows: 40 }} remote={{ run: async (a) => { calls.push(a); return { exit: 0, stdout: "[]", stderr: "" }; } }} />);
  await settle(quiet);
  expect((quiet.lastFrame() ?? "").replace(/\x1b\[[0-9;]*m/g, "")).toContain("a.rs:20 · moved to L23");
  expect(calls).toEqual([]);
  quiet.unmount();

  const plain = screenReview(undefined);
  delete plain.previous;
  const none = render(<App review={plain} files={files} onDone={() => {}} size={{ cols: 120, rows: 40 }} />);
  await settle(none);
  for (const k of ["g", "p"]) { none.stdin.write(k); await settle(none); }
  expect((none.lastFrame() ?? "").replace(/\x1b\[[0-9;]*m/g, "")).toContain("no previous comments: this is not a re-review");
  none.unmount();
});


test("readGithub refuses a URL whose owner or repo could rewrite the gh api path", async () => {
  for (const url of ["https://github.com/../r/pull/7", "https://github.com/o/../pull/7", "https://github.com/./r/pull/7", "https://github.com/o/r%2f..%2f/pull/7", "https://github.com/o?x=1/r/pull/7", "https://evil.test/https://github.com/o/r/pull/7", "http://github.com/o/r/pull/7"]) {
    const gh = fakeGh(GH_COMMENTS);
    expect(await readGithub({ url, items: ITEMS }, gh.run, "/x"), url).toEqual({ ok: false, reason: "no GitHub pull request URL" });
  }
});
