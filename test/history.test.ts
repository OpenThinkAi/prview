import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDiff } from "../src/diff.ts";
import { hunksOf } from "../src/guide.ts";
import { parseDocument, PostError, SCHEMA, type Doc } from "../src/document.ts";
import { github, postingOf, type Runner } from "../src/platform.ts";
import { done, freshStamp, historyDir, purgeHistory, stampOf, submissionsFor } from "../src/history.ts";
import { submit, type HookRunner } from "../src/submit.ts";
import { save, type Review } from "../src/build.ts";

// Submission history (AGT-1511): every submit kept under submitted/<slug>/, read back newest first with the legacy flat
// files, and the ids of what each one posted. $PRVIEW_HOME is a scratch directory; gh is a fake runner, no network.
let tmp = "", saved: string | undefined;
beforeAll(() => { saved = process.env.PRVIEW_HOME; tmp = mkdtempSync(join(tmpdir(), "prview-history-")); process.env.PRVIEW_HOME = join(tmp, "home"); });
afterAll(() => { rmSync(tmp, { recursive: true, force: true }); if (saved === undefined) delete process.env.PRVIEW_HOME; else process.env.PRVIEW_HOME = saved; });

const DIFF = `diff --git a/src/a.rs b/src/a.rs
index 1..2 100644
--- a/src/a.rs
+++ b/src/a.rs
@@ -10,3 +10,4 @@ fn main() {
 keep
-old
+new1
+new2
 keep2
`;
const files = parseDiff(DIFF);
const [h1] = hunksOf(files);
const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40);
const PR = "https://github.com/o/r/pull/7";
const noHook: HookRunner = () => { throw new Error("the hook must not run"); };
const noNet: Runner = () => { throw new Error("nothing may be posted"); };
const at = (iso: string) => () => new Date(iso);

let n = 0;
function review(human: Partial<Doc["human"]> = {}, target: Partial<Doc["target"]> = {}, slug = `h${++n}`): Review {
  const worktree = mkdtempSync(join(tmp, "wt-"));
  const doc: Doc = {
    schema: SCHEMA, target: { repo: "o/r", base: A, head: B, title: "A change", body: "", label: "main..x", ...target },
    plan: { summary: "", chapters: [], mechanical: [], by: "files" }, findings: [],
    human: { comments: [], visited: [], verdict: "approve", ...human },
  };
  return { slug, repo: tmp, worktree, context: 3, created: "now", pos: { item: 0, line: 0 }, doc };
}
const line = (text: string, l = 11, side: "new" | "old" = "new") => ({ hunk: h1!.id, side, line: l, text, at: "now" });
const summary = (text: string) => ({ hunk: null, side: "new" as const, line: null, text, at: "now" });
const whole = (text: string) => ({ hunk: h1!.id, side: "new" as const, line: null, text, at: "now", file: true as const });

// A fake gh: the review's comments are listed back with ids 501, 502, … (`listed` can reorder or pad that list).
type Over = { listed?: (made: any[]) => any[]; readFails?: boolean; submitFails?: boolean; fileId?: number };
function fakeGh(over: Over = {}) {
  const calls: string[] = [];
  let made: any[] = [];
  const run: Runner = (argv, o) => {
    const method = argv[3]!, path = argv[4]!, body = o.stdin === undefined ? undefined : JSON.parse(o.stdin);
    calls.push(`${method} ${path}`);
    if (method === "GET" && path.includes("/reviews/99/comments?")) {
      if (over.readFails) return { exit: 1, stdout: "", stderr: "gh: HTTP 502" };
      const page = Number(path.match(/page=(\d+)$/)![1]);
      const listed = (over.listed ?? ((x) => x))(made.map((c, i) => ({ id: 501 + i, node_id: `PRRC_${501 + i}`, path: c.path, line: c.line, side: c.side, body: c.body })));
      return { exit: 0, stdout: JSON.stringify(listed.slice((page - 1) * 100, page * 100)), stderr: "" };
    }
    if (method === "GET") return { exit: 0, stdout: JSON.stringify({ head: { sha: B } }), stderr: "" };
    if (path.endsWith("/reviews")) { made = body.comments; return { exit: 0, stdout: JSON.stringify({ id: 99 }), stderr: "" }; }
    if (path.endsWith("/pulls/7/comments")) return { exit: 0, stdout: JSON.stringify({ id: over.fileId ?? 801, node_id: `PRRC_${over.fileId ?? 801}` }), stderr: "" };
    if (path.endsWith("/events")) return over.submitFails ? { exit: 1, stdout: JSON.stringify({ message: "Unprocessable Entity" }), stderr: "" } : { exit: 0, stdout: JSON.stringify({ id: 99, html_url: `${PR}#pullrequestreview-99` }), stderr: "" };
    return { exit: 0, stdout: "{}", stderr: "" };
  };
  return { calls, run };
}

