import { expect, test } from "bun:test";
import { parseDiff } from "../src/diff.ts";
import { hunksOf, type Finding } from "../src/guide.ts";
import { blank, fit, merge, parseDocument, SCHEMA, type Human } from "../src/document.ts";
import { decide, defaultVerdict, linkedComment, nextUndecided, progress, undecidedNote, undo, withLegacy } from "../src/triage.ts";

// The decision rules without a screen: what a decision writes, where the pass goes next, how
// decisions load, fit and merge.

const DIFF = `diff --git a/src/a.rs b/src/a.rs
--- a/src/a.rs
+++ b/src/a.rs
@@ -10,3 +10,4 @@
 keep
-old
+new1
+new2
 keep2
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,2 +1,2 @@
 const x = 1;
-const y = 2;
+const y = "two";
`;
const files = parseDiff(DIFF);
const [h1, h2] = hunksOf(files);
const items = [h1!, h2!].map((h, i) => ({ id: h.id, path: h.file.path, hunk: h.hunk!, chapter: i }));
const F = (id: string, hunk: string, line: number, over: Partial<Finding> = {}): Finding => ({ id, source: "critic", hunk, side: "new", line, severity: "warn", kind: "bug", title: `Title ${id}`, claim: `claim ${id}`, evidence: "", status: "upheld", ...over });
const f1 = F("1", h1!.id, 11), f2 = F("2", h1!.id, 11), f3 = F("3", h2!.id, 2);
const empty = (): Human => ({ comments: [], visited: [] });
const A = "a".repeat(40), B = "b".repeat(40);

test("decide: block and comment write the reader's comment at the finding's line; re-deciding rewrites it; other kinds take it away", () => {
  let h = decide(empty(), f1, "block", { text: "  Where does 42 come from?  ", at: "t" });
  expect(h.comments).toEqual([{ id: "c1", hunk: h1!.id, side: "new", line: 11, text: "Where does 42 come from?", at: "t" }]);
  expect(h.decisions).toEqual({ "1": { kind: "block", comment: "c1" } });
  h = decide(h, f1, "comment", { text: "Worth a constant", at: "t2" }); // same comment, new words, no longer blocking
  expect(h.comments.map((c) => [c.id, c.text])).toEqual([["c1", "Worth a constant"]]);
  expect(h.decisions!["1"]).toEqual({ kind: "comment", comment: "c1" });
  expect(linkedComment(h, "1")?.text).toBe("Worth a constant");
  h = decide(h, f1, "dismissed", { reason: " misread ", text: "ignored text", at: "t3" });
  expect(h.comments).toEqual([]); // it would otherwise still post
  expect(h.decisions!["1"]).toEqual({ kind: "dismissed", reason: "misread" });
  h = decide(h, f2, "ignored", { reason: "not kept for ignore", at: "t" });
  expect(h.decisions!["2"]).toEqual({ kind: "ignored" });
  expect(() => decide(h, f3, "block", { text: "  ", at: "t" })).toThrow();
});

test("decide: a new decision comment never reuses an id already taken", () => {
  const h = decide({ comments: [{ id: "c2", hunk: null, side: "new", line: null, text: "x", at: "" }], visited: [] }, f1, "comment", { text: "y", at: "" });
  expect(new Set(h.comments.map((c) => c.id)).size).toBe(2);
});

test("undo: takes back the decision and the comment it wrote, and nothing else", () => {
  const typed = { hunk: h1!.id, side: "new" as const, line: 11, text: "my own note", at: "" };
  const h = decide(decide({ comments: [typed], visited: [] }, f1, "block", { text: "blocking words", at: "" }), f2, "ignored", { at: "" });
  const u = undo(h, "1");
  expect(u.comments).toEqual([typed]);
  expect(u.decisions).toEqual({ "2": { kind: "ignored" } });
  expect(undo(u, "1")).toBe(u); // nothing to undo
});

