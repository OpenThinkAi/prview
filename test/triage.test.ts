import { expect, test } from "bun:test";
import { parseDiff } from "../src/diff.ts";
import { hunksOf, type Finding } from "../src/guide.ts";
import { blank, fit, merge, parseDocument, SCHEMA, type Human } from "../src/document.ts";
import { actionOf, actionsNote, actionText, bySeverity, decide, defaultAction, DEFAULTS, defaultVerdict, linkedComment, suggestionHint, suggestVerdict, withLegacy } from "../src/triage.ts";

// The action rules without a screen: what an action writes, what a finding starts with, how
// actions load, fit and merge.

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
const F = (id: string, hunk: string, line: number, over: Partial<Finding> = {}): Finding => ({ id, source: "critic", hunk, side: "new", line, severity: "medium", kind: "bug", title: `Title ${id}`, claim: `claim ${id}`, evidence: "", status: "upheld", ...over });
const f1 = F("1", h1!.id, 11), f2 = F("2", h1!.id, 11), f3 = F("3", h2!.id, 2);
const empty = (): Human => ({ comments: [], visited: [] });
const A = "a".repeat(40), B = "b".repeat(40);

test("decide: block and comment write the reader's comment at the finding's line; picking again rewrites it; ignore takes it away", () => {
  let h = decide(empty(), f1, "block", { text: "  Where does 42 come from?  ", at: "t" });
  expect(h.comments).toEqual([{ id: "c1", hunk: h1!.id, side: "new", line: 11, text: "Where does 42 come from?", at: "t" }]);
  expect(h.decisions).toEqual({ "1": { kind: "block", comment: "c1" } });
  h = decide(h, f1, "comment", { text: "Worth a constant", at: "t2" }); // same comment, new words, no longer blocking
  expect(h.comments.map((c) => [c.id, c.text])).toEqual([["c1", "Worth a constant"]]);
  expect(h.decisions!["1"]).toEqual({ kind: "comment", comment: "c1" });
  expect(linkedComment(h, "1")?.text).toBe("Worth a constant");
  h = decide(h, f1, "ignore", { reason: " misread ", text: "ignored text", at: "t3" });
  expect(h.comments).toEqual([]); // it would otherwise still post
  expect(h.decisions!["1"]).toEqual({ kind: "ignore", reason: "misread" });
  h = decide(h, f2, "ignore", { at: "t" });
  expect(h.decisions!["2"]).toEqual({ kind: "ignore" });
  // Ignored, then blocked again: a fresh comment, and the note is gone.
  h = decide(h, f1, "block", { text: "on second thoughts", at: "t4" });
  expect(h.decisions!["1"]).toMatchObject({ kind: "block" });
  expect(h.decisions!["1"]!.reason).toBeUndefined();
  expect(linkedComment(h, "1")?.text).toBe("on second thoughts");
  expect(() => decide(h, f3, "block", { text: "  ", at: "t" })).toThrow();
});

test("decide: a new decision comment never reuses an id already taken", () => {
  const h = decide({ comments: [{ id: "c2", hunk: null, side: "new", line: null, text: "x", at: "" }], visited: [] }, f1, "comment", { text: "y", at: "" });
  expect(new Set(h.comments.map((c) => c.id)).size).toBe(2);
});

test("defaults: every finding has an action, its severity's default until the reader picks one", () => {
  expect(DEFAULTS).toEqual({ high: "block", medium: "comment", low: "comment" });
  const hi = F("h", h1!.id, 11, { severity: "high" }), med = F("m", h1!.id, 11), lo = F("l", h2!.id, 2, { severity: "low" });
  expect([hi, med, lo].map((f) => defaultAction(f))).toEqual(["block", "comment", "comment"]);
  expect(actionOf(empty(), hi)).toEqual({ kind: "block", isDefault: true });
  // The defaults come from the config: a user who ignores low findings by default.
  expect(actionOf(empty(), lo, { ...DEFAULTS, low: "ignore" })).toEqual({ kind: "ignore", isDefault: true });
  // Picking the same action as the default is still a choice: it is no longer marked default.
  const h = decide(empty(), hi, "block", { text: "yes", at: "" });
  expect(actionOf(h, hi)).toEqual({ kind: "block", isDefault: false });
  expect(actionText(actionOf(empty(), hi))).toBe("block (default)");
  expect(actionText(actionOf(h, hi))).toBe("block");
  const n = decide(empty(), lo, "ignore", { reason: "known", at: "" });
  expect(actionOf(n, lo)).toEqual({ kind: "ignore", isDefault: false, note: "known" });
});