test("each submit is kept under its own UTC time; none overwrites another; the record names the reviewed head and platform", async () => {
  const r = review({ comments: [summary("first")] });
  const one = await submit(r, files, { allowHook: false, run: noNet, hook: noHook, now: at("2026-10-01T09:00:00.000Z") });
  r.doc.human.comments = [summary("second")]; r.doc.target.head = C;
  const two = await submit(r, files, { allowHook: false, run: noNet, hook: noHook, now: at("2026-10-01T10:00:00.000Z") });
  // The same instant twice still gets a file of its own.
  const three = await submit(r, files, { allowHook: false, run: noNet, hook: noHook, now: at("2026-10-01T10:00:00.000Z") });
  const dir = historyDir(r.slug);
  expect(one.submission.file).toBe(join(dir, "2026-10-01T090000.000Z.json"));
  expect(two.submission.file).toBe(join(dir, "2026-10-01T100000.000Z.json"));
  expect(three.submission.file).toBe(join(dir, "2026-10-01T100000.000Z-2.json"));
  expect(readdirSync(dir).sort()).toEqual(["2026-10-01T090000.000Z.json", "2026-10-01T090000.000Z.md", "2026-10-01T100000.000Z-2.json", "2026-10-01T100000.000Z-2.md", "2026-10-01T100000.000Z.json", "2026-10-01T100000.000Z.md"]);
  expect(submissionsFor(r.slug).map((s) => s.file)).toEqual([three.submission.file, two.submission.file, one.submission.file]);
  expect(existsSync(join(tmp, "home", "submitted", `${r.slug}.json`))).toBe(false);
  expect(one.submission).toMatchObject({ head: B });
  expect(two.submission).toMatchObject({ head: C });
  expect(parseDocument(readFileSync(one.submission.file, "utf8")).human.comments[0]!.text).toBe("first");

  const gh = review({}, { url: "https://github.com/o/r/pull/70", platform: "github" });
  const res = await submit(gh, files, { allowHook: false, run: fakeGh().run, now: at("2026-10-01T11:00:00.000Z") });
  expect(res.submission).toMatchObject({ head: B, platform: "github", posted: { platform: "github", ok: true, review_id: 99 } });
  expect(stampOf("2026-10-01T11:00:00.000Z")).toBe("2026-10-01T110000.000Z");
  expect(freshStamp(historyDir(gh.slug), "2026-10-01T11:00:00.000Z")).toBe("2026-10-01T110000.000Z-2");
});

test("the hook's copy goes next to its submission", async () => {
  const r = review();
  r.doc.on_submit = { run: ["true"] };
  const res = await submit(r, files, { allowHook: true, run: noNet, now: at("2026-10-01T12:00:00.000Z") });
  expect(res.submission.hook!.argv).toEqual(["true"]);
  expect(existsSync(join(historyDir(r.slug), "2026-10-01T120000.000Z.hook.json"))).toBe(true);
});

test("dry run records nothing: no history directory, no submission", async () => {
  const r = review({ comments: [line("why?")], verdict: "comment" }, { url: PR, platform: "github" });
  const res = await submit(r, files, { allowHook: false, run: noNet, hook: noHook, dryRun: true });
  expect(res.summary).toContain("reviews/<review id>/comments?per_page=100&page=1");
  expect(existsSync(historyDir(r.slug))).toBe(false);
  expect(r.doc.submissions).toBeUndefined();
  expect(submissionsFor(r.slug)).toEqual([]);
});

