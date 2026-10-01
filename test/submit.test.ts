import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDiff } from "../src/diff.ts";
import { hunksOf } from "../src/guide.ts";
import { argvOf, merge, parseDocument, SCHEMA, splitArgs, type Doc } from "../src/document.ts";
import { adapterFor, github, postingOf, type Runner } from "../src/platform.ts";
import { describe, hookOf, planOf, postPreview, redirectRefusal, runHook, shown, submit, type HookRunner } from "../src/submit.ts";
import type { Review } from "../src/build.ts";
import { decide } from "../src/triage.ts";

// Submitting writes under $PRVIEW_HOME and runs the hook in the review's worktree: both are scratch
// directories here. Posting never reaches a network: the adapter is handed a fake runner.
let tmp = "", saved: string | undefined;
beforeAll(() => { saved = process.env.PRVIEW_HOME; tmp = mkdtempSync(join(tmpdir(), "prview-submit-")); process.env.PRVIEW_HOME = join(tmp, "home"); });
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
const A = "a".repeat(40), B = "b".repeat(40);
const PR = "https://github.com/o/r/pull/7";

let n = 0;
function review(over: Partial<Doc> = {}, target: Partial<Doc["target"]> = {}): Review {
  const worktree = mkdtempSync(join(tmp, "wt-"));
  const doc: Doc = {
    schema: SCHEMA, target: { repo: "o/r", base: A, head: B, title: "A change", body: "", label: "main..x", ...target },
    plan: { summary: "", chapters: [], mechanical: [], by: "files" }, findings: [],
    human: { comments: [], visited: [], verdict: "approve" }, ...over,
  };
  return { slug: `s${++n}`, repo: worktree, worktree, context: 3, created: "now", pos: { item: 0, line: 0 }, doc };
}
const noHook: HookRunner = () => { throw new Error("the hook must not run"); };
const noNet: Runner = () => { throw new Error("nothing may be posted"); };

test("on_submit is an argv: a string is split with quotes and no shell; what cannot be split cleanly is no command", () => {
  expect(splitArgs(`cat {file} > /tmp/x`)).toEqual(["cat", "{file}", ">", "/tmp/x"]);
  expect(splitArgs(`tool --msg "two words" 'it''s' a\\ b ""`)).toEqual(["tool", "--msg", "two words", "its", "a b", ""]);
  expect(splitArgs(`echo $(whoami); rm -rf ~`)).toEqual(["echo", "$(whoami);", "rm", "-rf", "~"]); // literal words, never run by a shell
  expect(splitArgs(`tool "open`)).toBeNull();
  expect(argvOf(["a", 1])).toBeNull();
  expect(argvOf("")).toBeNull();
  expect(argvOf(Array(65).fill("a"))).toBeNull();
  const doc = (run: unknown) => parseDocument({ schema: SCHEMA, target: { base: A, head: B }, on_submit: { run } });
  expect(doc("notify --file {file}").on_submit).toEqual({ run: ["notify", "--file", "{file}"] });
  expect(doc(["notify", "{file}"]).on_submit).toEqual({ run: ["notify", "{file}"] });
  expect(doc(5).on_submit).toBeUndefined();
  expect(doc(`bad "quote`).on_submit).toBeUndefined();
});

test("the hook as it runs: {file} is the only thing filled in; a trailing > path takes stdout, resolved in the worktree", () => {
  expect(hookOf(["cat", "{file}", ">", "out.txt"], "/h/s.json", "/wt")).toEqual({ argv: ["cat", "/h/s.json"], cwd: "/wt", stdout: "/wt/out.txt", timeoutMs: 60_000 });
  expect(hookOf(["cat", "{file}", ">sub/x"], "/h/a b.json", "/wt")).toEqual({ argv: ["cat", "/h/a b.json"], cwd: "/wt", stdout: "/wt/sub/x", timeoutMs: 60_000 });
  expect(hookOf(["tool", "--in={file}", "$HOME", "{target}"], "/f", "/wt").argv).toEqual(["tool", "--in=/f", "$HOME", "{target}"]);
  expect(hookOf([">", "x"], "/f", "/wt").stdout).toBeUndefined(); // a redirect with no command is just the argv
  expect(shown(["cat", "/h/a b.json", "it's"])).toBe(`cat '/h/a b.json' 'it'\\''s'`);
});