test("a finding the refute step dropped starts as ignore, whatever its severity; the reader can still act on it", () => {
  const dropped = F("w", h1!.id, 11, { severity: "high", status: "withdrawn", refute: "Line 12 already checks it (cites n12)" });
  expect(defaultAction(dropped)).toBe("ignore");
  expect(actionOf(empty(), dropped)).toEqual({ kind: "ignore", isDefault: true });
  expect(actionOf(decide(empty(), dropped, "comment", { text: "still worth a look", at: "" }), dropped)).toEqual({ kind: "comment", isDefault: false });
});

test("bySeverity counts the findings of each severity, whatever their action", () => {
  expect(bySeverity([F("1", "a", 1, { severity: "high" }), F("2", "a", 1), F("3", "a", 1), F("4", "a", 1, { status: "withdrawn", severity: "low" })])).toEqual({ high: 1, medium: 2, low: 1 });
  expect(bySeverity([])).toEqual({ high: 0, medium: 0, low: 0 });
});

test("verdict default: request changes when the reader blocked on something, else none; the preview lists every finding's action", () => {
  const all = [f1, f3];
  expect(defaultVerdict(all, empty())).toBeUndefined();
  expect(defaultVerdict(all, decide(empty(), f1, "comment", { text: "x", at: "" }))).toBeUndefined();
  const h = decide(empty(), f1, "block", { text: "x", at: "" });
  expect(defaultVerdict(all, h)).toBe("request_changes");
  // A high finding on its default block has no comment of the reader's to post, so it does not pick the verdict.
  expect(defaultVerdict([F("h", h1!.id, 11, { severity: "high" })], empty())).toBeUndefined();
  const place = (hunk: string, line: number | null) => `${hunk.split("@")[0]}:${line}`;
  const note = actionsNote(all, h, place);
  expect(note).toContain("── Findings (2)\n\n▲ src/a.rs:11 · medium · block · Title 1\n▲ src/b.ts:2 · medium · comment (default) · Title 3\n");
  expect(note).toContain("a finding on its default action posts nothing");
  expect(actionsNote([], empty(), place)).toBe("");
  expect(actionsNote([], empty(), place, DEFAULTS, true)).toContain("still hide their findings"); // blind: only that some are hidden
});

test("legacy dismissals load as ignore; an existing action wins", () => {
  expect(withLegacy({ "1": { kind: "block" } }, ["1", "2"])).toEqual({ "1": { kind: "block" }, "2": { kind: "ignore" } });
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
  expect(d.human.decisions).toEqual({ "1": { kind: "block", comment: "c1" }, "2": { kind: "ignore" } });
  expect(parseDocument({ schema: SCHEMA, target: { base: A, head: B } }).human.decisions).toBeUndefined(); // an old document: none
});

test("stored dismissed and ignored decisions (older documents) read as ignore, keeping the private note", () => {
  const d = parseDocument({
    schema: SCHEMA, target: { base: A, head: B },
    findings: [{ id: "1", source: "x", hunk: h1!.id, line: 11, claim: "c" }, { id: "2", source: "x", hunk: h1!.id, line: 11, claim: "d" }, { id: "3", source: "x", hunk: h1!.id, line: 11, claim: "e" }],
    human: { decisions: { "1": { kind: "ignored", reason: "dropped" }, "2": { kind: "dismissed", reason: "misread" }, "3": { kind: "ignore" } } },
  });
  expect(d.human.decisions).toEqual({ "1": { kind: "ignore", reason: "dropped" }, "2": { kind: "ignore", reason: "misread" }, "3": { kind: "ignore" } });
});

