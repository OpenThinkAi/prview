import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDiff } from "../src/diff.ts";
import { applyRefute, classify, filePlan, hunksOf, mergeFindings, oneLine, parseCritic, parseGuide, sameClaim, worstFirst, type Finding } from "../src/guide.ts";
import { blank, fit, merge, parseDocument, SCHEMA, type Doc } from "../src/document.ts";
import { gotoLine, nextFinding } from "../src/nav.ts";

const tmp = mkdtempSync(join(tmpdir(), "prview-"));
process.env.PRVIEW_HOME = join(tmp, "store");
const { build, exportDocument, importDocument, writeup, filesOf, load, save } = await import("../src/build.ts");
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

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
@@ -40 +41,0 @@ impl X
-gone
diff --git a/src/new.rs b/src/new.rs
new file mode 100644
--- /dev/null
+++ b/src/new.rs
@@ -0,0 +1,2 @@
+- a markdown-looking line
+two
diff --git a/old.txt b/moved.txt
similarity index 90%
rename from old.txt
rename to moved.txt
`;

test("git's diff is parsed into files, hunks and per-line numbers on both sides", () => {
  const f = parseDiff(DIFF);
  expect(f.map((x) => [x.path, x.status])).toEqual([["src/a.rs", "modified"], ["src/new.rs", "added"], ["moved.txt", "renamed"]]);
  expect(f[2]!.oldPath).toBe("old.txt");
  const h = f[0]!.hunks[0]!;
  expect(h.context).toBe("fn main() {");
  expect(h.lines.map((l) => [l.t, l.o, l.n])).toEqual([[" ", 10, 10], ["-", 11, null], ["+", null, 11], ["+", null, 12], [" ", 12, 13]]);
  expect(f[0]!.hunks[1]!.lines).toEqual([{ t: "-", text: "gone", o: 40, n: null }]);
});

const MECH = `diff --git a/Cargo.lock b/Cargo.lock
--- a/Cargo.lock
+++ b/Cargo.lock
@@ -1,2 +1,2 @@
-version = 1
+version = 2
diff --git a/src/w.rs b/src/w.rs
--- a/src/w.rs
+++ b/src/w.rs
@@ -1,3 +1,3 @@
 fn f() {
-    let x = compute_the_thing(a, b);
+  let x = compute_the_thing(a, b);
 }
