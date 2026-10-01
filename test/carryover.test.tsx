import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { cleanup, render } from "ink-testing-library";
import { inkTestHooks } from "./ink-hooks.ts";
import { build, exportDocument, filesOf, type Review } from "../src/build.ts";
import { carry, ownComments, ownKey, postedBefore, postedSummaries, postKey } from "../src/carryover.ts";
import { parseDiff } from "../src/diff.ts";
import { fit, SCHEMA, type Doc } from "../src/document.ts";
import { hunksOf } from "../src/guide.ts";
import { adapterFor, type Runner } from "../src/platform.ts";
import { ownFinding } from "../src/rows.ts";
import { applySelection, impliedVerdict, selectionOf, startFlow, stepLines, toggle, move, type Flow } from "../src/submit-flow.ts";
import { planOf, postPreview, submit } from "../src/submit.ts";
import { App, type Outcome } from "../src/tui.tsx";

// A review submitted at head A, then reopened after the PR's head moved to B: the round-1 comments come over with the
// reader's layer, and must neither post again unseen nor be impossible to leave out. Everything runs against scratch
// repos, a fake `gh` on PATH for reading the PR, and a fake runner for posting: nothing reaches a network.
let tmp = "", savedHome: string | undefined, savedPath: string | undefined;
beforeAll(() => {
  savedHome = process.env.PRVIEW_HOME; savedPath = process.env.PATH;
  tmp = mkdtempSync(join(tmpdir(), "prview-carry-"));
  process.env.PRVIEW_HOME = join(tmp, "home");
});
inkTestHooks();
afterAll(() => {
  cleanup();
  rmSync(tmp, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.PRVIEW_HOME; else process.env.PRVIEW_HOME = savedHome;
  process.env.PATH = savedPath;
});

const PR = "https://github.com/o/r/pull/7";
const git = (cwd: string, ...args: string[]) => {
  const p = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
};

/** A clone whose origin is a bare repo at …/o/r (so it is the remote for o/r), the PR's head pushed to refs/pull/7/head, and a fake gh that names it. */
function prRepo() {
  const remote = join(tmp, "o", "r"), clone = join(tmp, "clone"), bin = join(tmp, "bin"), view = join(tmp, "pr.json");
  mkdirSync(remote, { recursive: true }); mkdirSync(clone); mkdirSync(bin);
  git(remote, "init", "-q", "--bare");
  git(clone, "init", "-q", "-b", "main");
  git(clone, "remote", "add", "origin", remote);
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  writeFileSync(join(clone, "a.ts"), lines.join("\n") + "\n");
  git(clone, "add", "."); git(clone, "commit", "-qm", "base"); git(clone, "push", "-q", "origin", "main");
  writeFileSync(join(bin, "gh"), `#!/bin/sh\ncat '${view}'\n`);
  chmodSync(join(bin, "gh"), 0o755);
  process.env.PATH = `${bin}:${savedPath}`;
  /** A new head for the PR: commit on the feature branch, push it to the PR ref, and have gh name it. */
  const push = (edit: () => void, msg: string) => {
    edit(); git(clone, "add", "."); git(clone, "commit", "-qm", msg);
    const sha = git(clone, "rev-parse", "HEAD");
    git(clone, "push", "-q", "-f", "origin", `${sha}:refs/pull/7/head`);
    writeFileSync(view, JSON.stringify({ number: 7, title: "A change", body: "", url: PR, headRefOid: sha, baseRefName: "main" }));
    return sha;
  };
  git(clone, "checkout", "-q", "-b", "feature");
  return { clone, push, lines };
}

/** A fake gh for posting: the PR's head is `head`; the review takes its line comments and lists them back with ids. */
function poster(head: () => string) {
  const created: any[] = [];
  let made: any[] = [];
  const run: Runner = (argv, o) => {
    const method = argv[3]!, path = argv[4]!, body = o.stdin === undefined ? undefined : JSON.parse(o.stdin);
    if (method === "GET" && path.includes("/reviews/99/comments?")) {
      const page = Number(path.match(/page=(\d+)$/)![1]);
      return { exit: 0, stdout: JSON.stringify(made.map((c, i) => ({ id: 500 + i, node_id: `N${i}`, path: c.path, line: c.line, side: c.side, body: c.body })).slice((page - 1) * 100, page * 100)), stderr: "" };
    }
    if (method === "GET") return { exit: 0, stdout: JSON.stringify({ head: { sha: head() } }), stderr: "" };
    if (path.endsWith("/reviews")) { made = body.comments; created.push(body); return { exit: 0, stdout: JSON.stringify({ id: 99 }), stderr: "" }; }
    if (path.endsWith("/events")) return { exit: 0, stdout: JSON.stringify({ id: 99, html_url: `${PR}#pullrequestreview-99` }), stderr: "" };
    return { exit: 0, stdout: "{}", stderr: "" };
  };
  return { created, run };
}

const ROUND1 = ["one is off", "two is off", "three is off", "four is off", "five is off", "six is off", "seven is off", "eight is off"];

test("moved head: round-1 comments live in the previous-comments chapter, not the layer; only the never-posted one is listed, ticked (GitHub)", async () => {
  const { clone, push, lines } = prRepo();
  // Head A changes eight lines; the reader writes a finding with a comment on each and submits.
  const A = push(() => writeFileSync(join(clone, "a.ts"), lines.map((l, i) => i >= 4 && i < 12 ? `${l} changed` : l).join("\n") + "\n"), "round 1");
  const r1 = await build(clone, PR, { ai: null });
  expect(r1.doc.target.head).toBe(A);
  const files1 = filesOf(r1), hunk1 = hunksOf(files1)[0]!;
  ROUND1.forEach((text, i) => {
    const made = ownFinding(r1.doc.findings, r1.doc.human, { hunk: hunk1.id, side: "new", line: 5 + i }, "medium", text, "2026-09-30T10:00:00.000Z");
    r1.doc.findings.push(made.finding); r1.doc.human = made.human;
  });
  const fl1 = startFlow(r1.doc.findings, r1.doc.human, ["approve", "request_changes", "comment"]);
  const gh1 = poster(() => A);
  const res1 = await submit(r1, files1, { allowHook: false, selection: { ...selectionOf(fl1), verdict: "comment" }, run: gh1.run, now: () => new Date("2026-09-30T10:05:00.000Z") });
  expect(res1.ok).toBe(true);
  expect(gh1.created[0].comments.map((c: any) => c.body)).toEqual(ROUND1);
  // After submitting, the reader adds one more comment at A that never posts.
  const late = ownFinding(r1.doc.findings, r1.doc.human, { hunk: hunk1.id, side: "new", line: 13 }, "low", "never sent", "2026-09-30T11:00:00.000Z");
  r1.doc.findings.push(late.finding); r1.doc.human = late.human;
  const { save } = await import("../src/build.ts");
  save(r1);

  // A coworker pushes: head B adds a file. Reopening rebuilds at B: what round 1 posted is the previous-comments
  // chapter (with the ids the post recorded), and only the comment that never posted carries over as the reader's.
  const B = push(() => writeFileSync(join(clone, "b.ts"), "export const b = 1;\n"), "round 2");
  const r2 = await build(clone, PR, { ai: null });
  expect(r2.doc.target.head).toBe(B);
  expect(r2.doc.findings).toEqual([]);
  expect(r2.previous?.head).toBe(A);
  expect(r2.previous?.items.map((i) => [i.text, i.status, i.comment_id !== undefined])).toEqual(ROUND1.map((t) => [t, "unchanged", true]));
  expect(r2.doc.human.comments.map((c) => c.text)).toEqual(["never sent"]);
  expect(r2.carried && Object.values(r2.carried).every((h) => h === A)).toBe(true);
  expect(r2.doc.submissions?.length).toBe(1);

  // The checklist lists only the reader's comment that never posted, ticked as carried over.
  const earlier = postedBefore(r2.slug, r2.doc);
  const own = ownComments(r2.doc.human, [], earlier, r2.carried);
  expect(own.map((o) => [o.comment.text, !!o.posted])).toEqual([["never sent", false]]);
  const fl = startFlow([], r2.doc.human, ["approve", "request_changes", "comment"], undefined, undefined, { own, postedSummaries: postedSummaries(r2.doc.human, earlier) });
  expect(fl.ticked).toEqual([own[0]!.key]);
  const shown = stepLines(fl, { findings: [], h: r2.doc.human, place: () => "", label: String, keys: { tick: "Space", all: "a", editor: "v e", next: "Tab", back: "⇧Tab" } }).map((l) => l.text);
  expect(shown).toContain(`[x] yours · carried over from ${A.slice(0, 7)} · a.ts:13 · never sent`);

  // Submit with the defaults: none of the round-1 comments posts again, in the post or the dry run.
  const files2 = filesOf(r2);
  const plan = planOf(r2, files2, { selection: { ...selectionOf(fl), verdict: "comment" } });
  expect(plan.posting!.comments.map((c) => c.text)).toEqual(["never sent"]);
  const dry = await submit(structuredClone(r2), files2, { allowHook: false, selection: { ...selectionOf(fl), verdict: "comment" }, dryRun: true });
  for (const t of ROUND1) expect(dry.summary).not.toContain(t);
  expect(dry.summary).toContain("never sent");
  const gh2 = poster(() => B);
  const res2 = await submit(r2, files2, { allowHook: false, selection: { ...selectionOf(fl), verdict: "comment" }, run: gh2.run, now: () => new Date("2026-10-01T09:00:00.000Z") });
  expect(res2.ok).toBe(true);
  expect(gh2.created[0].comments.map((c: any) => c.body)).toEqual(["never sent"]);

  // Opened again at the same head: the chapter is the latest submit that reached the PR (round 2, at B), and since
  // that was this head, it is no re-review any more.
  const r3 = await build(clone, PR, { ai: null });
  expect(r3.previous).toBeUndefined();
});

// ---------------------------------------------------------------- pure parts

const DIFF = `diff --git a/src/a.rs b/src/a.rs
index 1..2 100644
--- a/src/a.rs
+++ b/src/a.rs
@@ -20,3 +20,4 @@ fn main() {
 keep
-old
+new1
+new2
 keep2
`;
const files = parseDiff(DIFF);
const [h] = hunksOf(files);

test("carry: a comment moves to the hunk that now holds its line; one with no such hunk keeps its own; the origin head is kept", () => {
  const moved = { hunk: "src/a.rs@10:10", side: "new" as const, line: 21, text: "here", at: "x" };
  const stays = { hunk: "src/a.rs@1:1", side: "new" as const, line: 2, text: "gone now", at: "x" };
  const general = { hunk: null, side: "new" as const, line: null, text: "overall", at: "x" };
  const out = carry({ human: { comments: [moved, stays, general], visited: [] }, head: "b".repeat(40), carried: { [postKey(stays)]: "a".repeat(40) } }, files);
  expect(out.comments.map((c) => c.hunk)).toEqual([h!.id, "src/a.rs@1:1", null]);
  expect(out.carried[postKey(moved)]).toBe("b".repeat(40));
  expect(out.carried[postKey(stays)]).toBe("a".repeat(40)); // from an earlier carry
});

test("ownComments: a comment a current finding owns is the finding's (ticked with it), not listed again; summaries are not listed", () => {
  const c1 = { id: "c1", hunk: h!.id, side: "new" as const, line: 21, text: "the finding's", at: "x" };
  const c2 = { id: "c2", hunk: h!.id, side: "new" as const, line: 22, text: "orphaned", at: "x" };
  const human = { comments: [c1, c2, { hunk: null, side: "new" as const, line: null, text: "sum", at: "x" }], visited: [], decisions: { f1: { kind: "comment" as const, comment: "c1" }, gone: { kind: "comment" as const, comment: "c2" } } };
  expect(ownComments(human, ["f1"]).map((o) => o.comment.text)).toEqual(["orphaned"]);
  // A ticked comment of the reader's implies at least a comment verdict.
  expect(impliedVerdict([], {}, [ownKey(c2)])).toBe("comment");
  // An unticked one leaves the layer at submit; a ticked one stays as it is.
  const out = applySelection(human, [], { listed: [ownKey(c2)], include: [], comment: "" });
  expect(out.comments.map((c) => c.text)).toEqual(["the finding's"]);
  expect(applySelection(human, [], { listed: [ownKey(c2)], include: [ownKey(c2)], comment: "" }).comments.map((c) => c.text)).toEqual(["the finding's", "orphaned"]);
});

/** A kept submission under $PRVIEW_HOME/submitted/<slug>/, as history.ts reads it. */
function kept(slug: string, doc: Doc, file: string, sub: NonNullable<Doc["submissions"]>[number]) {
  const dir = join(process.env.PRVIEW_HOME!, "submitted", slug);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  const r = { slug, repo: tmp, worktree: tmp, context: 3, created: "now", pos: { item: 0, line: 0 }, doc: { ...doc, submissions: [{ ...sub, file: path }] } } as Review;
  writeFileSync(path, exportDocument(r));
}

test("Azure DevOps: a comment posted before (recorded with its items) starts unticked; the post and the dry run carry only the ticked ones", () => {
  const URL_ = "https://dev.azure.com/contoso/web/_git/web/pullrequest/42";
  const A = "a".repeat(40), B = "c".repeat(40);
  const doc = (head: string, comments: Doc["human"]["comments"]): Doc => ({
    schema: SCHEMA, target: { repo: "web", base: "e".repeat(40), head, title: "T", body: "", label: "web!42", url: URL_, platform: "azure-devops" },
    plan: { summary: "", chapters: [], mechanical: [], by: "files" }, findings: [], human: { comments, visited: [] },
  });
  const old = { hunk: h!.id, side: "new" as const, line: 21, text: "posted on azure", at: "x" };
  const fresh = { hunk: h!.id, side: "new" as const, line: 22, text: "not yet", at: "x" };
  kept("az-42", doc(A, [old]), "2026-09-30T100000.000Z.json", {
    at: "2026-09-30T10:00:00.000Z", verdict: "comment", file: "", head: A, platform: "azure-devops",
    posted: { platform: "azure-devops", ok: true, items: [{ kind: "line", path: "src/a.rs", line: 21, side: "new", text: "posted on azure", thread_id: 7, comment_id: 1 }] },
  });
  const r: Review = { slug: "az-42", repo: tmp, worktree: tmp, context: 3, created: "now", pos: { item: 0, line: 0 }, doc: doc(B, [old, fresh]) };
  const earlier = postedBefore(r.slug, r.doc);
  const own = ownComments(r.doc.human, [], earlier, {});
  expect(own.map((o) => [o.comment.text, !!o.posted])).toEqual([["posted on azure", true], ["not yet", false]]);
  const fl = startFlow([], r.doc.human, adapterFor("azure-devops")!.verdicts, undefined, undefined, { own });
  expect(fl.ticked).toEqual([own[1]!.key]);
  const p = planOf(r, files, { selection: { ...selectionOf(fl), verdict: "comment" } });
  expect(p.posting!.comments.map((c) => c.text)).toEqual(["not yet"]);
  const calls = p.adapter!.dryRun(r.doc.target, p.posting!).join("\n");
  expect(calls).toContain("not yet");
  expect(calls).not.toContain("posted on azure");
});

test("a summary an earlier submit posted does not prefill the top-level comment again", () => {
  const sum = { hunk: null, side: "new" as const, line: null, text: "Looks mostly fine.", at: "x" };
  const human = { comments: [sum], visited: [] };
  const earlier = [{ key: postKey(sum), at: "2026-09-30T10:00:00.000Z", head: "a".repeat(40), round: 1 }];
  expect(startFlow([], human, ["comment"]).comment).toBe("Looks mostly fine.");
  expect(startFlow([], human, ["comment"], undefined, undefined, { postedSummaries: postedSummaries(human, earlier) }).comment).toBe("");
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

test("screen: a carried-over comment is labelled on its line and in the checklist; x deletes it so it cannot post", async () => {
  const A = "a".repeat(40);
  const c = { id: "c1", hunk: h!.id, side: "new" as const, line: 21, text: "from round one", at: "x" };
  const doc: Doc = {
    schema: SCHEMA, target: { repo: "/nowhere", base: "e".repeat(40), head: "b".repeat(40), title: "A change", body: "", label: "main..x" },
    plan: { summary: "", chapters: [], mechanical: [], by: "files" }, findings: [], human: { comments: [c], visited: [] },
  };
  const r: Review = { slug: "screen-carry", repo: "/nowhere", worktree: "/nowhere", context: 3, created: "now", pos: { item: 0, line: 0 }, doc: fit(doc, files), carried: { [postKey(c)]: A } };
  const outcomes: Outcome[] = [];
  const app = render(<App review={r} files={files} onDone={(o) => outcomes.push(o)} size={{ cols: 120, rows: 40 }} />);
  await settle(app);
  const press = async (keys: string) => { for (const k of keys.match(KEY) ?? []) { app.stdin.write(k); await settle(app); } };
  const frame = () => (app.lastFrame() ?? "").replace(/\x1b\[[0-9;]*m/g, "");
  await press("\x1b[C"); // into the code
  expect(frame()).toContain(`[carried over from ${A.slice(0, 7)}] from round one`);
  // The checklist lists it, ticked (it never posted).
  await press("s");
  expect(frame()).toContain(`[x] yours · carried over from ${A.slice(0, 7)} · src/a.rs:21 · from round one`);
  await press("\x1b");
  await settle(app);
  // On its line, x deletes it (only there: the key panel offers it on that line).
  await press("\x1b[B"); // keep → line 21 (the "-old" row is old side only, so 21 is new1)
  for (let i = 0; i < 4 && !frame().includes("delete comment"); i++) await press("\x1b[B");
  expect(frame()).toContain("delete comment");
  await press("x");
  expect(r.doc.human.comments).toEqual([]);
  expect(frame()).toContain("it will not be posted");
  app.unmount();
});
