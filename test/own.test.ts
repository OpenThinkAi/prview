import { expect, test } from "bun:test";
import { parseDiff } from "../src/diff.ts";
import { hunksOf, type Finding } from "../src/guide.ts";
import { blank, fit, merge, parseDocument, SCHEMA, type Doc } from "../src/document.ts";
import { fileEdge, nextFindingWrapping, spotsOf } from "../src/nav.ts";
import { clampLine, edgesOf, inputLines, lineRange, ownFinding, rowKind, stepLine } from "../src/rows.ts";
import { github, postingOf, type Runner } from "../src/platform.ts";
import { decide } from "../src/triage.ts";

// Your own findings (AGT-1473), pure: the whole-file rows, making a finding, file-level anchors in the document, and what posts.

const DIFF = `diff --git a/src/a.rs b/src/a.rs
index 1..2 100644
--- a/src/a.rs
+++ b/src/a.rs
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
@@ -40,3 +40,3 @@
 forty
-x
+y
 forty-two
diff --git a/src/b.ts b/src/b.ts
index 1..2 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,2 +1,2 @@
 const x = 1;
-const y = 2;
+const y = 3;
`;
const files = parseDiff(DIFF);
const hs = hunksOf(files);
const items = hs.map((h) => ({ id: h.id, path: h.file.path, hunk: h.hunk!, chapter: 0 })); // a.rs twice, then b.ts
const A = "a".repeat(40), B = "b".repeat(40), PR = "https://github.com/o/r/pull/7";

test("each file's first block starts with a whole-file row and its last block ends with one", () => {
  expect(items.map((_, i) => edgesOf(items, i))).toEqual([{ top: true, end: false }, { top: false, end: true }, { top: true, end: true }]);
  expect(lineRange(items, 0)).toEqual({ min: -1, max: 3 });
  expect(lineRange(items, 1)).toEqual({ min: 0, max: 4 });
  expect(lineRange(items, 2)).toEqual({ min: -1, max: 3 });
  expect(clampLine(items, { item: 1, line: -1 })).toBe(0); // the middle block has no row of its own
  expect(rowKind(items, { item: 0, line: -1 })).toBe("start");
  expect(rowKind(items, { item: 1, line: 4 })).toBe("end");
  expect(rowKind(items, { item: 1, line: 3 })).toBe("line");
  expect(fileEdge(items, 1, "top")).toEqual({ item: 0, line: -1 });
  expect(fileEdge(items, 0, "end")).toEqual({ item: 1, line: 4 });
});

test("stepping runs through the rows and on into the next block", () => {
  expect(stepLine(items, { item: 0, line: -1 }, -1)).toBeUndefined();
  expect(stepLine(items, { item: 0, line: -1 }, 1)).toEqual({ item: 0, line: 0 });
  expect(stepLine(items, { item: 0, line: 3 }, 1)).toEqual({ item: 1, line: 0 }); // a.rs continues: no row between its blocks
  expect(stepLine(items, { item: 1, line: 0 }, -1)).toEqual({ item: 0, line: 3 });
  expect(stepLine(items, { item: 1, line: 3 }, 1)).toEqual({ item: 1, line: 4 }); // the row that ends a.rs
  expect(stepLine(items, { item: 1, line: 4 }, 1)).toEqual({ item: 2, line: -1 }); // b.ts starts with its row
  expect(stepLine(items, { item: 2, line: 3 }, 1)).toBeUndefined();
});