test("submissionsFor: a review's submissions newest first, a legacy flat file included; by PR URL across reviews", async () => {
  const r = review({ comments: [summary("new one")] }, { url: PR, platform: "github" }, "repo-pr-7");
  // A flat file from before every submit was kept: its record has no head (the document's is the reviewed one).
  const flat = join(tmp, "home", "submitted", "repo-pr-7.json");
  mkdirSync(join(tmp, "home", "submitted"), { recursive: true });
  writeFileSync(flat, JSON.stringify({ ...r.doc, target: { ...r.doc.target, head: A }, submissions: [{ at: "2026-09-01T00:00:00.000Z", verdict: "comment", file: flat, posted: { platform: "github", ok: true, url: PR } }] }));
  await submit(r, files, { allowHook: false, run: fakeGh().run, now: at("2026-09-20T00:00:00.000Z") });
  await submit(r, files, { allowHook: false, run: fakeGh().run, now: at("2026-09-25T00:00:00.000Z") });
  // Another clone's review of the same PR (a different slug), and a different PR.
  await submit(review({ comments: [summary("elsewhere")] }, { url: "https://github.com/O/R/pull/7/files", platform: "github" }, "other-pr-7"), files, { allowHook: false, run: fakeGh().run, now: at("2026-09-22T00:00:00.000Z") });
  await submit(review({}, { url: "https://github.com/o/r/pull/8" }, "repo-pr-8"), files, { allowHook: false, run: noNet, now: at("2026-09-30T00:00:00.000Z") });
  writeFileSync(join(historyDir("repo-pr-7"), "junk.json"), "not json");

  const mine = submissionsFor("repo-pr-7");
  expect(mine.map((s) => [s.at, s.head, s.legacy])).toEqual([
    ["2026-09-25T00:00:00.000Z", B, false],
    ["2026-09-20T00:00:00.000Z", B, false],
    ["2026-09-01T00:00:00.000Z", A, true],
  ]);
  expect(mine[0]!.submission).toMatchObject({ verdict: "approve", head: B, platform: "github", posted: { review_id: 99, items: [{ kind: "summary", text: "new one", review_id: 99 }] } });
  expect(mine[2]!.submission).toMatchObject({ verdict: "comment", file: flat });
  expect(mine[2]!.submission!.head).toBeUndefined();

  const byUrl = submissionsFor("https://github.com/o/r/pull/7");
  expect(byUrl.map((s) => [s.slug, s.at])).toEqual([
    ["repo-pr-7", "2026-09-25T00:00:00.000Z"],
    ["other-pr-7", "2026-09-22T00:00:00.000Z"],
    ["repo-pr-7", "2026-09-20T00:00:00.000Z"],
    ["repo-pr-7", "2026-09-01T00:00:00.000Z"],
  ]);
  expect(submissionsFor("https://github.com/o/r/pull/9")).toEqual([]);
  expect(submissionsFor("no-such-review")).toEqual([]);
  expect(() => submissionsFor("../etc")).toThrow("not a review name");
});

test("github: line comment ids are read back from the submitted review, matched by path, line, side and text, across pages", async () => {
  const comments = Array.from({ length: 101 }, (_, i) => line(`comment ${i}`, i % 2 ? 11 : 12, i % 3 ? "new" : "old"));
  const p = postingOf("comment", [...comments, summary("Overall fine.")], () => "src/a.rs");
  // GitHub lists them in its own order: reversed here, so the ids are matched, not taken by position.
  const { calls, run } = fakeGh({ listed: (made) => [...made].reverse() });
  const got = await github.post({ ...review().doc.target, url: PR, platform: "github" }, p, run, "/wt");
  expect(calls.filter((c) => c.includes("/reviews/99/comments?"))).toEqual(["GET repos/o/r/pulls/7/reviews/99/comments?per_page=100&page=1", "GET repos/o/r/pulls/7/reviews/99/comments?per_page=100&page=2"]);
  expect(got.review_id).toBe(99);
  expect(got.items).toHaveLength(102);
  expect(got.items![0]).toEqual({ kind: "line", path: "src/a.rs", line: 12, side: "old", text: "comment 0", review_id: 99, comment_id: 501, node_id: "PRRC_501" });
  expect(got.items![100]).toEqual({ kind: "line", path: "src/a.rs", line: 12, side: "new", text: "comment 100", review_id: 99, comment_id: 601, node_id: "PRRC_601" });
  expect(got.items!.at(-1)).toEqual({ kind: "summary", text: "Overall fine.", review_id: 99 });

  // Two identical comments on the same line each get their own id.
  const twin = postingOf("comment", [line("same"), line("same")], () => "src/a.rs");
  const t2 = await github.post({ ...review().doc.target, url: PR, platform: "github" }, twin, fakeGh().run, "/wt");
  expect(t2.items!.map((i) => i.comment_id)).toEqual([501, 502]);
});

test("github: a failed read-back still records the post (review id, no comment ids); a whole-file comment has its own ids", async () => {
  const p = postingOf("request_changes", [line("why?"), whole("whole file words")], () => "src/a.rs");
  const r = review({}, { url: PR, platform: "github" });
  r.doc.human = { comments: [line("why?"), whole("whole file words")], visited: [], verdict: "request_changes" };
  expect(p.files).toHaveLength(1);
  const res = await submit(r, files, { allowHook: false, run: fakeGh({ readFails: true }).run, now: at("2026-10-01T13:00:00.000Z") });
  expect(res.ok).toBe(true);
  expect(res.submission.posted).toEqual({ platform: "github", ok: true, url: `${PR}#pullrequestreview-99`, review_id: 99, items: [
    { kind: "line", path: "src/a.rs", line: 11, side: "new", text: "why?", review_id: 99 },
    { kind: "file", path: "src/a.rs", text: "whole file words", comment_id: 801, node_id: "PRRC_801" },
  ] });
  // The record survives a read of the written document.
  expect(parseDocument(readFileSync(res.submission.file, "utf8")).submissions!.at(-1)!.posted).toEqual(res.submission.posted);
});