test("merging: the newest producer's command replaces an older one; a document without one keeps what was there", () => {
  const base = review().doc;
  const withHook = { ...base, on_submit: { run: ["new"] } };
  expect(merge({ ...base, on_submit: { run: ["old"] } }, withHook).on_submit).toEqual({ run: ["new"] });
  expect(merge({ ...base, on_submit: { run: ["old"] } }, base).on_submit).toEqual({ run: ["old"] });
});

test("submissions survive a read; junk in them is dropped", () => {
  const d = parseDocument({
    schema: SCHEMA, target: { base: A, head: B },
    submissions: [
      { at: "2026-09-30T00:00:00Z", verdict: "approve", file: "/f.json", posted: { platform: "github", ok: false, error: "nope" }, hook: { argv: ["cat", "/f.json"], cwd: "/wt", ran: true, exit: 1, output: "boom" } },
      { at: "x" }, "junk",
    ],
  });
  expect(d.submissions).toEqual([{ at: "2026-09-30T00:00:00Z", verdict: "approve", file: "/f.json", posted: { platform: "github", ok: false, error: "nope" }, hook: { argv: ["cat", "/f.json"], cwd: "/wt", ran: true, exit: 1, output: "boom" } }]);
});

test("what is posted is the human's words only: verdict, summary as the body, line comments on their lines", () => {
  const p = postingOf("request_changes", [
    { hunk: null, side: "new", line: null, text: "Needs a test.", at: "now" },
    { hunk: h1!.id, side: "new", line: 11, text: "why two?", at: "now" },
    { hunk: h1!.id, side: "new", line: null, text: "this hunk overall", at: "now" },
    { hunk: "gone.rs@1:1", side: "old", line: 3, text: "stale", at: "now" },
  ], (id) => id === h1!.id ? "src/a.rs" : undefined);
  expect(p).toEqual({ verdict: "request_changes", body: "Needs a test.\n\nsrc/a.rs: this hunk overall\n\ngone.rs: stale", comments: [{ path: "src/a.rs", side: "new", line: 11, text: "why two?" }] });
  expect(adapterFor("GitHub")).toBe(github);
  expect(adapterFor("gitlab")).toBeUndefined();
  expect(adapterFor(undefined)).toBeUndefined();
});

// A fake gh: answers the calls the adapter makes, and remembers them.
type Call = { argv: string[]; body?: any };
// The review's comments, as GitHub lists them after the submit, carry ids 501, 502, … in the order they were created
// (`listed` reorders or replaces that list, `comments` makes the read fail).
function fakeGh(head = B, over: { submit?: { exit: number; stdout: string; stderr: string }; listed?: (made: any[]) => any[]; comments?: { exit: number; stdout: string; stderr: string } } = {}) {
  const calls: Call[] = [];
  let made: any[] = [];
  const run: Runner = (argv, o) => {
    const body = o.stdin === undefined ? undefined : JSON.parse(o.stdin);
    calls.push({ argv, body });
    const path = argv[4]!, method = argv[3]!;
    if (method === "GET" && path.includes("/reviews/99/comments?")) {
      if (over.comments) return over.comments;
      const page = Number(path.match(/page=(\d+)$/)![1]);
      const all = (over.listed ?? ((x) => x))(made.map((c, i) => ({ id: 501 + i, node_id: `PRRC_${501 + i}`, pull_request_review_id: 99, path: c.path, line: c.line, side: c.side, body: c.body })));
      return { exit: 0, stdout: JSON.stringify(all.slice((page - 1) * 100, page * 100)), stderr: "" };
    }
    if (method === "GET") return { exit: 0, stdout: JSON.stringify({ head: { sha: head } }), stderr: "" };
    if (path.endsWith("/reviews")) { made = body.comments; return { exit: 0, stdout: JSON.stringify({ id: 99, state: "PENDING" }), stderr: "" }; }
    if (path.endsWith("/pulls/7/comments")) return { exit: 0, stdout: JSON.stringify({ id: 801, node_id: "PRRC_801" }), stderr: "" };
    if (path.endsWith("/events")) return over.submit ?? { exit: 0, stdout: JSON.stringify({ html_url: `${PR}#pullrequestreview-99` }), stderr: "" };
    return { exit: 0, stdout: "{}", stderr: "" };
  };
  return { calls, run };
}

