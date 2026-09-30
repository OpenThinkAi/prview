import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { cleanup, render } from "ink-testing-library";
import { parseDiff } from "../src/diff.ts";
import { hunksOf, type Finding } from "../src/guide.ts";
import type { Review } from "../src/build.ts";
import type { Doc } from "../src/document.ts";
import { chapterHidden, earlyTitles, hiddenHunks, revealBody, revealEarly } from "../src/blind.ts";
import { writeup } from "../src/build.ts";
import { parseDocument, SCHEMA } from "../src/document.ts";
import { parseConfig } from "../src/config.ts";
import { App, type Outcome } from "../src/tui.tsx";
import { highlightLines, langOf, sliceSpans, styleOf } from "../src/highlight.ts";
import { clampScroll, clampX, floatHeight, layoutOf, pageStep, windowOf, wrapText } from "../src/layout.ts";
import { editorArgs, tmuxSplit, besideIn } from "../src/editor.ts";

// The five screens, driven with keys the way a reader would. App writes the review to $PRVIEW_HOME as it
// goes, so each test gets a scratch one; there is no terminal, so the size is passed in.
let tmp = "", saved: string | undefined;
beforeAll(() => { saved = process.env.PRVIEW_HOME; tmp = mkdtempSync(join(tmpdir(), "prview-tui-")); process.env.PRVIEW_HOME = tmp; });
afterAll(() => { cleanup(); rmSync(tmp, { recursive: true, force: true }); if (saved === undefined) delete process.env.PRVIEW_HOME; else process.env.PRVIEW_HOME = saved; });

const DIFF = `diff --git a/src/a.rs b/src/a.rs
index 1..2 100644
--- a/src/a.rs
+++ b/src/a.rs
@@ -10,3 +10,4 @@ fn main() {
 keep
-old
+let answer = 42; // ${"long ".repeat(30)}end
+new2
 keep2
diff --git a/src/b.ts b/src/b.ts
index 1..2 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,2 +1,2 @@
 const x = 1;
-const y = 2;
+const y = "two";
`;
const files = parseDiff(DIFF);
const [h1, h2] = hunksOf(files);

const finding: Finding = { id: "1", source: "critic", hunk: h1!.id, side: "new", line: 11, severity: "blocking", kind: "bug", claim: "answer is hard-coded", evidence: "42 appears with no source", status: "upheld" };
type Over = { findings?: Finding[]; comments?: Doc["human"]["comments"]; plan?: Doc["plan"] };
function fixture(over: Over = {}): Review {
  const doc: Doc = {
    schema: "prview-review/1",
    target: { repo: "/nowhere", base: "a", head: "b", title: "A change", body: "", label: "main..x" },
    plan: over.plan ?? {
      summary: "", by: "guide", mechanical: [],
      chapters: [
        { title: "Core change", intent: "Check the answer is derived", why: "It is the heart of it.", hunks: [h1!.id] },
        { title: "The ts side", intent: "Check the type", why: "Second.", hunks: [h2!.id] },
      ],
    },
    findings: over.findings ?? [finding],
    human: { comments: over.comments ?? [], dismissals: [], visited: [] },
  };
  return { slug: "t", repo: "/nowhere", worktree: "/nowhere", context: 3, created: "now", pos: { item: 0, line: 0 }, doc };
}

