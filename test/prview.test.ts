import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDiff } from "../src/diff.ts";
import { applyReask, applyRefute, applyTitleReask, claimAddsTo, classify, deriveTitle, readCritic, titleOf, titleReaskPrompt, filePlan, fitLine, hunksOf, MECHANICAL_INTENT, mergeFindings, oneLine, parseCritic, parseGuide, readGuide, reaskPrompt, rubric, sameClaim, twoSentences, worstFirst, type Finding } from "../src/guide.ts";
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

test("a name at the start of the one-liner keeps its case; a cut is reported", () => {
  expect(oneLine("buildClient throws before fetch")).toBe("buildClient throws before fetch");
  expect(oneLine("apply_doc_persisted errors on a pending import")).toBe("apply_doc_persisted errors on a pending import");
  expect(fitLine("Every caller passes the floor").cut).toBe(false);
  expect(fitLine("Verify that every caller passes the floor.").cut).toBe(false); // noise stripped, not a cut
  expect(fitLine("one two three four five six seven eight nine ten eleven twelve thirteen").cut).toBe(true);
});

test("the summary is held to two sentences and fifty words", () => {
  expect(twoSentences("Adds x. Keep y in mind.")).toEqual({ text: "Adds x. Keep y in mind.", cut: false });
  expect(twoSentences("Adds x, e.g. v1.2 of it. Keep y. Also z.")).toEqual({ text: "Adds x, e.g. v1.2 of it. Keep y.", cut: true });
  const long = Array.from({ length: 60 }, (_, i) => `w${i}`).join(" ");
  expect(twoSentences(long).cut).toBe(true);
  expect(twoSentences(long).text.split(" ")).toHaveLength(50);
});

test("a cut line is asked for once more; the answer is used only where it now fits", () => {
  const files = parseDiff(MECH), hunks = hunksOf(files), mech = classify(files);
  const long = "the new floor is passed by every single caller of open_store in the crate now";
  const { plan, cuts, summarySaid } = readGuide(JSON.stringify({ summary: "One. Two. Three.", chapters: [{ title: "Floor", check: long, why: "Callers drift.", hunks: ["src/real.rs@1:1"] }] }), hunks, mech);
  expect(cuts.map((c) => c.at)).toEqual(["summary", "chapter"]);
  expect(plan.chapters[0]!.intent.endsWith("…")).toBe(true);
  expect(plan.summary).toBe("One. Two.");
  const prompt = reaskPrompt("Raise the floor", cuts, summarySaid);
  expect(prompt).toContain(long);
  expect(prompt).toContain("One. Two. Three.");
  expect(prompt).toContain("n=1");
  const fixed = applyReask(plan, cuts, '{"summary":"Raises the floor. Callers first.","chapters":[{"n":1,"check":"Every open_store caller passes the new floor"},{"n":7,"check":"stray"}]}');
  expect(fixed.chapters[0]!.intent).toBe("Every open_store caller passes the new floor");
  expect(fixed.summary).toBe("Raises the floor. Callers first.");
  // Still too long, or not JSON at all: the first, cut answer stands.
  expect(applyReask(plan, cuts, JSON.stringify({ chapters: [{ n: 1, check: long }] })).chapters[0]!.intent).toBe(plan.chapters[0]!.intent);
  expect(applyReask(plan, cuts, "sorry")).toBe(plan);
  expect(readGuide('{"summary":"Short.","chapters":[{"title":"T","check":"Every caller passes it","hunks":["src/real.rs@1:1"]}]}', hunks, mech).cuts).toEqual([]);
});