test("ownFinding: a finding of yours with the default action for its severity, carried out as your own comment", () => {
  const h = { comments: [], visited: [] };
  const line = ownFinding([], h, { hunk: hs[0]!.id, side: "new", line: 2 }, "high", "  why TWO?\nit was two  ", "now");
  expect(line.finding).toMatchObject({ id: "you-1", source: "you", hunk: hs[0]!.id, side: "new", line: 2, severity: "high", kind: "finding", claim: "why TWO?\nit was two", status: "unrefuted" });
  expect(line.finding.file).toBeUndefined();
  expect(line.human.decisions).toEqual({ "you-1": { kind: "block", comment: "c1" } });
  expect(line.human.comments).toEqual([{ id: "c1", hunk: hs[0]!.id, side: "new", line: 2, text: "why TWO?\nit was two", at: "now" }]);
  const file = ownFinding([line.finding], line.human, { hunk: hs[1]!.id, file: "end" }, "low", "split this file", "now");
  expect(file.finding).toMatchObject({ id: "you-2", file: true, line: 1, hunk: hs[1]!.id, severity: "low" });
  expect(file.human.decisions!["you-2"]).toEqual({ kind: "comment", comment: "c2" });
  expect(file.human.comments[1]).toEqual({ id: "c2", hunk: hs[1]!.id, side: "new", line: null, text: "split this file", at: "now", file: true });
  // The default of ignore leaves it on its default: there is no comment to post until you pick block or comment.
  const quiet = ownFinding([], h, { hunk: hs[0]!.id, side: "new", line: 2 }, "low", "meh", "now", { high: "block", medium: "comment", low: "ignore" });
  expect(quiet.human).toBe(h);
  expect(() => ownFinding([], h, { hunk: hs[0]!.id, side: "new", line: 2 }, "low", "  ", "now")).toThrow();
  // The claim is cut to the schema's length; the comment keeps every word.
  const long = ownFinding([], h, { hunk: hs[0]!.id, side: "new", line: 2 }, "low", "w".repeat(400), "now");
  expect(long.finding.claim.length).toBeLessThanOrEqual(301);
  expect(long.human.comments[0]!.text).toBe("w".repeat(400));
});

test("typed text as rows: a newline starts a row, long rows break, never empty", () => {
  expect(inputLines("", 10)).toEqual([""]);
  expect(inputLines("ab\ncd", 10)).toEqual(["ab", "cd"]);
  expect(inputLines("abcdef\n", 4)).toEqual(["abcd", "ef", ""]);
});

test("file-level findings sit on their row in reading order; g f walks to them", () => {
  const f = (id: string, over: Partial<Finding>): Finding => ({ id, source: "you", hunk: hs[0]!.id, side: "new", line: 1, severity: "medium", kind: "finding", claim: id, evidence: "", status: "unrefuted", ...over });
  const spots = spotsOf(items, [f("end", { hunk: hs[1]!.id, file: true, line: 1 }), f("line", {}), f("top", { file: true, line: 0 })]);
  expect(spots.map((s) => [s.finding.id, s.item, s.line])).toEqual([["top", 0, -1], ["line", 0, 0], ["end", 1, 4]]);
  expect(nextFindingWrapping(items, spots.map((s) => s.finding), { item: 0, line: -1 }, 1)?.finding.id).toBe("line");
});

const doc = (findings: unknown[], human: unknown = {}) => ({ schema: SCHEMA, target: { base: A, head: B }, findings, human });

test("the document reads file-level findings and comments; older documents load as they were", () => {
  const d = parseDocument(doc(
    [{ id: "a", source: "you", hunk: hs[0]!.id, file: true, claim: "whole file" }, { id: "b", source: "s", hunk: hs[0]!.id, file: true, line: 1, claim: "end" }, { id: "c", source: "s", hunk: hs[0]!.id, line: 2, claim: "a line" }, { id: "d", source: "s", hunk: hs[0]!.id, claim: "no line" }],
    { comments: [{ id: "c1", hunk: hs[0]!.id, line: null, file: true, text: "t", at: "x" }, { hunk: null, file: true, text: "general stays general" }] },
  ));
  expect(d.findings.map((f) => [f.id, f.file, f.line])).toEqual([["a", true, 0], ["b", true, 1], ["c", undefined, 2]]); // "d" has neither a line nor a file: dropped as before
  expect(d.human.comments).toEqual([{ id: "c1", hunk: hs[0]!.id, side: "new", line: null, text: "t", at: "x", file: true }, { hunk: null, side: "new", line: null, text: "general stays general", at: "" }]);
  // Nothing in an old document has the field, and it round-trips.
  const old = parseDocument(doc([{ id: "c", source: "s", hunk: hs[0]!.id, line: 2, claim: "a line" }]));
  expect(old.findings[0]).not.toHaveProperty("file");
  expect(parseDocument(JSON.parse(JSON.stringify(d))).findings.map((f) => f.file)).toEqual([true, true, undefined]);
});

test("fit keeps a file-level finding on its hunk and does not move it to a line; merge tells it from a line finding", () => {
  const d = parseDocument(doc([{ id: "a", source: "you", hunk: hs[0]!.id, file: true, claim: "whole file" }, { id: "x", source: "you", hunk: "gone@1:1", file: true, claim: "no such hunk" }]));
  const fitted = fit(d, files);
  expect(fitted.findings.map((f) => [f.id, f.line, f.file])).toEqual([["a", 0, true]]);
  const into: Doc = { ...blank(d.target), findings: [{ id: "a", source: "you", hunk: hs[0]!.id, side: "new", line: 0, severity: "medium", kind: "finding", claim: "whole file", evidence: "", status: "unrefuted" }] };
  expect(merge(into, fitted).findings).toHaveLength(2); // same words, one on a line and one on the file
});