const settle = () => new Promise((r) => setTimeout(r, 30));
async function open(over?: Over, props: { blind?: boolean; cols?: number; rows?: number; beside?: (p: string, l: number) => string | undefined } = {}) {
  const outcomes: Outcome[] = [];
  const r = fixture(over);
  const app = render(<App review={r} files={files} onDone={(o) => outcomes.push(o)} beside={props.beside} blind={props.blind} size={{ cols: props.cols ?? 120, rows: props.rows ?? 40 }} />);
  await settle();
  // One key at a time: a handler closes over the state of its render, so two keys in one chunk would both see the old cursor.
  const press = async (keys: string) => { for (const k of keys.match(/\x1b\[\d+~|./gsu) ?? []) { app.stdin.write(k); await settle(); } };
  return { r, app, press, outcomes, frame: () => (app.lastFrame() ?? "").replace(/\x1b\[[0-9;]*m/g, "") };
}

test("rail: the current chapter is marked with its hunks, a read chapter is ticked, findings are counted", async () => {
  const t = await open();
  expect(t.frame()).toContain("▸ 1 Core change ▲1");
  expect(t.frame()).toContain("› a.rs:10");
  expect(t.frame()).toContain("2 The ts side");
  await t.press("l");
  expect(t.frame()).toContain("✓ 1 Core change");
  expect(t.frame()).toContain("▸ 2 The ts side");
  expect(t.r.doc.human.visited).toEqual([h1!.id, h2!.id]);
});

test("rail: below 100 columns it collapses to chapter numbers and the code keeps the room", async () => {
  const t = await open(undefined, { cols: 80 });
  expect(t.frame()).toContain("▸1▲1");
  expect(t.frame()).not.toContain("Core change");
  expect(t.frame()).toContain("Check the answer is derived"); // the chapter's intent is still on the hunk header
  for (const line of t.frame().split("\n")) expect([...line].length).toBeLessThanOrEqual(80);
  expect(t.frame()).toContain("j/k h/l hunk"); // the short footer, not one that wraps
});

test("cursor row: j and k move it, the line number and the sign stay in the gutter, G and gg jump", async () => {
  const t = await open(undefined, { cols: 100 });
  expect(t.r.pos.line).toBe(0);
  await t.press("jj");
  expect(t.r.pos.line).toBe(2);
  await t.press("G");
  expect(t.r.pos.line).toBe(4);
  await t.press("gg");
  expect(t.r.pos.line).toBe(0);
  await t.press("k");
  expect(t.r.pos.line).toBe(0);
  expect(t.frame()).toMatch(/10\s+ keep/);
  expect(t.frame()).toMatch(/11\s+▲\s*\+let answer/);
});

test("finding float: f opens the finding under the cursor, d dismisses it, Esc closes the box", async () => {
  const t = await open();
  await t.press("f");
  expect(t.frame()).toContain("critic · bug · blocking");
  expect(t.frame()).toContain("answer is hard-coded");
  expect(t.r.pos.line).toBe(2); // the cursor moved to the finding's line
  await t.press("d");
  expect(t.r.doc.human.dismissals).toEqual(["1"]);
  expect(t.frame()).not.toContain("answer is hard-coded");
  await t.press("f");
  expect(t.frame()).toContain("dismissed");
  await t.press("\x1b");
  await settle();
  expect(t.frame()).not.toContain("answer is hard-coded");
});

test("finding float: a long body pages with PgDn and never scrolls past its end", async () => {
  const evidence = Array.from({ length: 40 }, (_, i) => `line-${i}`).join("\n");
  const t = await open({ findings: [{ ...finding, evidence }] }, { rows: 24 });
  await t.press("f");
  expect(t.frame()).toContain("line-0");
  expect(t.frame()).not.toContain("line-39");
  await t.press("\x1b[6~");
  expect(t.frame()).not.toContain("line-0\n");
  for (let i = 0; i < 12; i++) await t.press("\x1b[6~");
  expect(t.frame()).toContain("line-39"); // the last page shows the end, not blank space
  await t.press("\x1b[5~");
  expect(t.frame()).toContain("line-");
  expect(t.frame()).toContain("▲"); // the cursor row is still drawn above the float
  expect(t.frame()).toContain("+let answer");
});

test("comment row: n takes a line note, shown under the cursor line with a mark in the gutter; N is a general note", async () => {
  const t = await open();
  await t.press("jjn");
  expect(t.frame()).toContain("comment ›");
  await t.press("why 42?");
  await t.press("\r");
  expect(t.r.doc.human.comments.map((n) => [n.hunk, n.side, n.line, n.text])).toEqual([[h1!.id, "new", 11, "why 42?"]]);
  expect(t.frame()).toMatch(/» why 42\?/);
  await t.press("N");
  await t.press("overall fine");
  await t.press("\r");
  expect(t.r.doc.human.comments[1]).toMatchObject({ hunk: null, line: null, text: "overall fine" });
  expect(t.frame()).toContain("2 comments");
});

test("submit flow: s asks for a verdict, previews the write-up, Esc goes back, Enter submits", async () => {
  const t = await open({ comments: [{ hunk: h1!.id, side: "new", line: 11, text: "why 42?", at: "now" }] });
  await t.press("s");
  expect(t.frame()).toContain("verdict ›");
  await t.press("r");
  expect(t.r.doc.human.verdict).toBe("request_changes");
  expect(t.frame()).toContain("Request changes");
  expect(t.frame()).toContain("why 42?");
  await t.press("\x1b");
  expect(t.frame()).toContain("verdict ›");
  await t.press("c");
  expect(t.outcomes).toEqual([]);
  await t.press("\r");
  expect(t.outcomes).toEqual([{ kind: "submit", hook: false }]);
  expect(t.frame()).not.toContain("x allows"); // no command in the document, nothing to allow
});

test("submit flow: the document's command is shown in full and runs only after its own key, x", async () => {
  const t = await open();
  t.r.doc.on_submit = { run: ["notify-tool", "--file", "{file}"] };
  await t.press("sa");
  await t.press("\x1b[6~\x1b[6~\x1b[6~"); // page down to the end of the preview
  expect(t.frame()).toContain("notify-tool --file");
  expect(t.frame()).toContain("t.json"); // {file}, filled in: the path the document is written to
  expect(t.frame()).toContain("no shell, stopped after 60s");
  expect(t.frame()).toContain("[ ] Not allowed");
  await t.press("x");
  expect(t.frame()).toContain("[x] Allowed");
  await t.press("x");
  expect(t.frame()).toContain("[ ] Not allowed");
  await t.press("x");
  await t.press("\r");
  expect(t.outcomes).toEqual([{ kind: "submit", hook: true }]);
});

test("submit flow: allowing the command does not outlive the preview; back to the verdict and it is off again", async () => {
  const t = await open();
  t.r.doc.on_submit = { run: ["notify-tool"] };
  await t.press("sax");
  await t.press("\x1b");
  await t.press("a\r");
  expect(t.outcomes).toEqual([{ kind: "submit", hook: false }]);
});

test("long lines: cut with an ellipsis, H/L pan, w wraps onto more rows and back", async () => {
  const t = await open(undefined, { cols: 100 });
  await t.press("jj");
  expect(t.frame()).toContain("…");
  expect(t.frame()).not.toContain("end");
  await t.press("LLLLLLLLLLLLLLLLLLLL");
  expect(t.frame()).toContain("end");
  expect(t.frame()).toContain("→");
  await t.press("w");
  expect(t.frame()).toContain("wrapped");
  expect(t.frame()).toContain("↪");
  expect(t.frame()).toContain("end");
  await t.press("w");
  expect(t.frame()).not.toContain("wrapped");
});

test("editor: without tmux `e` hands the file and line back; with a side pane it opens there and the screen stays", async () => {
  const plain = await open();
  await plain.press("jje");
  expect(plain.outcomes).toEqual([{ kind: "edit", path: "src/a.rs", line: 11 }]);

  const opened: [string, number][] = [];
  const t = await open(undefined, { beside: (p, l) => { opened.push([p, l]); return undefined; } });
  await t.press("je");
  expect(opened).toEqual([["src/a.rs", 11]]); // the cursor is on a removed line: the next new line is the anchor
  expect(t.outcomes).toEqual([]);
  expect(t.frame()).toContain("Core change");

  const bad = await open(undefined, { beside: () => "tmux could not open a pane: no space" });
  await bad.press("e");
  expect(bad.frame()).toContain("no space");
});

// ---------------------------------------------------------------- the pure parts

test("highlight: comments, strings, numbers, keywords and types per language; unknown languages stay plain", () => {
  const [line] = highlightLines([`const n: Foo = 42; // note "not a string"`], langOf("x.ts"));
  expect(line!.map((s) => [s.kind, s.text])).toEqual([
    ["keyword", "const"], ["plain", " n: "], ["type", "Foo"], ["plain", " = "], ["number", "42"], ["plain", "; "], ["comment", `// note "not a string"`],
  ]);
  const [rs] = highlightLines([`fn f<'a>(c: char) -> &'a str { 'x'; "s\\"q" }`], "rust");
  const kinds = new Set(rs!.map((s) => s.kind));
  expect(kinds.has("keyword") && kinds.has("string")).toBe(true);
  expect(rs!.some((s) => s.kind === "string" && s.text === "'x'")).toBe(true);
  expect(rs!.some((s) => s.text.includes("'a") && s.kind === "string")).toBe(false); // a lifetime is not a string
  expect(highlightLines(["let x = 1"], langOf("README"))[0]).toEqual([{ text: "let x = 1", kind: "plain" }]);
  expect(langOf("a/b/c.PY")).toBe("python");
});

test("highlight: a block comment carries across lines; every span list re-joins to its input", () => {
  const src = ["/** doc", " * more */ let a = 1", "x = 'unterminated"];
  const out = highlightLines(src, "ts");
  expect(out[0]!.every((s) => s.kind === "comment")).toBe(true);
  expect(out[1]![0]).toEqual({ kind: "comment", text: " * more */" });
  expect(out.map((l) => l.map((s) => s.text).join(""))).toEqual(src);
});

test("highlight: on changed lines only weight and slant differ, so the +/- colour stays dominant", () => {
  for (const k of ["keyword", "string", "comment", "number", "type", "plain"] as const) expect(styleOf(k, true).color).toBeUndefined();
  expect(styleOf("keyword", false).color).toBeDefined();
  expect(sliceSpans([{ kind: "keyword", text: "const" }, { kind: "plain", text: " x" }], 3, 6)).toEqual([{ kind: "keyword", text: "st" }, { kind: "plain", text: " " }]);
});

test("layout: 100 columns is the edge of the narrow rail; the float never takes the cursor's room; pages stay in range", () => {
  expect(layoutOf(99).narrow).toBe(true);
  expect(layoutOf(100).narrow).toBe(false);
  expect(layoutOf(80).codeW).toBeGreaterThan(60);
  for (const rows of [12, 20, 31, 60]) for (const tall of [false, true]) {
    const h = floatHeight(500, rows, tall);
    expect(rows - 5 - h).toBeGreaterThanOrEqual(3);
  }
  expect(floatHeight(1, 40, false)).toBe(4);
  expect(clampScroll(99, 40, 10)).toBe(33);
  expect(clampScroll(-5, 40, 10)).toBe(0);
  expect(pageStep(10)).toBe(6);
  expect(clampX(500, 200, 60)).toBe(140);
  expect(wrapText("aaa bbb ccc\n\nd", 7)).toEqual(["aaa bbb", "ccc", "", "d"]);
});

test("layout: the window always holds the cursor line, centred when it can be, and respects tall (wrapped) lines", () => {
  expect(windowOf([1, 1, 1, 1, 1, 1, 1], 3, 3)).toEqual({ start: 2, end: 5 });
  expect(windowOf([1, 1, 1, 1, 1], 0, 3)).toEqual({ start: 0, end: 3 });
  expect(windowOf([1, 1, 1, 1, 1], 4, 3)).toEqual({ start: 2, end: 5 });
  expect(windowOf([1, 5, 1], 1, 3)).toEqual({ start: 1, end: 2 }); // taller than the budget: still drawn
  expect(windowOf([], 0, 3)).toEqual({ start: 0, end: 0 });
});

test("editor: per-editor line syntax, the tmux split runs in the worktree, and the side pane is offered only inside tmux", () => {
  expect(editorArgs(["hx"], "a.rs", 7)).toEqual(["hx", "+7", "a.rs"]);
  expect(editorArgs(["code"], "a.rs", 7)).toEqual(["code", "-g", "a.rs:7", "--wait"]);
  const cmd = tmuxSplit(["vim", "+7", "it's.rs"], "/wt");
  expect(cmd.slice(0, 7)).toEqual(["tmux", "split-window", "-h", "-l", "60%", "-c", "/wt"]);
  expect(cmd[7]!.startsWith("sh -c '")).toBe(true);
  expect(cmd[7]).toContain("it"); // the filename's quote is escaped twice over, once for the inner command and once for sh -c
  expect(besideIn("/wt", {})).toBeUndefined();
  expect(besideIn("/wt", { TMUX: "/tmp/tmux-1/default,1,0" })).toBeFunction();
});

test("a hunk taller than the screen scrolls its window and keeps each line's own colour", async () => {
  const body = Array.from({ length: 60 }, (_, i) => (i === 50 ? "+const marker = 1;" : `+// filler ${i}`)).join("\n");
  const tall = parseDiff(`diff --git a/t.ts b/t.ts\n--- a/t.ts\n+++ b/t.ts\n@@ -0,0 +1,60 @@\n${body}\n`);
  const [hk] = hunksOf(tall);
  const r = fixture({ findings: [], plan: { summary: "", by: "files", mechanical: [], chapters: [{ title: "T", intent: "", why: "", hunks: [hk!.id] }] } });
  const app = render(<App review={r} files={tall} onDone={() => {}} size={{ cols: 100, rows: 20 }} />);
  await settle();
  app.stdin.write("5"); await settle(); app.stdin.write("1"); await settle(); app.stdin.write("G"); await settle();
  const raw = app.lastFrame() ?? "";
  const row = raw.split("\n").find((l) => l.includes("marker"))!;
  expect(row).toBeDefined();
  // The keyword is bold inside the green line: colour alignment follows the line, not its position in the window.
  expect(row).toMatch(/\x1b\[1mconst\x1b\[22m/);
  expect(raw.split("\n").filter((l) => l.includes("filler")).every((l) => !/\x1b\[1m/.test(l))).toBe(true);
});

// ---------------------------------------------------------------- blind first pass

test("blind gate (pure): hidden until every hunk is visited or revealed early; early reveal only counts when it skipped reading", () => {
  const ch = [["a", "b"], ["c"]];
  expect(chapterHidden(false, ch[0]!, { visited: [] })).toBe(false); // blind off: nothing is hidden
  expect(chapterHidden(true, [], { visited: [] })).toBe(false);
  expect([...hiddenHunks(true, ch, { visited: ["a"] })]).toEqual(["a", "b", "c"]);
  expect([...hiddenHunks(true, ch, { visited: ["a", "b"] })]).toEqual(["c"]);
  expect([...hiddenHunks(true, ch, { visited: [], revealed: ["c"] })]).toEqual(["a", "b"]);
  expect(revealEarly(true, ch[0]!, { visited: ["a"] })).toEqual(["a"]);
  expect(revealEarly(true, ch[0]!, { visited: ["a"], revealed: ["a"] })).toBeNull(); // already revealed
  expect(revealEarly(true, ch[0]!, { visited: ["a", "b"] })).toBeNull(); // read: not early
  expect(revealEarly(false, ch[0]!, { visited: [] })).toBeNull();
  expect(earlyTitles([{ title: "One", ids: ["a", "b"] }, { title: "Two", ids: ["c"] }], { visited: [], revealed: ["c"] })).toEqual(["Two"]);
  const body = revealBody([finding], [{ hunk: h1!.id, side: "new", line: 11, text: "why 42?", at: "" }], (h, l) => `${h}:${l}`);
  expect(body).toContain("The model found 1:");
  expect(body).toContain("answer is hard-coded");
  expect(body).toContain("You noted 1:");
  expect(body).toContain("why 42?");
});

test("blind: a document from before the pass loads, `revealed` is read defensively and merged, and the config key is checked", () => {
  const sha = "a".repeat(40), tgt = { base: sha, head: "b".repeat(40) };
  expect(parseDocument({ schema: SCHEMA, target: tgt }).human.revealed).toBeUndefined();
  expect(parseDocument({ schema: SCHEMA, target: tgt, human: { revealed: ["x@1:1", 4, "x@1:1"] } }).human.revealed).toEqual(["x@1:1"]);
  expect(parseDocument({ schema: SCHEMA, target: tgt, human: { revealed: "nope" } }).human.revealed).toBeUndefined();
  expect(parseConfig("").blind).toBe(false);
  expect(parseConfig("blind = true\n[roles]").blind).toBe(true);
  expect(() => parseConfig('blind = "yes"')).toThrow(/blind/);
});

test("blind: before visiting, the gutter has no ▲, the rail shows ▲?, f and ]f are disabled and d does nothing", async () => {
  // Two hunks in one chapter, cursor on the first: the chapter is not read yet.
  const t = await open({ plan: { summary: "", by: "guide", mechanical: [], chapters: [{ title: "Both", intent: "Check it", why: "w", hunks: [h1!.id, h2!.id] }] } }, { blind: true });
  expect(t.frame()).not.toContain("▲ ");
  expect(t.frame()).toContain("Both ▲?");
  expect(t.frame()).toContain("0 ▲?"); // header: nothing revealed, something hidden
  expect(t.frame()).toContain("F reveal");
  await t.press("f");
  expect(t.frame()).toContain("Hidden until you have been through this chapter");
  expect(t.frame()).not.toContain("answer is hard-coded");
  await t.press("\x1b");
  await t.press("]f");
  expect(t.frame()).not.toContain("answer is hard-coded");
  expect(t.r.pos.item).toBe(0);
  await t.press("d");
  expect(t.r.doc.human.dismissals).toEqual([]);
  expect(t.r.doc.human.revealed).toBeUndefined();
});

test("blind: F reveals early, lists the findings beside the reader's comments, and the reveal is recorded and written up", async () => {
  const t = await open({ comments: [{ hunk: h1!.id, side: "new", line: 11, text: "why 42?", at: "now" }], plan: { summary: "", by: "guide", mechanical: [], chapters: [{ title: "Both", intent: "Check it", why: "w", hunks: [h1!.id, h2!.id] }] } }, { blind: true });
  await t.press("F");
  const f = t.frame();
  expect(f).toContain("what the model found");
  expect(f).toContain("The model found 1:");
  expect(f).toContain("answer is hard-coded");
  expect(f).toContain("You noted 1:");
  expect(f).toContain("why 42?");
  expect(t.r.doc.human.revealed).toEqual([h1!.id]);
  await t.press("\x1b");
  expect(t.frame()).toContain("Both ▲1"); // and the gutter is back
  expect(writeup(t.r.doc, files)).toContain("Findings seen before reading: Both");
  await t.press("F"); // pressing again is not another early reveal
  expect(t.r.doc.human.revealed).toEqual([h1!.id]);
});

test("blind: visiting every hunk of a chapter reveals it without recording anything", async () => {
  const t = await open({ plan: { summary: "", by: "guide", mechanical: [], chapters: [{ title: "Both", intent: "Check it", why: "w", hunks: [h1!.id, h2!.id] }] } }, { blind: true });
  expect(t.frame()).toContain("Both ▲?");
  await t.press("l"); // visits the second hunk; the first was visited on open
  expect(t.frame()).toContain("1 Both ▲1");
  await t.press("h");
  await t.press("]f");
  expect(t.frame()).toContain("answer is hard-coded");
  expect(t.r.doc.human.revealed).toBeUndefined();
  expect(writeup(t.r.doc, files)).not.toContain("seen before reading");
});

test("blind off: nothing is hidden and the footer does not offer F", async () => {
  const t = await open();
  expect(t.frame()).toContain("▸ 1 Core change ▲1");
  expect(t.frame()).not.toContain("F reveal");
});