test("github: checks the head, makes a pending review with the line comments, then submits it with the verdict and summary", async () => {
  const t = review({}, { url: PR, platform: "github" }).doc.target;
  const { calls, run } = fakeGh();
  const p = postingOf("comment", [
    { hunk: h1!.id, side: "old", line: 11, text: "was this used?", at: "now" },
    { hunk: h1!.id, side: "new", line: 12, text: "why two?", at: "now" },
    { hunk: null, side: "new", line: null, text: "Mostly fine.", at: "now" },
  ], () => "src/a.rs");
  expect(await github.post(t, p, run, "/wt")).toEqual({ url: `${PR}#pullrequestreview-99`, review_id: 99, items: [
    { kind: "line", path: "src/a.rs", line: 11, side: "old", text: "was this used?", review_id: 99, comment_id: 501, node_id: "PRRC_501" },
    { kind: "line", path: "src/a.rs", line: 12, side: "new", text: "why two?", review_id: 99, comment_id: 502, node_id: "PRRC_502" },
    { kind: "summary", text: "Mostly fine.", review_id: 99 },
  ] });
  expect(calls.map((c) => c.argv.slice(0, 5).join(" "))).toEqual([
    "gh api --method GET repos/o/r/pulls/7",
    "gh api --method POST repos/o/r/pulls/7/reviews",
    "gh api --method POST repos/o/r/pulls/7/reviews/99/events",
    "gh api --method GET repos/o/r/pulls/7/reviews/99/comments?per_page=100&page=1",
  ]);
  // No event on the create: GitHub keeps it pending. Sides: old is LEFT, new is RIGHT. Anchored on the document's head.
  expect(calls[1]!.body).toEqual({ commit_id: B, comments: [
    { path: "src/a.rs", line: 11, side: "LEFT", body: "was this used?" },
    { path: "src/a.rs", line: 12, side: "RIGHT", body: "why two?" },
  ] });
  expect(calls[2]!.body).toEqual({ event: "COMMENT", body: "Mostly fine." });
  expect(github.describe(t, p)).toContain("posts to https://github.com/o/r/pull/7");
});

test("github: every verdict maps to its review event", async () => {
  const t = review({}, { url: PR, platform: "github" }).doc.target;
  for (const [verdict, event] of [["approve", "APPROVE"], ["request_changes", "REQUEST_CHANGES"], ["comment", "COMMENT"]] as const) {
    const { calls, run } = fakeGh();
    await github.post(t, postingOf(verdict, [{ hunk: null, side: "new", line: null, text: "words", at: "now" }], () => undefined), run, "/wt");
    expect(calls[2]!.body.event).toBe(event);
  }
});

test("github: refuses when the pull request has moved off the reviewed head; nothing is created", async () => {
  const t = review({}, { url: PR, platform: "github" }).doc.target;
  const { calls, run } = fakeGh("c".repeat(40));
  await expect(github.post(t, postingOf("approve", [], () => undefined), run, "/wt")).rejects.toThrow("head is now cccccccc, but this review is of bbbbbbbb");
  expect(calls).toHaveLength(1); // only the GET
});

test("github: a failed submit deletes the pending review rather than leaving it on the PR", async () => {
  const t = review({}, { url: PR, platform: "github" }).doc.target;
  const { calls, run } = fakeGh(B, { submit: { exit: 1, stdout: JSON.stringify({ message: "Unprocessable Entity", errors: ["Can not approve your own pull request"] }), stderr: "gh: HTTP 422" } });
  await expect(github.post(t, postingOf("approve", [], () => undefined), run, "/wt")).rejects.toThrow("gh api failed (exit 1): Unprocessable Entity: Can not approve your own pull request");
  expect(calls.at(-1)!.argv.slice(3, 5)).toEqual(["DELETE", "repos/o/r/pulls/7/reviews/99"]);
});