// A fake gh, answering the calls the adapter makes.
type Call = { method: string; path: string; body?: any };
function fakeGh(over: { refuseFile?: boolean } = {}) {
  const calls: Call[] = [];
  const run: Runner = (argv, o) => {
    const body = o.stdin === undefined ? undefined : JSON.parse(o.stdin), method = argv[3]!, path = argv[4]!;
    calls.push({ method, path, body });
    if (method === "GET") return { exit: 0, stdout: JSON.stringify({ head: { sha: B } }), stderr: "" };
    if (path.endsWith("/reviews")) return { exit: 0, stdout: JSON.stringify({ id: 99 }), stderr: "" };
    if (path.endsWith("/pulls/7/comments") && over.refuseFile) return { exit: 1, stdout: JSON.stringify({ message: "Unprocessable Entity" }), stderr: "" };
    if (path.endsWith("/events")) return { exit: 0, stdout: JSON.stringify({ html_url: `${PR}#r` }), stderr: "" };
    return { exit: 0, stdout: "{}", stderr: "" };
  };
  return { calls, run };
}
const target = { ...blank({ repo: "o/r", base: A, head: B, title: "t", body: "", label: "l", url: PR, platform: "github" }).target };
const comments = [
  { id: "c1", hunk: hs[0]!.id, side: "new" as const, line: 2, text: "a line comment", at: "now" },
  { id: "c2", hunk: hs[1]!.id, side: "new" as const, line: null, text: "about the whole file", at: "now", file: true as const },
];

test("a file-level comment posts as a file-level review comment (subject_type file) after the line comments, and never in the summary", () => {
  const p = postingOf("comment", comments, (id) => id.split("@")[0]);
  expect(p.comments).toEqual([{ path: "src/a.rs", side: "new", line: 2, text: "a line comment" }]);
  expect(p.files).toEqual([{ path: "src/a.rs", text: "about the whole file" }]);
  const { calls, run } = fakeGh();
  expect(github.post(target, p, run, "/wt")).toEqual({ url: `${PR}#r` });
  expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET repos/o/r/pulls/7", "POST repos/o/r/pulls/7/reviews", "POST repos/o/r/pulls/7/comments", "POST repos/o/r/pulls/7/reviews/99/events"]);
  expect(calls[1]!.body.comments).toHaveLength(1); // the pending review holds only the line comment
  expect(calls[2]!.body).toEqual({ commit_id: B, path: "src/a.rs", subject_type: "file", body: "about the whole file" });
  expect(calls[3]!.body).toEqual({ event: "COMMENT", body: "" });
  expect(github.describe(target, p)).toContain("1 line comment, 1 whole-file comment");
  expect(github.dryRun(target, p).join("\n")).toContain('"subject_type": "file"');
});

test("a file-level comment GitHub refuses falls back to the summary under its file name; a file comment alone is words enough", () => {
  const p = postingOf("request_changes", [comments[1]!], (id) => id.split("@")[0]);
  const { calls, run } = fakeGh({ refuseFile: true });
  github.post(target, p, run, "/wt");
  expect(calls.at(-1)!.body).toEqual({ event: "REQUEST_CHANGES", body: "src/a.rs: about the whole file" });
  expect(github.describe(target, p)).not.toContain("not posted"); // a whole-file comment counts as the words requesting changes needs
  expect(github.describe(target, postingOf("request_changes", [], () => undefined))).toContain("not posted");
});

test("a finding's action on a file writes a file comment, and ignoring it takes the comment back", () => {
  const f = ownFinding([], { comments: [], visited: [] }, { hunk: hs[0]!.id, file: "start" }, "medium", "first words", "t").finding;
  const h1 = decide({ comments: [], visited: [] }, f, "block", { text: "my words", at: "t" });
  expect(postingOf("request_changes", h1.comments, (id) => id.split("@")[0]).files).toEqual([{ path: "src/a.rs", text: "my words" }]);
  const h2 = decide(h1, f, "ignore", { at: "t" });
  expect(postingOf("comment", h2.comments, (id) => id.split("@")[0]).files).toBeUndefined();
});