test("the intent rubric: short, concrete, no verify-that, not the title again", () => {
  const title = "pm hub login: store the hub URL and token per workspace";
  expect(rubric("Token reaches `security -i` only on stdin, never argv", title)).toEqual([]);
  expect(rubric("Every caller passes the new floor", title)).toEqual([]);
  expect(rubric("Expired tokens return 404, never 401", title)).toEqual([]);
  expect(rubric("", title)).toEqual(["empty"]);
  expect(rubric("one two three four five six seven eight nine ten eleven twelve…", title)).toContain("over 12 words");
  expect(rubric("Verify that the parser rejects blank ids", title)).toContain("says verify that");
  expect(rubric("The changes are correct", title)).toEqual(["names nothing concrete"]);
  expect(rubric("Store the hub URL and token per workspace", title)).toEqual(["restates the title"]);
  expect(rubric(MECHANICAL_INTENT, "anything")).toEqual([]);
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
  expect(d.human).toEqual({ comments: [], visited: [], decisions: { "1": { kind: "dismissed" } } }); // a legacy dismissal is "not an issue"
  expect(d.on_submit).toEqual({ run: ["notify"] }); // kept, but only ever run when the human allows it at submit
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
  expect(f.human).toMatchObject({ visited: ["src/real.rs@1:1"] });
  expect(f.human.decisions).toBeUndefined(); // the dismissed finding is gone, and its decision with it
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
  expect(m.human.decisions).toEqual({ "1.2": { kind: "dismissed" } });
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
  r.doc.human.decisions = { h1: { kind: "dismissed" } };
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

// ---------------------------------------------------------------- model config (no network, no Keychain)

import { ConfigError, parseConfig, parseToml, resolveCredential, resolveRoles, type Lookups } from "../src/config.ts";

const none: Lookups = { env: {}, keychain: () => undefined };
const CFG = `
# comment
[models.sonnet]
kind = "anthropic"
model = "claude-sonnet-4-5"   # trailing comment, "# quoted" kept below
key_env = "SONNET_KEY"
[models."local-qwen"]
kind = 'openai-compatible'
endpoint = "http://localhost:8000/v1/"
[models.ds]
kind = "openai-compatible"
endpoint = "https://api.deepseek.com/v1"
key_keychain = "DEEPSEEK_API_KEY"
[roles]
critic = "sonnet"
ask = "local-qwen"
`;

test("toml subset: tables, quoted keys, comments, scalars", () => {
  expect(parseToml(`a = 1\nb = true\n[x."y z"]\nk = "v # not a comment" # c`)).toEqual({ a: 1, b: true, x: { "y z": { k: "v # not a comment" } } });
  expect(() => parseToml("a = [1]")).toThrow(/line 1/);
  expect(() => parseToml("a = 1\na = 2")).toThrow(/duplicate/);
  expect(() => parseToml("a = bare")).toThrow(ConfigError);
});

test("config: models, roles, defaults, and errors", () => {
  const c = parseConfig(CFG);
  expect(Object.keys(c.models).sort()).toEqual(["claude", "ds", "local-qwen", "sonnet"]);
  expect(c.models.claude!.kind).toBe("claude-cli");
  expect(c.roles).toEqual({ critic: "sonnet", ask: "local-qwen" });
  expect(() => parseConfig(`[models.a]\nkind = "gpt"`)).toThrow(/kind must be one of/);
  expect(() => parseConfig(`[models.a]\nkind = "openai-compatible"`)).toThrow(/endpoint/);
  expect(() => parseConfig(`[models.a]\nkind = "claude-cli"\nkey_env = "X"`)).toThrow(/no key/);
  expect(() => parseConfig(`[roles]\nguide = "ghost"`)).toThrow(/not a \[models.ghost\]/);
});

test("credentials: env, then keychain, only what the model names", () => {
  const c = parseConfig(CFG);
  const sonnet = c.models.sonnet!, ds = c.models.ds!, qwen = c.models["local-qwen"]!;
  expect(resolveCredential(sonnet, { env: { SONNET_KEY: " k1 " }, keychain: () => "kc" })).toBe("k1");
  expect(resolveCredential(ds, { env: { DEEPSEEK_API_KEY: "ambient", SONNET_KEY: "x" }, keychain: (s) => (s === "DEEPSEEK_API_KEY" ? "kc" : undefined) })).toBe("kc");
  expect(() => resolveCredential(sonnet, { env: { ANTHROPIC_API_KEY: "ambient" }, keychain: () => "kc" })).toThrow(/\$SONNET_KEY/);
  expect(resolveCredential(qwen, { env: { OPENAI_API_KEY: "ambient" }, keychain: () => "kc" })).toBeUndefined();
  expect(() => resolveCredential({ name: "a", kind: "anthropic", model: "m" }, none)).toThrow(/key_env or key_keychain/);
});

test("roles: critic on one model and ask on another; --ai overrides all four", () => {
  const c = parseConfig(CFG);
  const l: Lookups = { env: { SONNET_KEY: "k" }, keychain: () => undefined };
  const r = resolveRoles(c, l);
  expect([r.guide.def.name, r.critic.def.name, r.refute.def.name, r.ask.def.name]).toEqual(["claude", "sonnet", "claude", "local-qwen"]);
  expect(r.critic.key).toBe("k");
  const all = resolveRoles(c, l, "local-qwen");
  expect(new Set(Object.values(all).map((m) => m.def.name))).toEqual(new Set(["local-qwen"]));
  expect(() => resolveRoles(c, l, "nope")).toThrow(/no model named nope/);
  expect(() => resolveRoles(c, none)).toThrow(/no credential/);
});

// ---------------------------------------------------------------- finding titles

test("a finding's title is held to 12 words; one too long is cut and re-asked once, a missing one is not an error", () => {
  const files = parseDiff(MECH), hunks = hunksOf(files);
  const chapter = { title: "The bump", intent: "", why: "", hunks: ["src/real.rs@1:1"] };
  const long = "The function load_caller_org does not have a test that exercises the error path";
  const at = { hunk: "src/real.rs@1:1", side: "new", line: 1 };
  const reply = JSON.stringify([
    { ...at, title: "Missing test: load_caller_org error path isn't covered.", claim: "a" },
    { ...at, title: long, claim: "b" },
    { ...at, claim: "No title here. More words follow." },
    { ...at, title: 42, claim: "c" },
  ]);
  const { findings, cuts } = readCritic(reply, chapter, hunks, 0);
  expect(findings.map((f) => f.title)).toEqual([
    "Missing test: load_caller_org error path isn't covered", // trailing period dropped
    "The function load_caller_org does not have a test that exercises the error…", undefined, "42",
  ]);
  expect(cuts).toEqual([{ index: 1, said: long }]);
  expect(titleReaskPrompt(findings, cuts)).toContain("n=2");
  // The rewrite lands when it fits; a rewrite still too long, junk, or a reply for a finding not asked about changes nothing.
  expect(applyTitleReask(findings, cuts, '[{"n":2,"title":"Missing test: load_caller_org error path"},{"n":1,"title":"hijack"}]')[1]!.title).toBe("Missing test: load_caller_org error path");
  expect(applyTitleReask(findings, cuts, '[{"n":2,"title":"Missing test: load_caller_org error path isn\'t covered anywhere at all in the suite"}]')).toEqual(findings);
  expect(applyTitleReask(findings, cuts, '[{"n":2,"title":"x"},{"n":1,"title":"hijack"}]')[0]!.title).toBe(findings[0]!.title);
  expect(applyTitleReask(findings, cuts, "not json")).toEqual(findings);
});

test("titleOf: the finding's own title, else the claim's first sentence cut to 12 words; old documents still load", () => {
  const prose = "The retry loop never backs off, so a failing upstream is hit as fast as the CPU allows. This was also the case before the change. See src/retry.rs.";
  expect(titleOf({ title: "Retry never backs off", claim: prose })).toBe("Retry never backs off");
  expect(deriveTitle(prose)).toBe("The retry loop never backs off, so a failing upstream is hit…");
  expect(deriveTitle("Uses e.g. a fixed delay in v1.2. Second sentence.")).toBe("Uses e.g. a fixed delay in v1.2");
  expect(titleOf({ claim: "n is wrong" })).toBe("N is wrong");
  expect(titleOf({ claim: "" })).toBe("");
  // A short one-sentence claim is its own title, so the float does not say it twice.
  expect(claimAddsTo({ claim: "n is wrong" })).toBe(false);
  expect(claimAddsTo({ claim: prose })).toBe(true);
  expect(claimAddsTo({ title: "n is wrong", claim: "n is wrong" })).toBe(true);

  const d = parseDocument(JSON.stringify(foreign({ findings: [
    { source: "stamp:security", hunk: "src/real.rs@1:1", line: 1, claim: prose },
    { source: "hal9k", hunk: "src/real.rs@1:1", line: 1, title: "one two three four five six seven eight nine ten eleven twelve thirteen", claim: "x" },
    { source: "hal9k", hunk: "src/real.rs@1:1", line: 1, title: "  ", claim: "y" },
  ] })));
  expect(d.findings.map((f) => f.title)).toEqual([undefined, "One two three four five six seven eight nine ten eleven twelve…", undefined]);
  expect(d.findings.map(titleOf)[0]).toBe("The retry loop never backs off, so a failing upstream is hit…");
});

test("the write-up lists kept findings by title", () => {
  const r = { doc: { ...blank({ title: "T", base: A, head: B, label: "l" } as never), findings: [
    { id: "1", source: "stamp:x", hunk: "src/real.rs@1:1", side: "new" as const, line: 1, severity: "warn" as const, kind: "bug", claim: "Long prose about the thing. Even more prose.", evidence: "", status: "upheld" as const },
    { id: "2", source: "critic", hunk: "src/real.rs@1:1", side: "new" as const, line: 2, severity: "nit" as const, kind: "bug", title: "Short title", claim: "Long prose again.", evidence: "", status: "upheld" as const },
  ] } };
  const md = writeup(r.doc, parseDiff(MECH));
  expect(md).toContain("warn · Long prose about the thing");
  expect(md).not.toContain("Even more prose");
  expect(md).toContain("nit · Short title · not decided");
  // A decision shows beside its finding; "not an issue" drops the finding from the list.
  const decided = writeup({ ...r.doc, human: { ...r.doc.human, decisions: { "1": { kind: "ignored" }, "2": { kind: "dismissed" } } } }, parseDiff(MECH));
  expect(decided).toContain("Long prose about the thing · decided: ignored");
  expect(decided).not.toContain("Short title");
});

// ---------------------------------------------------------------- which model answered (no network: fetch is stubbed)

import { claudeModelId, complete, modelLabel } from "../src/llm.ts";
import { preparedBy } from "../src/build.ts";

test("claude -p: the id comes from modelUsage when model is null; the heaviest writer wins", () => {
  const reply = { type: "result", result: "{}", model: null, total_cost_usd: 0.01, modelUsage: { "claude-opus-5-5": { outputTokens: 900 }, "claude-haiku-5": { outputTokens: 12 } } };
  expect(claudeModelId(reply)).toBe("claude-opus-5-5");
  expect(claudeModelId({ modelUsage: { "claude-haiku-5": { outputTokens: 12 }, "claude-opus-5-5": { outputTokens: 900 } } })).toBe("claude-opus-5-5");
  expect(claudeModelId({ model: "claude-sonnet-5-5", modelUsage: { x: {} } })).toBe("claude-sonnet-5-5");
  expect(claudeModelId({ model: null, modelUsage: {} })).toBeUndefined();
  expect(claudeModelId({ result: "x" })).toBeUndefined();
  expect(claudeModelId(null)).toBeUndefined();
});

test("label: configured name, then the id, `default` until a reply names one", () => {
  expect(modelLabel("claude")).toBe("claude · default");
  expect(modelLabel("claude", "claude-opus-5-5")).toBe("claude · claude-opus-5-5");
  expect(modelLabel("local-qwen", "qwen3-27b")).toBe("local-qwen · qwen3-27b");
});

test("OpenAI-compatible and Anthropic replies report their model in the usage callback", async () => {
  const real = globalThis.fetch;
  const reply = (body: unknown) => (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;
  try {
    globalThis.fetch = reply({ model: "qwen3-27b-q4", choices: [{ message: { content: "hi" }, finish_reason: "stop" }] });
    let u: any;
    await complete({ def: { name: "q", kind: "openai-compatible", endpoint: "http://x/v1", model: "qwen3" } }, "s", "p", (x) => { u = x; });
    expect(u.model).toBe("qwen3-27b-q4");
    globalThis.fetch = reply({ model: "claude-sonnet-5-5", content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" });
    await complete({ def: { name: "a", kind: "anthropic", model: "sonnet" }, key: "k" }, "s", "p", (x) => { u = x; });
    expect(u.model).toBe("claude-sonnet-5-5");
    globalThis.fetch = reply({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }] });
    await complete({ def: { name: "q", kind: "openai-compatible", endpoint: "http://x/v1", model: "qwen3" } }, "s", "p", (x) => { u = x; });
    expect(u.model).toBeUndefined();
  } finally { globalThis.fetch = real; }
});

test("preparedBy groups roles by model id, falls back to the configured name, and is absent without runs", () => {
  expect(preparedBy(undefined)).toBeUndefined();
  expect(preparedBy([])).toBeUndefined();
  expect(preparedBy([
    { role: "guide", model: "claude-opus-5-5", ms: 1 }, { role: "critic", model: "claude-sonnet-5-5", ms: 1 },
    { role: "critic", model: "claude-sonnet-5-5", ms: 1 }, { role: "refute", model: "claude-sonnet-5-5", ms: 1 },
  ])).toBe("Prepared by claude-opus-5-5 (guide), claude-sonnet-5-5 (critic, refute)");
  expect(preparedBy([{ role: "guide", name: "claude", ms: 1 }])).toBe("Prepared by claude (guide)");
});