test("github: refused before sending when GitHub would refuse it", async () => {
  const t = review({}, { url: PR, platform: "github" }).doc.target;
  const silent = postingOf("request_changes", [], () => undefined);
  await expect(github.post(t, silent, noNet, "/wt")).rejects.toThrow("needs a top-level comment or a ticked finding");
  expect(github.describe(t, silent)).toStartWith("not posted:");
  // A coverage line is not words of your own.
  await expect(github.post(t, postingOf("comment", [], () => undefined, { coverage: "I read 1 of 2 hunks." }), noNet, "/wt")).rejects.toThrow("needs a top-level comment");
  await expect(github.post(t, postingOf("approve", [], () => undefined, { coverage: "I read 1 of 2 hunks." }), noNet, "/wt")).rejects.toThrow("coverage line needs a top-level comment");
  await expect(github.post({ ...t, url: undefined }, postingOf("approve", [], () => undefined), noNet, "/wt")).rejects.toThrow("no GitHub pull request URL");
  const down: Runner = () => ({ exit: 1, stdout: "", stderr: "gh: HTTP 404" });
  await expect(github.post(t, postingOf("approve", [], () => undefined), down, "/wt")).rejects.toThrow("gh api failed (exit 1): gh: HTTP 404");
});

test("a finding posts only as the comment its block or comment action wrote; ignored ones and defaults post nothing; coverage only when chosen", async () => {
  const f = { id: "1", source: "stamp:security", hunk: h1!.id, side: "new" as const, line: 11, severity: "high" as const, kind: "bug", claim: "This can overflow when the count is zero.", evidence: "see the loop", status: "upheld" as const };
  let human: Doc["human"] = { comments: [], visited: [h1!.id], verdict: "request_changes" };
  human = decide(human, f, "block", { text: "Guard the zero count here", at: "now" });
  human = decide(human, { ...f, id: "2", line: 12 }, "ignore", { at: "now" });
  human = decide(human, { ...f, id: "3", line: 12 }, "ignore", { reason: "the critic misread the loop", at: "now" });
  // "4" is left on its default action (block, it is high): with no comment of the reader's, it posts nothing.
  const r = review({ findings: [f, { ...f, id: "2", line: 12 }, { ...f, id: "3", line: 12 }, { ...f, id: "4", line: 12 }], human }, { url: PR, platform: "github" });
  expect(planOf(r, files).posting).toEqual({ verdict: "request_changes", body: "", comments: [{ path: "src/a.rs", side: "new", line: 11, text: "Guard the zero count here" }] });
  const plan = planOf(r, files, { coverage: true });
  expect(plan.posting!.coverage).toBe("I read 1 of 1 hunk.");
  const { calls, run } = fakeGh();
  await github.post(r.doc.target, plan.posting!, run, "/wt");
  expect(calls[1]!.body.comments).toEqual([{ path: "src/a.rs", line: 11, side: "RIGHT", body: "Guard the zero count here" }]);
  // Nothing but the reader's words: no source, claim, evidence, reason or comment id reaches GitHub.
  expect(JSON.stringify(calls.map((c) => c.body))).not.toMatch(/stamp|security|prview|critic|evidence|see the loop|overflow|misread|"c1"|blocking|default|high/i);
  expect(calls[2]!.body.body).toBe("I read 1 of 1 hunk.");
});

test("dry run: prints the API calls, writes nothing, posts nothing, records nothing", async () => {
  const r = review({ human: { comments: [{ hunk: h1!.id, side: "old", line: 11, text: "was this used?", at: "now" }], visited: [], verdict: "comment" } }, { url: PR, platform: "github" });
  const res = await submit(r, files, { allowHook: true, run: noNet, hook: noHook, dryRun: true });
  expect(res.ok).toBe(true);
  expect(res.summary).toContain("Dry run (Comment): nothing written or posted.");
  expect(res.summary).toContain("gh api --method POST repos/o/r/pulls/7/reviews --input -");
  expect(res.summary).toContain('"side": "LEFT"');
  expect(res.summary).toContain("repos/o/r/pulls/7/reviews/<review id>/events");
  expect(existsSync(join(tmp, "home", "submitted", `${r.slug}.json`))).toBe(false);
  expect(r.doc.submissions).toBeUndefined();
});