diff --git a/src/from.rs b/src/from.rs
--- a/src/from.rs
+++ b/src/from.rs
@@ -10,4 +10 @@ mod m {
-pub fn moved_one() -> u32 { 1 }
-pub fn moved_two() -> u32 { 2 }
-pub fn moved_three() -> u32 { 3 }
 keep
diff --git a/src/to.rs b/src/to.rs
--- a/src/to.rs
+++ b/src/to.rs
@@ -5 +5,4 @@ mod n {
 other
+pub fn moved_one() -> u32 { 1 }
+pub fn moved_two() -> u32 { 2 }
+pub fn moved_three() -> u32 { 3 }
diff --git a/src/real.rs b/src/real.rs
--- a/src/real.rs
+++ b/src/real.rs
@@ -1,2 +1,2 @@
-let n = 1;
+let n = 2;
 use_it(n);
`;

test("mechanical hunks are classified by rule: lock files, whitespace, moves; a real change is not", () => {
  const m = classify(parseDiff(MECH));
  expect(Object.fromEntries(m.map((x) => [x.id, x.why]))).toEqual({
    "Cargo.lock@1:1": "lock file",
    "src/w.rs@1:1": "whitespace only",
    "src/from.rs@10:10": "moved away: these lines are added elsewhere in the diff",
    "src/to.rs@5:5": "moved here: these lines are removed elsewhere in the diff",
  });
});

test("the guide's chapters are checked: unknown ids dropped, repeats kept once, strays collected; a bad reply falls back by file", () => {
  const files = parseDiff(MECH), hunks = hunksOf(files), mech = classify(files);
  const plan = parseGuide('```json\n{"summary":"Bumps n.","chapters":[{"title":"The bump","check":"Verify that n is two.","why":"Off by one.","hunks":["src/real.rs@1:1","nope@1:1","src/real.rs@1:1","Cargo.lock@1:1"]}]}\n```', hunks, mech);
  expect(plan.chapters).toEqual([{ title: "The bump", intent: "N is two", why: "Off by one.", hunks: ["src/real.rs@1:1"] }]);
  expect(plan.summary).toBe("Bumps n.");
  const strays = parseGuide('{"chapters":[]}', hunks, mech);
  expect(strays.chapters[0]!.hunks).toEqual(["src/real.rs@1:1"]);
  expect(() => parseGuide("I cannot", hunks, mech)).toThrow();
  expect(filePlan(files, mech).chapters.map((c) => c.title)).toEqual(["src/real.rs"]);
});

test("findings are anchored to a real line of their hunk, or to the hunk's start; a refute can withdraw or downgrade", () => {
  const files = parseDiff(MECH), hunks = hunksOf(files);
  const chapter = { title: "The bump", intent: "", why: "", hunks: ["src/real.rs@1:1"] };
  const fs = parseCritic(JSON.stringify([
    { hunk: "src/real.rs@1:1", side: "new", line: 1, severity: "blocking", kind: "bug", claim: "n is wrong", evidence: "because" },
    { hunk: "src/real.rs@1:1", side: "old", line: 99, severity: "silly", claim: "off the hunk" },
    { hunk: "src/w.rs@1:1", side: "new", line: 1, severity: "nit", claim: "not in this chapter" },
    { hunk: "src/real.rs@1:1", side: "new", line: 2, claim: "" },
  ]), chapter, hunks, 100);
  expect(fs.map((f) => [f.id, f.source, f.side, f.line, f.severity, f.status])).toEqual([["100", "critic", "new", 1, "blocking", "unrefuted"], ["101", "critic", "old", 1, "warn", "unrefuted"]]);
  expect(applyRefute(fs[0]!, '{"verdict":"withdraw","reason":"handled above"}')).toMatchObject({ status: "withdrawn", refute: "handled above" });
  expect(applyRefute(fs[0]!, '{"verdict":"downgrade","reason":"real but minor"}')).toMatchObject({ status: "upheld", severity: "warn" });
  expect(applyRefute(fs[0]!, "uphold it").status).toBe("upheld");
});

test("a review builds from a local range: worktree at the head, state on disk, notes and coverage in the write-up", async () => {
  const repo = join(tmp, "repo");
  const git = (...a: string[]) => { const r = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: repo }); if (r.exitCode) throw new Error(r.stderr.toString()); return r.stdout.toString().trim(); };
  Bun.spawnSync(["git", "init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "keep.txt"), "one\ntwo\n");
  git("add", "."); git("commit", "-qm", "base");
  git("checkout", "-qb", "feature");
  writeFileSync(join(repo, "keep.txt"), "one\nTWO\n");
  git("commit", "-qam", "change");

  const r = await build(repo, "main..feature", { ai: null });
  expect(Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: r.worktree }).stdout.toString().trim()).toBe(git("rev-parse", "feature"));
  expect(r.doc.plan.by).toBe("files");
  expect(r.doc.plan.chapters).toEqual([{ title: "keep.txt", intent: "", why: "", hunks: ["keep.txt@1:1"] }]);
  expect(JSON.parse(readFileSync(join(tmp, "store", `${r.slug}.json`), "utf8")).slug).toBe(r.slug);

  // The reader's state survives a rebuild at the same head; the write-up reports it.
  r.doc.human.comments.push({ hunk: "keep.txt@1:1", side: "new", line: 2, text: "why shout?", at: "now" });
  r.doc.human.visited.push("keep.txt@1:1");
  save(r);
  const again = await build(repo, "main..feature", { ai: null });
  expect(again.doc.human.comments).toHaveLength(1);
  expect(again.doc.human.visited).toEqual(["keep.txt@1:1"]);
  const md = writeup(load(r.slug).doc, filesOf(again));
  expect(md).toContain("read 1 of 1 hunks");
  expect(md).toContain("**keep.txt:2**\nwhy shout?");
});

test("the guide's one-liner is held to one line", () => {
  expect(oneLine("Verify that seeding happens once per millisecond.")).toBe("Seeding happens once per millisecond");
  expect(oneLine("make sure every caller passes the new floor")).toBe("Every caller passes the new floor");
  expect(oneLine("one two three four five six seven eight nine ten eleven twelve thirteen fourteen")).toBe("One two three four five six seven eight nine ten eleven twelve…");
  expect(oneLine("  ")).toBe("");
});

test("123G finds the hunk holding that file line, or the nearest one; ]f walks findings in reading order", () => {
  const files = parseDiff(DIFF);
  const items = hunksOf(files).filter((h) => h.hunk).map((h, i) => ({ id: h.id, path: h.file.path, hunk: h.hunk!, chapter: 0 }));
  // src/a.rs has hunks at 10–13 and at 41 (a deletion); src/new.rs at 1–2
  expect(gotoLine(items, 0, 12)).toEqual({ item: 0, line: 3 });
  expect(gotoLine(items, 1, 11)).toEqual({ item: 0, line: 2 });
  expect(gotoLine(items, 0, 30)).toEqual({ item: 1, line: 0 }); // the closest hunk of the file (the deletion at 41), at its near edge
  expect(gotoLine(items, 2, 99)).toEqual({ item: 2, line: 1 });
  const f = (id: string, hunk: string, line: number) => ({ id, source: "critic", hunk, side: "new" as const, line, severity: "warn" as const, kind: "bug", claim: "", evidence: "", status: "upheld" as const });
  const fs = [f("1", "src/a.rs@10:10", 12), f("2", "src/new.rs@0:1", 2), f("3", "src/a.rs@10:10", 10)];
  expect(nextFinding(items, fs, { item: 0, line: -1 }, 1)?.finding.id).toBe("3");
  expect(nextFinding(items, fs, { item: 0, line: 0 }, 1)?.finding.id).toBe("1");
  expect(nextFinding(items, fs, { item: 0, line: 3 }, 1)?.finding.id).toBe("2");
  expect(nextFinding(items, fs, { item: 2, line: 1 }, 1)).toBeUndefined();
  expect(nextFinding(items, fs, { item: 2, line: 1 }, -1)?.finding.id).toBe("1");
});

// ---------------------------------------------------------------- the review document

const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40);
const foreign = (over: Record<string, unknown> = {}) => ({
  schema: SCHEMA, target: { repo: "o/r", base: A, head: B, title: "Bump n" },
  findings: [
    { id: 1, source: "hal9k", hunk: "src/real.rs@1:1", side: "new", line: 1, severity: "blocking", kind: "bug", claim: "n is wrong", evidence: "because" },
    { id: 1, source: "hal9k", hunk: "src/real.rs@1:1", side: "new", line: 1, severity: "loud", claim: "same id twice" },
    { source: "hal9k", hunk: "src/real.rs@1:1", line: "x", claim: "no line" },
    { source: "hal9k", hunk: "src/real.rs@1:1", line: 2, claim: "" },
    "junk",
  ],
  ...over,
});

test("a document is parsed defensively: another schema or no commits refused, bad findings dropped, repeated ids renamed", () => {
  expect(() => parseDocument("{")).toThrow("not JSON");
  expect(() => parseDocument({ schema: "prview-review/2" })).toThrow("(it says prview-review/2)");
  expect(() => parseDocument({ schema: SCHEMA, target: { base: A, head: "main" } })).toThrow("commit ids");
  const d = parseDocument(JSON.stringify(foreign({ human: { dismissals: [1, "nope"], verdict: "ship it" }, on_submit: { run: ["notify"] } })));
  expect(d.findings.map((f) => [f.id, f.source, f.severity, f.kind])).toEqual([["1", "hal9k", "blocking", "bug"], ["1.2", "hal9k", "warn", "finding"]]);
  expect(d.plan.by).toBe("files");
  expect(d.human).toEqual({ comments: [], dismissals: ["1"], visited: [] });
  expect(d.on_submit).toBeUndefined(); // a command from a document is never kept silently
  expect(d.target.label).toBe("aaaaaaaa..bbbbbbbb");
});

test("a document is held to its diff: mechanical by rule, chapters checked, findings anchored; fitting twice changes nothing", () => {
  const files = parseDiff(MECH);
  const d = parseDocument(foreign({
    plan: { summary: "s", by: "hal9k", chapters: [{ title: "All", intent: "Verify that n is two.", hunks: ["Cargo.lock@1:1", "src/real.rs@1:1", "gone@1:1"] }], mechanical: [{ id: "src/real.rs@1:1", why: "trust me" }] },
    findings: [
      { id: "x", source: "hal9k", hunk: "src/real.rs@1:1", side: "new", line: 40, claim: "off the hunk" },
      { id: "y", source: "hal9k", hunk: "gone@1:1", side: "new", line: 1, claim: "no such hunk" },
    ],
    human: { visited: ["src/real.rs@1:1", "gone@1:1"], dismissals: ["y"] },
  }));
  const f = fit(d, files);
  expect(f.plan.chapters).toEqual([{ title: "All", intent: "N is two", why: "", hunks: ["src/real.rs@1:1"] }]);
  expect(f.plan.mechanical.map((m) => m.id)).toEqual(classify(files).map((m) => m.id));
  expect(f.findings.map((x) => [x.id, x.line])).toEqual([["x", 1]]);
  expect(f.human).toMatchObject({ visited: ["src/real.rs@1:1"], dismissals: [] });
  expect(fit(f, files)).toEqual(f);
});

test("import merges: a finding seen before is kept once, a taken id is renamed, the reader's layer is a union; another head is refused", () => {
  const files = parseDiff(MECH);
  const mine = fit({ ...blank({ repo: "o/r", base: A, head: B, title: "t", body: "", label: "l" }), findings: [
    { id: "1", source: "critic", hunk: "src/real.rs@1:1", side: "new", line: 1, severity: "warn", kind: "bug", claim: "n is wrong", evidence: "", status: "upheld" },
  ] }, files);
  mine.human.comments.push({ hunk: null, side: "new", line: null, text: "mine", at: "t" });
  const theirs = fit(parseDocument(foreign({
    plan: { by: "hal9k", chapters: [{ title: "Bump", intent: "n", hunks: ["src/real.rs@1:1"] }] },
    human: { dismissals: [1], comments: [{ hunk: null, text: "mine" }, { hunk: null, text: "theirs" }], verdict: "comment" },
  })), files);
  const m = merge(mine, theirs);
  expect(m.findings.map((f) => [f.id, f.source, f.claim])).toEqual([["1", "critic", "n is wrong"], ["1.2", "hal9k", "n is wrong"], ["1.2.2", "hal9k", "same id twice"]]);
  expect(m.human.dismissals).toEqual(["1.2"]);
  expect(m.human.comments.map((c) => c.text)).toEqual(["mine", "theirs"]);
  expect(m.human.verdict).toBe("comment");
  expect(m.plan.by).toBe("hal9k"); // the by-file fallback gives way to a producer's chapters
  expect(merge(m, theirs)).toEqual(m); // importing the same document again changes nothing
  expect(() => merge(mine, { ...theirs, target: { ...theirs.target, head: C } })).toThrow("only opens against its own head");
});

test("round trip: export, import into a fresh clone with its own store, the same review; a document for another head is refused", async () => {
  const repo = join(tmp, "repo"), clone = join(tmp, "clone");
  expect(Bun.spawnSync(["git", "clone", "-q", "--no-local", repo, clone]).exitCode).toBe(0);
  const r = load((await build(repo, "main..feature", { ai: null })).slug);
  r.doc.findings.push({ id: "h1", source: "hal9k", hunk: "keep.txt@1:1", side: "new", line: 2, severity: "nit", kind: "style", claim: "shouting", evidence: "", status: "unrefuted" });
  r.doc.human.dismissals.push("h1");
  r.doc.plan = { ...r.doc.plan, summary: "Makes two loud.", by: "hal9k", chapters: [{ title: "Loud", intent: "Two is loud", why: "", hunks: ["keep.txt@1:1"] }] };
  save(r);
  const out = exportDocument(load(r.slug));

  process.env.PRVIEW_HOME = join(tmp, "store2");
  try {
    const there = importDocument(out, clone);
    expect(there.repo.endsWith("/clone")).toBe(true);
    expect(there.doc).toEqual(load(there.slug).doc);
    expect(exportDocument(there)).toBe(out);
    expect(Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: there.worktree }).stdout.toString().trim()).toBe(there.doc.target.head);
    expect(exportDocument(importDocument(out, clone))).toBe(out); // a second import merges into it and changes nothing

    // A PR's document names the PR; a second document for that PR at another head is refused.
    const doc = JSON.parse(out) as Doc;
    const base = doc.target.base;
    const pr = { ...doc, target: { ...doc.target, url: "https://github.com/o/r/pull/7" } };
    const first = importDocument(JSON.stringify({ ...pr, target: { ...pr.target, base, head: base } }), clone);
    expect(first.slug).toBe("clone-pr-7");
    expect(() => importDocument(JSON.stringify({ ...pr, target: { ...pr.target, head: C } }), clone)).toThrow("only opens against its own head");
  } finally { process.env.PRVIEW_HOME = join(tmp, "store"); }
});

const F = (o: Partial<Finding>): Finding => ({ id: "0", source: "critic", hunk: "a@1:1", side: "new", line: 10, severity: "warn", kind: "bug", claim: "the loop never ends", evidence: "", status: "unrefuted", ...o });

test("sampled critic runs merge: the same finding in different words counts once, with a vote per run", () => {
  expect(sameClaim("The loop never ends.", "the loop never ends")).toBe(true);
  expect(sameClaim("the loop never ends when n is zero", "the loop never ends")).toBe(true);
  expect(sameClaim("the loop never ends", "token is written to the log")).toBe(false);
  const merged = mergeFindings([
    [F({ claim: "The loop never ends" }), F({ line: 40, claim: "token is written to the log", severity: "nit" })],
    [F({ line: 11, claim: "the loop never ends when n is 0" })],
    [F({ claim: "the loop never ends", severity: "blocking" }), F({ claim: "the loop never ends", line: 10 })], // two matches in one run: one vote
  ], 300);
  expect(merged.map((f) => [f.id, f.claim.slice(0, 8), f.votes, f.severity])).toEqual([["300", "The loop", 3, "warn"], ["301", "token is", 1, "nit"]]);
});

test("merging keeps distinct findings apart: another hunk, side, or a line far away is not a duplicate", () => {
  const merged = mergeFindings([[F({}), F({ hunk: "b@1:1" }), F({ side: "old" }), F({ line: 20 })], [F({})]], 0);
  expect(merged.length).toBe(4);
  expect(merged.find((f) => f.hunk === "a@1:1" && f.side === "new" && f.line === 10)?.votes).toBe(2);
  expect(mergeFindings([], 0)).toEqual([]);
});

test("severity is the one most runs gave, ties to the worse; the gutter orders by severity then votes", () => {
  const sev = (...s: Finding["severity"][]) => mergeFindings(s.map((severity) => [F({ severity })]), 0)[0]!.severity;
  expect(sev("nit", "nit", "blocking")).toBe("nit");
  expect(sev("warn", "blocking")).toBe("blocking");
  const list = [F({ severity: "nit", votes: 3 }), F({ severity: "warn", votes: 1 }), F({ severity: "warn", votes: 2 }), F({ severity: "blocking", votes: 1 })];
  expect(list.sort(worstFirst).map((f) => [f.severity, f.votes])).toEqual([["blocking", 1], ["warn", 2], ["warn", 1], ["nit", 3]]);
});

test("votes survive the document: read when a whole number, ignored otherwise", () => {
  const sha = "a".repeat(40), doc = (votes: unknown) => parseDocument({ schema: SCHEMA, target: { base: sha, head: "b".repeat(40) }, findings: [{ source: "critic", hunk: "a@1:1", line: 1, claim: "x", votes }] });
  expect(doc(3).findings[0]!.votes).toBe(3);
  for (const bad of [0, 2.5, "3", null, 1000]) expect(doc(bad).findings[0]!.votes).toBeUndefined();
});
