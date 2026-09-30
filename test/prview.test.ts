import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDiff } from "../src/diff.ts";
import { applyRefute, classify, filePlan, hunksOf, oneLine, parseCritic, parseGuide } from "../src/guide.ts";
import { gotoLine, nextFinding } from "../src/nav.ts";

const tmp = mkdtempSync(join(tmpdir(), "prview-"));
process.env.PRVIEW_HOME = join(tmp, "store");
const { build, writeup, filesOf, load } = await import("../src/build.ts");
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
  expect(fs.map((f) => [f.id, f.side, f.line, f.severity, f.status])).toEqual([[100, "new", 1, "blocking", "unrefuted"], [101, "old", 1, "warn", "unrefuted"]]);
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
  expect(r.plan.by).toBe("files");
  expect(r.plan.chapters).toEqual([{ title: "keep.txt", intent: "", why: "", hunks: ["keep.txt@1:1"] }]);
  expect(JSON.parse(readFileSync(join(tmp, "store", `${r.slug}.json`), "utf8")).slug).toBe(r.slug);

  // The reader's state survives a rebuild at the same head; the write-up reports it.
  r.notes.push({ hunk: "keep.txt@1:1", side: "new", line: 2, text: "why shout?", at: "now" });
  r.visited.push("keep.txt@1:1");
  const { save } = await import("../src/build.ts");
  save(r);
  const again = await build(repo, "main..feature", { ai: null });
  expect(again.notes).toHaveLength(1);
  expect(again.visited).toEqual(["keep.txt@1:1"]);
  const md = writeup(load(r.slug), filesOf(again));
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
  const f = (id: number, hunk: string, line: number) => ({ id, hunk, side: "new" as const, line, severity: "warn" as const, kind: "bug", claim: "", evidence: "", status: "upheld" as const });
  const fs = [f(1, "src/a.rs@10:10", 12), f(2, "src/new.rs@0:1", 2), f(3, "src/a.rs@10:10", 10)];
  expect(nextFinding(items, fs, { item: 0, line: -1 }, 1)?.finding.id).toBe(3);
  expect(nextFinding(items, fs, { item: 0, line: 0 }, 1)?.finding.id).toBe(1);
  expect(nextFinding(items, fs, { item: 0, line: 3 }, 1)?.finding.id).toBe(2);
  expect(nextFinding(items, fs, { item: 2, line: 1 }, 1)).toBeUndefined();
  expect(nextFinding(items, fs, { item: 2, line: 1 }, -1)?.finding.id).toBe(1);
});