test("no platform and no hook: submit writes the document and its markdown, and says where", async () => {
  const r = review();
  const res = await submit(r, files, { allowHook: false, run: noNet, hook: noHook, now: () => new Date("2026-10-01T09:08:07.006Z") });
  const file = join(tmp, "home", "submitted", r.slug, "2026-10-01T090807.006Z.json");
  expect(res.ok).toBe(true);
  expect(res.summary).toBe(`Submitted (Approve): wrote ${file} · no platform to post to, the file is the review`);
  const written = parseDocument(readFileSync(file, "utf8"));
  expect(written.submissions).toEqual([{ at: "2026-10-01T09:08:07.006Z", verdict: "approve", file, head: B }]);
  expect(readFileSync(file.replace(/\.json$/, ".md"), "utf8")).toContain("# A change");
  expect(r.doc.submissions).toHaveLength(1);
  // The review in the store carries the record too.
  expect(JSON.parse(readFileSync(join(tmp, "home", `${r.slug}.json`), "utf8")).doc.submissions).toHaveLength(1);
});

test("an allowed hook runs for real: `cat {file} > out` in the worktree produces the written document", async () => {
  const r = review({ on_submit: { run: splitArgs("cat {file} > out.json")! } });
  const res = await submit(r, files, { allowHook: true, run: noNet });
  const out = join(r.worktree, "out.json");
  expect(res.ok).toBe(true);
  expect(res.summary).toContain(`on_submit ran (exit 0, stdout in ${out})`);
  expect(parseDocument(readFileSync(out, "utf8")).target.head).toBe(B);
  expect(r.doc.submissions![0]!.hook).toEqual({ argv: ["cat", res.submission.file.replace(/\.json$/, ".hook.json"), ">", out], cwd: r.worktree, ran: true, exit: 0, output: "" });
});

test("a hook the human did not allow never runs, and the summary says so", async () => {
  const r = review({ on_submit: { run: ["cat", "{file}", ">", "out.json"] } });
  const res = await submit(r, files, { allowHook: false, run: noNet, hook: noHook });
  expect(res.summary).toContain("on_submit not run (not allowed)");
  expect(existsSync(join(r.worktree, "out.json"))).toBe(false);
  expect(res.submission.hook).toMatchObject({ ran: false });
});

test("a failing hook, a missing command, or a failed post is in the summary and the record; the document is still written", async () => {
  const r = review({ on_submit: { run: ["sh", "-c", "echo boom >&2; exit 3"] } }, { url: PR, platform: "github" });
  const down: Runner = () => ({ exit: 1, stdout: "", stderr: "gh: could not resolve host" });
  const res = await submit(r, files, { allowHook: true, run: down });
  expect(res.ok).toBe(false);
  expect(res.summary).toContain("NOT posted to github: gh api failed (exit 1): gh: could not resolve host");
  expect(res.summary).toContain("on_submit FAILED (exit 3): boom");
  expect(existsSync(res.submission.file)).toBe(true);
  expect(res.submission).toMatchObject({ posted: { platform: "github", ok: false }, hook: { ran: true, exit: 3, output: "boom\n" } });

  const gone = await submit(review({ on_submit: { run: ["no-such-command-prview-test"] } }), files, { allowHook: true, run: noNet });
  expect(gone.summary).toContain("on_submit FAILED (Executable not found");
  expect(existsSync(gone.submission.file)).toBe(true);

  const posted = await submit(review({}, { url: PR, platform: "github" }), files, { allowHook: false, run: fakeGh().run });
  expect(posted.summary).toContain(`posted to ${PR}#pullrequestreview-99`);
  expect(posted.submission.posted).toEqual({ platform: "github", ok: true, url: `${PR}#pullrequestreview-99`, review_id: 99 }); // an approve with no words posted no items
});

test("a hook that runs too long is stopped and reported as timed out", async () => {
  const res = runHook({ argv: ["sleep", "5"], cwd: tmp, timeoutMs: 200 });
  expect(res.timedOut).toBe(true);
  const r = review({ on_submit: { run: ["sleep", "5"] } });
  const s = await submit(r, files, { allowHook: true, run: noNet, hook: () => ({ exit: null, stdout: "", stderr: "", timedOut: true }) });
  expect(s.summary).toContain("on_submit FAILED (timed out after 60s)");
  expect(s.submission.hook).toMatchObject({ timed_out: true });
});