test("fit drops decisions on findings that left; merge keeps the reader's, fills in incoming ones with renamed ids and comments", () => {
  const target = { repo: "o/r", base: A, head: B, title: "t", body: "", label: "l" };
  const mine = fit({ ...blank(target), findings: [f1] }, files);
  mine.human = decide(mine.human, f1, "ignore", { at: "" });
  const theirs = fit({ ...blank(target), findings: [F("1", h1!.id, 11, { claim: "other claim" }), { ...f1, id: "x" }, F("gone", "nowhere@1:1", 1)] }, files);
  expect(theirs.findings.map((f) => f.id)).toEqual(["1", "x"]);
  theirs.human = decide(decide(theirs.human, theirs.findings[0]!, "block", { text: "theirs", at: "" }), theirs.findings[1]!, "comment", { text: "on mine", at: "" });
  const m = merge(mine, theirs);
  // Their "1" became "1.2"; its comment came along and the decision points at it. Their "x" is my "1": my decision stands.
  expect(m.findings.map((f) => f.id)).toEqual(["1", "1.2"]);
  const ref = m.human.decisions!["1.2"]!.comment!;
  expect(m.human.comments.find((c) => c.id === ref)?.text).toBe("theirs");
  expect(m.human.decisions!["1"]).toEqual({ kind: "ignore" });
  expect(merge(m, theirs)).toEqual(m);
});

// ---------------------------------------------------------------- the in-house suggested verdict

const fnd = (id: string, severity: Finding["severity"], status: Finding["status"] = "upheld", title = `title ${id}`): Finding =>
  ({ id, source: "critic", hunk: "a.rs@1:1", side: "new", line: 1, severity, kind: "bug", title, claim: "c", evidence: "e", status });

test("suggestVerdict: a high finding means request changes, naming the count and up to two titles", () => {
  expect(suggestVerdict([fnd("a", "high"), fnd("b", "medium"), fnd("c", "high", "unrefuted", "Second one")])).toEqual({ by: "prview", verdict: "request_changes", reason: "2 high: title a; Second one" });
  expect(suggestVerdict([fnd("a", "high"), fnd("b", "high"), fnd("c", "high")]).reason).toBe("3 high: title a; title b; …");
});

test("suggestVerdict: no high but a medium means comment", () => {
  expect(suggestVerdict([fnd("a", "medium"), fnd("b", "low")])).toEqual({ by: "prview", verdict: "comment", reason: "1 medium: title a" });
});

test("suggestVerdict: only low findings, or nothing, means approve", () => {
  expect(suggestVerdict([fnd("a", "low")])).toEqual({ by: "prview", verdict: "approve", reason: "only a low finding" });
  expect(suggestVerdict([fnd("a", "low"), fnd("b", "low")]).reason).toBe("only 2 low findings");
  expect(suggestVerdict([])).toEqual({ by: "prview", verdict: "approve", reason: "no findings" });
});

test("suggestVerdict: findings the refute step dropped never count", () => {
  expect(suggestVerdict([fnd("a", "high", "withdrawn"), fnd("b", "medium", "withdrawn")]).verdict).toBe("approve");
  expect(suggestVerdict([fnd("a", "high", "withdrawn"), fnd("b", "medium")])).toEqual({ by: "prview", verdict: "comment", reason: "1 medium: title b" });
});

test("suggestionHint lists every suggestion as information, and is empty without any", () => {
  const label = (v: string) => v === "approve" ? "Approve" : "Request changes";
  expect(suggestionHint([], label)).toBe("");
  expect(suggestionHint([{ by: "prview", verdict: "request_changes", reason: "x" }, { by: "imported", verdict: "approve" }], label)).toBe("suggested, information only: prview Request changes, imported Approve");
});