test("github: a failed submit records the whole-file comments that stayed on the PR, with their ids", async () => {
  const r = review({ comments: [line("why?"), whole("whole file words")], verdict: "comment" }, { url: PR, platform: "github" });
  const { calls, run } = fakeGh({ submitFails: true });
  const res = await submit(r, files, { allowHook: false, run, now: at("2026-10-01T14:00:00.000Z") });
  expect(res.ok).toBe(false);
  expect(calls.at(-1)).toBe("DELETE repos/o/r/pulls/7/reviews/99");
  expect(res.submission.posted).toEqual({ platform: "github", ok: false, error: "gh api failed (exit 1): Unprocessable Entity", items: [
    { kind: "file", path: "src/a.rs", text: "whole file words", comment_id: 801, node_id: "PRRC_801" },
  ] });
  // Directly: a PostError carrying them.
  const e = await github.post(r.doc.target, postingOf("comment", [whole("w")], () => "src/a.rs"), fakeGh({ submitFails: true }).run, "/wt").then(() => undefined, (x) => x);
  expect(e).toBeInstanceOf(PostError);
  // Nothing on the PR: a plain error, no items.
  const plain = await github.post(r.doc.target, postingOf("comment", [summary("w")], () => "src/a.rs"), fakeGh({ submitFails: true }).run, "/wt").then(() => undefined, (x) => x);
  expect(plain).not.toBeInstanceOf(PostError);
});

test("the new record fields read back; junk in them is dropped", () => {
  const d = parseDocument({
    schema: SCHEMA, target: { base: A, head: B },
    submissions: [{
      at: "2026-10-01T00:00:00Z", file: "/f.json", head: B, platform: "azure-devops",
      posted: { platform: "azure-devops", ok: false, review_id: -1, items: [
        { kind: "line", path: "src/a.ts", line: 3, side: "old", text: "t", thread_id: 12, comment_id: 1 },
        { kind: "summary", text: "s", review_id: 5, node_id: "PRR_x" },
        { kind: "file", path: "x", text: "f", thread_id: 1.5, comment_id: "7", line: -2, side: "up" },
        { kind: "nonsense", text: "t" }, { kind: "line" }, "junk",
      ] },
    }, { at: "2026-10-01T00:00:00Z", file: "/g.json", head: "not a sha; rm -rf /" }],
  });
  expect(d.submissions).toEqual([
    { at: "2026-10-01T00:00:00Z", file: "/f.json", head: B, platform: "azure-devops", posted: { platform: "azure-devops", ok: false, items: [
      { kind: "line", path: "src/a.ts", line: 3, side: "old", text: "t", thread_id: 12, comment_id: 1 },
      { kind: "summary", text: "s", review_id: 5, node_id: "PRR_x" },
      { kind: "file", path: "x", text: "f" },
    ] } },
    { at: "2026-10-01T00:00:00Z", file: "/g.json" },
  ]);
});

test("prview done keeps the submission history; --purge removes it (and the legacy flat files)", async () => {
  const r = review({ comments: [summary("kept")] }, {}, "keep-me");
  await submit(r, files, { allowHook: false, run: noNet, now: at("2026-10-01T15:00:00.000Z") });
  writeFileSync(join(tmp, "home", "submitted", "keep-me.json"), JSON.stringify({ ...r.doc, submissions: [{ at: "2026-09-01T00:00:00Z", file: "x" }] }));
  writeFileSync(join(tmp, "home", "submitted", "keep-me.md"), "old");
  expect(existsSync(join(tmp, "home", "keep-me.json"))).toBe(true); // submit saved the review's state
  expect(done("keep-me", false)).toBe("removed keep-me · kept 2 submissions (prview done --purge keep-me removes them)");
  expect(existsSync(join(tmp, "home", "keep-me.json"))).toBe(false);
  expect(submissionsFor("keep-me")).toHaveLength(2);
  // The review is gone, its history is not: --purge still removes that.
  expect(done("keep-me", true)).toBe("purged 2 submissions");
  expect(existsSync(historyDir("keep-me"))).toBe(false);
  expect(existsSync(join(tmp, "home", "submitted", "keep-me.md"))).toBe(false);
  expect(() => done("keep-me", true)).toThrow("no review named keep-me");

  const s = review({}, {}, "purge-me");
  await submit(s, files, { allowHook: false, run: noNet, now: at("2026-10-01T16:00:00.000Z") });
  save(s);
  expect(done("purge-me", true)).toBe("removed purge-me · purged 1 submission");
  expect(purgeHistory("purge-me")).toBe(0);
  expect(() => done("../x", true)).toThrow("not a review name");
});