test("the preview spells out all three steps, the exact command, and whether it is allowed", () => {
  const r = review({ on_submit: { run: ["notify", "--file", "{file}", ">", "/tmp/x y"] } }, { platform: "gitlab" });
  const p = planOf(r, files);
  const text = describe(p, false);
  expect(text).toContain(`1. Writes ${p.file}`);
  expect(text).toContain("2. No gitlab adapter yet: the written file is the review.");
  expect(text).toContain(`     notify --file ${p.hookFile}`);
  expect(text).toContain("     stdout to /tmp/x y");
  expect(text).toContain("REFUSED: the redirect to /tmp/x y would write outside the worktree");
  expect(text).toContain("without your private ignore notes");
  expect(text).toContain(`in ${r.worktree}, no shell, stopped after 60s.`);
  const ok = describe(planOf(review({ on_submit: { run: ["notify", "{file}", ">", "out.txt"] } }), files), false);
  expect(ok).toContain("Not allowed: it will not run");
  expect(describe(planOf(review({ on_submit: { run: ["notify", "{file}", ">", "out.txt"] } }), files), true)).toContain("Allowed for this submit");
  expect(describe(planOf(review(), files), false)).not.toContain("3. The document asks");
});

test("a > path must land inside the worktree: absolute, .. and symlinks out are refused, in-tree paths (new or existing) are fine", () => {
  const wt = mkdtempSync(join(tmp, "rd-")), outside = mkdtempSync(join(tmp, "outside-"));
  mkdirSync(join(wt, "sub"));
  writeFileSync(join(wt, "there.txt"), "x");
  symlinkSync(outside, join(wt, "linkdir"));
  symlinkSync(join(outside, "target.txt"), join(wt, "linkfile"));
  symlinkSync(join(wt, "there.txt"), join(wt, "inlink"));
  for (const bad of [join(outside, "x"), "/etc/passwd", "../x", "sub/../../x", "linkdir/x", "linkdir/deep/new/x", "linkfile", ".git", ".git/config", ".", ""]) {
    expect(redirectRefusal(wt, bad)).toBeTruthy();
  }
  for (const good of ["out.txt", "sub/out.txt", "sub/new/dir/out.txt", "there.txt", "inlink", "./sub/../out.txt", join(wt, "abs.txt")]) {
    expect(redirectRefusal(wt, good)).toBeUndefined();
  }
  expect(hookOf(["cat", ">", "../x"], "/f", wt).refused).toContain("outside the worktree");
  expect(hookOf(["cat", ">", "x"], "/f", wt).refused).toBeUndefined();
});

test("a refused redirect: the hook does not run, nothing is written outside, the record says why", async () => {
  const r = review({ on_submit: { run: ["cat", "{file}", ">", "../escaped.json"] } });
  const res = await submit(r, files, { allowHook: true, run: noNet, hook: noHook });
  expect(res.ok).toBe(false);
  expect(res.summary).toContain("on_submit REFUSED, not run");
  expect(existsSync(join(r.worktree, "..", "escaped.json"))).toBe(false);
  expect(r.doc.submissions![0]!.hook!.ran).toBe(false);
  expect(r.doc.submissions![0]!.hook!.error).toContain("outside the worktree");
  expect(existsSync(res.submission.file)).toBe(true); // the document is still written
});

test("a link planted by the hook itself is caught before stdout is written through it", async () => {
  const outside = mkdtempSync(join(tmp, "late-"));
  const r = review({ on_submit: { run: ["cat", "{file}", ">", "late.txt"] } });
  const res = await submit(r, files, { allowHook: true, run: noNet, hook: () => { symlinkSync(join(outside, "stolen"), join(r.worktree, "late.txt")); return { exit: 0, stdout: "data", stderr: "", timedOut: false }; } });
  expect(res.ok).toBe(false);
  expect(existsSync(join(outside, "stolen"))).toBe(false);
});