test("the pass: progress counts decided findings; the next undecided is at or after the cursor, else from the top", () => {
  const all = [f1, f2, f3];
  let h = empty();
  expect(progress(all, h)).toEqual({ decided: 0, total: 3 });
  h = decide(h, f1, "ignored", { at: "" });
  expect(progress(all, h)).toEqual({ decided: 1, total: 3 });
  // f2 shares f1's line: it is next, not skipped.
  expect(nextUndecided(items, all, h, { item: 0, line: 2 })?.finding.id).toBe("2");
  h = decide(h, f2, "ignored", { at: "" });
  expect(nextUndecided(items, all, h, { item: 0, line: 2 })).toMatchObject({ item: 1, line: 2, finding: { id: "3" } });
  // Started midway: past the last one, it wraps to the first undecided.
  expect(nextUndecided(items, all, undo(decide(h, f3, "ignored", { at: "" }), "1"), { item: 1, line: 2 })?.finding.id).toBe("1");
  h = decide(h, f3, "comment", { text: "ok", at: "" });
  expect(nextUndecided(items, all, h, { item: 0, line: 0 })).toBeUndefined();
});

test("verdict default: request changes when anything is blocking, else none; the preview's undecided list", () => {
  const all = [f1, f3];
  expect(defaultVerdict(all, empty())).toBeUndefined();
  expect(defaultVerdict(all, decide(empty(), f1, "comment", { text: "x", at: "" }))).toBeUndefined();
  const h = decide(empty(), f1, "block", { text: "x", at: "" });
  expect(defaultVerdict(all, h)).toBe("request_changes");
  const place = (hunk: string, line: number) => `${hunk.split("@")[0]}:${line}`;
  expect(undecidedNote(all, h, place)).toBe("── Not decided yet (1)\n\n▲ src/b.ts:2 · warn · Title 3\n\n");
  expect(undecidedNote(all, decide(h, f3, "ignored", { at: "" }), place)).toBe("");
  expect(undecidedNote([], empty(), place, true)).toContain("still hide their findings"); // blind: no count, only that some are hidden
});

test("legacy dismissals load as not-an-issue; an existing decision wins", () => {
  expect(withLegacy({ "1": { kind: "block" } }, ["1", "2"])).toEqual({ "1": { kind: "block" }, "2": { kind: "dismissed" } });
});

test("decisions are read defensively: unknown findings, kinds and comment refs dropped; a repeated comment id loses it", () => {
  const d = parseDocument({
    schema: SCHEMA, target: { base: A, head: B },
    findings: [{ id: "1", source: "x", hunk: h1!.id, line: 11, claim: "c" }, { id: "2", source: "x", hunk: h1!.id, line: 11, claim: "d" }],
    human: {
      comments: [{ id: "c1", hunk: h1!.id, line: 11, text: "mine" }, { id: "c1", hunk: null, text: "dup" }, { id: 5, hunk: null, text: "num" }],
      decisions: { "1": { kind: "block", comment: "c1", reason: "blocks carry no reason" }, "2": { kind: "shrug" }, "9": { kind: "ignored" } },
      dismissals: ["2", "1"],
    },
  });
  expect(d.human.comments.map((c) => c.id)).toEqual(["c1", undefined, undefined]);
  expect(d.human.decisions).toEqual({ "1": { kind: "block", comment: "c1" }, "2": { kind: "dismissed" } });
  expect(parseDocument({ schema: SCHEMA, target: { base: A, head: B } }).human.decisions).toBeUndefined(); // an old document: none
});

test("fit drops decisions on findings that left; merge keeps the reader's, fills in incoming ones with renamed ids and comments", () => {
  const target = { repo: "o/r", base: A, head: B, title: "t", body: "", label: "l" };
  const mine = fit({ ...blank(target), findings: [f1] }, files);
  mine.human = decide(mine.human, f1, "ignored", { at: "" });
  const theirs = fit({ ...blank(target), findings: [F("1", h1!.id, 11, { claim: "other claim" }), { ...f1, id: "x" }, F("gone", "nowhere@1:1", 1)] }, files);
  expect(theirs.findings.map((f) => f.id)).toEqual(["1", "x"]);
  theirs.human = decide(decide(theirs.human, theirs.findings[0]!, "block", { text: "theirs", at: "" }), theirs.findings[1]!, "comment", { text: "on mine", at: "" });
  const m = merge(mine, theirs);
  // Their "1" became "1.2"; its comment came along and the decision points at it. Their "x" is my "1": my decision stands.
  expect(m.findings.map((f) => f.id)).toEqual(["1", "1.2"]);
  const ref = m.human.decisions!["1.2"]!.comment!;
  expect(m.human.comments.find((c) => c.id === ref)?.text).toBe("theirs");
  expect(m.human.decisions!["1"]).toEqual({ kind: "ignored" });
  expect(merge(m, theirs)).toEqual(m);
});