test("the hook's copy of the document has the private ignore notes removed; the kept document keeps them", async () => {
  const r = review({ on_submit: { run: ["cat", "{file}", ">", "copy.json"] }, findings: [{ id: "f1", source: "s", hunk: h1!.id, side: "new", line: 11, severity: "medium", kind: "bug", claim: "c", evidence: "", status: "upheld" }], human: { comments: [], visited: [], decisions: { f1: { kind: "ignore", reason: "SECRET-REASON" } }, verdict: "comment" } });
  const res = await submit(r, files, { allowHook: true, run: noNet });
  expect(res.ok).toBe(true);
  const seen = readFileSync(join(r.worktree, "copy.json"), "utf8");
  expect(seen).not.toContain("SECRET-REASON");
  expect(parseDocument(seen).human.decisions!.f1!.kind).toBe("ignore");
  expect(readFileSync(res.submission.file, "utf8")).toContain("SECRET-REASON");
  expect(describe(planOf(r, files), true)).toContain("without your private ignore notes");
});

// ---------------------------------------------------------------- the submit flow's selection, end to end

const flowFindings = () => {
  const base = { source: "stamp:security", hunk: h1!.id, side: "new" as const, kind: "bug", evidence: "see the loop", status: "upheld" as const };
  return [
    { ...base, id: "1", line: 11, severity: "high" as const, claim: "Guard the zero count." },
    { ...base, id: "2", line: 12, severity: "medium" as const, claim: "Name this better." },
    { ...base, id: "3", line: 12, severity: "low" as const, claim: "Dropped by the second look.", status: "withdrawn" as const },
  ];
};

test("submit with a selection: ticked findings post their text on their lines, the comment is the body, the verdict the event", async () => {
  const r = review({ findings: flowFindings(), human: { comments: [], visited: [h1!.id] } }, { url: PR, platform: "github" });
  const { calls, run } = fakeGh();
  const res = await submit(r, files, { allowHook: false, run, selection: { listed: ["1", "2", "3"], include: ["1"], comment: "Nearly there.", verdict: "request_changes" } });
  expect(res.ok).toBe(true);
  expect(calls[1]!.body.comments).toEqual([{ path: "src/a.rs", line: 11, side: "RIGHT", body: "Guard the zero count." }]);
  expect(calls[2]!.body).toEqual({ event: "REQUEST_CHANGES", body: "Nearly there." });
  // Only the words chosen: no source, evidence, or the unticked findings' text.
  expect(JSON.stringify(calls.map((c) => c.body))).not.toMatch(/stamp|security|prview|critic|see the loop|Name this|Dropped/i);
  // The document written first records exactly that: the verdict, the comment, and the actions as they went out.
  const written = parseDocument(readFileSync(res.submission.file, "utf8"));
  expect(written.human.verdict).toBe("request_changes");
  expect(written.human.comments.map((c) => c.text)).toEqual(["Nearly there.", "Guard the zero count."]);
  expect(Object.fromEntries(Object.entries(written.human.decisions!).map(([k, v]) => [k, v.kind]))).toEqual({ "1": "block", "2": "ignore" });
});

test("submit with a selection: a ticked comment verdict with only a finding posts; nothing ticked and no words is refused by the GitHub check, the file still written", async () => {
  const r = review({ findings: flowFindings(), human: { comments: [], visited: [] } }, { url: PR, platform: "github" });
  const { calls, run } = fakeGh();
  await submit(r, files, { allowHook: false, run, selection: { listed: ["1", "2", "3"], include: ["3"], comment: "", verdict: "comment" } });
  expect(calls[1]!.body.comments).toEqual([{ path: "src/a.rs", line: 12, side: "RIGHT", body: "Dropped by the second look." }]);
  expect(calls[2]!.body).toEqual({ event: "COMMENT", body: "" });

  const silent = review({ findings: flowFindings(), human: { comments: [], visited: [] } }, { url: PR, platform: "github" });
  const res = await submit(silent, files, { allowHook: false, run: noNet, selection: { listed: ["1", "2", "3"], include: [], comment: "  ", verdict: "request_changes" } });
  expect(res.ok).toBe(false);
  expect(res.summary).toContain("NOT posted to github: requesting changes needs a top-level comment or a ticked finding to post");
  expect(existsSync(res.submission.file)).toBe(true);
});

test("submit with a selection: no verdict is refused before anything is written; a dry run applies it to a copy only", async () => {
  const r = review({ findings: flowFindings(), human: { comments: [], visited: [] } }, { url: PR, platform: "github" });
  await expect(submit(r, files, { allowHook: false, run: noNet, selection: { listed: ["1"], include: ["1"], comment: "x" } })).rejects.toThrow("pick a verdict");
  expect(existsSync(join(tmp, "home", "submitted", `${r.slug}.json`))).toBe(false);
  const res = await submit(r, files, { allowHook: false, run: noNet, dryRun: true, selection: { listed: ["1", "2", "3"], include: ["1", "2"], comment: "Top.", verdict: "comment" } });
  expect(res.summary).toContain('"body": "Guard the zero count."');
  expect(res.summary).toContain('"body": "Name this better."');
  expect(res.summary).toContain('"body": "Top."');
  expect(r.doc.human).toEqual({ comments: [], visited: [] }); // the review itself is as it was
  expect(existsSync(join(tmp, "home", "submitted", `${r.slug}.json`))).toBe(false);
});

test("the send step's preview is drawn from the posting: verdict, comment, coverage, each line comment on its file and line", () => {
  const r = review({ findings: flowFindings(), human: { comments: [], visited: [h1!.id] } }, { url: PR, platform: "github" });
  const p = planOf(r, files, { coverage: true, selection: { listed: ["1", "2", "3"], include: ["1", "2"], comment: "Top.\nSecond line.", verdict: "comment" } });
  expect(postPreview(p, (v) => v)).toBe([
    `── What posts to ${PR}`, "",
    "Verdict: comment", "", "Comment:", "  Top.", "  Second line.", "  ", "  I read 1 of 1 hunk.", "",
    "Line comments (2):", "  src/a.rs:11", "    Guard the zero count.", "  src/a.rs:12", "    Name this better.",
  ].join("\n"));
  expect(r.doc.human.decisions).toBeUndefined(); // planning changes nothing
  expect(postPreview(planOf(review(), files), (v) => v)).toStartWith("── Nothing is posted (the document has no platform)");
});

test("submit with a selection: a ticked whole-file finding posts as a file comment; your own decided finding posts once, as you wrote it", async () => {
  const base = { source: "critic", hunk: h1!.id, side: "new" as const, kind: "bug", evidence: "", status: "upheld" as const };
  const whole = { ...base, id: "w", line: 0, severity: "medium" as const, claim: "This file needs a header.", file: true as const };
  const own = { ...base, id: "y", source: "you", line: 11, severity: "high" as const, claim: "Derive this." };
  const human = decide({ comments: [], visited: [] }, own, "block", { text: "Derive this.", at: "now" });
  const r = review({ findings: [whole, own], human }, { url: PR, platform: "github" });
  const sel = { listed: ["w", "y"], include: ["w", "y"], comment: "", verdict: "request_changes" as const };
  const p = planOf(r, files, { selection: sel });
  expect(p.posting!.comments).toEqual([{ path: "src/a.rs", side: "new", line: 11, text: "Derive this." }]);
  expect(p.posting!.files).toEqual([{ path: "src/a.rs", text: "This file needs a header." }]);
  expect(postPreview(p, (v) => v)).toContain("Whole-file comments (1):\n  src/a.rs\n    This file needs a header.");
  const { calls, run } = fakeGh();
  expect((await submit(r, files, { allowHook: false, run, selection: sel })).ok).toBe(true); // a file comment is words enough for request changes
  expect(calls.map((c) => c.argv[4])).toEqual(["repos/o/r/pulls/7", "repos/o/r/pulls/7/reviews", "repos/o/r/pulls/7/comments", "repos/o/r/pulls/7/reviews/99/events", "repos/o/r/pulls/7/reviews/99/comments?per_page=100&page=1"]);
  expect(calls[2]!.body).toEqual({ commit_id: B, path: "src/a.rs", subject_type: "file", body: "This file needs a header." });
  expect(r.doc.human.comments.filter((c) => c.text === "Derive this.")).toHaveLength(1);
});
