import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
import { FINDING_KEYS, findingFooter, INFO_KEYS, infoFooter, NAV_KEYS, navFooter } from "../src/keys.ts";
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

const finding: Finding = { id: "1", source: "critic", hunk: h1!.id, side: "new", line: 11, severity: "blocking", kind: "bug", title: "Hard-coded answer in main", claim: "answer is hard-coded", evidence: "42 appears with no source", status: "upheld" };
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
    human: { comments: over.comments ?? [], visited: [] },
  };
  return { slug: "t", repo: "/nowhere", worktree: "/nowhere", context: 3, created: "now", pos: { item: 0, line: 0 }, doc };
}

const settle = () => new Promise((r) => setTimeout(r, 30));
async function open(over?: Over, props: { ai?: Review["ai"]; blind?: boolean; dryRun?: boolean; cols?: number; rows?: number; beside?: (p: string, l: number) => string | undefined } = {}) {
  const outcomes: Outcome[] = [];
  const r = fixture(over);
  r.ai = props.ai;
  const app = render(<App review={r} files={files} onDone={(o) => outcomes.push(o)} beside={props.beside} blind={props.blind} dryRun={props.dryRun} size={{ cols: props.cols ?? 120, rows: props.rows ?? 40 }} />);
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
  expect(t.frame()).toContain("j/k line  h/l hunk"); // the short footer, not one that wraps
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

test("finding float: f opens the finding under the cursor with progress and the decision keys, Esc closes the box", async () => {
  const t = await open();
  await t.press("f");
  expect(t.frame()).toContain("critic · bug · blocking");
  // The title leads, the claim and evidence sit under it.
  const fr = t.frame();
  expect(fr.indexOf("Hard-coded answer in main")).toBeGreaterThan(fr.indexOf("critic · bug · blocking"));
  expect(fr.indexOf("answer is hard-coded")).toBeGreaterThan(fr.indexOf("Hard-coded answer in main"));
  expect(t.r.pos.line).toBe(2); // the cursor moved to the finding's line
  expect(fr).toContain("0/1 decided");
  expect(fr).toContain("n not an issue  b block  c comment  u undo  h hide  ]f next  y copy");
  expect(fr).not.toContain("b block on it"); // the box has no key-hint line of its own
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
  expect(t.frame()).not.toContain("as comments?"); // no question about posting findings: b and c are how one becomes a comment
  expect(t.frame()).toContain("Request changes");
  expect(t.frame()).toContain("why 42?");
  await t.press("\x1b");
  expect(t.frame()).toContain("verdict ›");
  await t.press("c");
  expect(t.outcomes).toEqual([]);
  await t.press("\r");
  expect(t.outcomes).toEqual([{ kind: "submit", hook: false, coverage: false }]);
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
  expect(t.outcomes).toEqual([{ kind: "submit", hook: true, coverage: false }]);
});

test("submit flow: allowing the command does not outlive the preview; back to the verdict and it is off again", async () => {
  const t = await open();
  t.r.doc.on_submit = { run: ["notify-tool"] };
  await t.press("sax");
  await t.press("\x1b");
  await t.press("a\r");
  expect(t.outcomes).toEqual([{ kind: "submit", hook: false, coverage: false }]);
});

test("submit flow: the preview leads with the undecided findings; with one blocking, Enter picks request changes", async () => {
  const second: Finding = { ...finding, id: "2", hunk: h2!.id, line: 2, severity: "warn", title: "Type changed to a string" };
  const t = await open({ findings: [finding, second] });
  await t.press("s");
  expect(t.frame()).not.toContain("(Enter)"); // nothing blocking and no verdict yet: no default
  await t.press("\r");
  expect(t.frame()).toContain("verdict ›"); // so Enter picks nothing
  await t.press("a");
  expect(t.frame()).toContain("Not decided yet (2)");
  expect(t.frame()).toContain("▲ src/a.rs:11 · blocking · Hard-coded answer in main");
  expect(t.frame()).toContain("▲ src/b.ts:2 · warn · Type changed to a string");
  await t.press("\x1b\x1b");
  await t.press("]fn\r"); // the first one not an issue, the second is open next
  await t.press("\x1b");
  await t.press("s");
  expect(t.frame()).toContain("a approve (Enter)"); // nothing blocking: Enter keeps the verdict chosen before
  await t.press("\x1b");
  await t.press("fb\r"); // reopen the second (the only one in this hunk), and block on it, with its title as the comment
  await t.press("h"); // the all-decided box is open: only hide acts, then s
  await t.press("s");
  expect(t.frame()).toContain("r request changes (Enter)");
  await t.press("\r");
  expect(t.r.doc.human.verdict).toBe("request_changes");
  expect(t.frame()).not.toContain("Not decided yet"); // all decided: the list is gone
  expect(t.frame()).toContain("Type changed to a string"); // the comment it wrote, in the write-up
});

test("submit flow: v adds the coverage line for a platform that posts; off again with v; Esc backs out of the question", async () => {
  const t = await open();
  t.r.doc.target.platform = "github";
  await t.press("sa");
  await t.press("\x1b");
  expect(t.frame()).toContain("verdict ›");
  await t.press("a");
  expect(t.frame()).toContain("v add coverage line");
  await t.press("v");
  expect(t.frame()).toContain("v drop coverage line");
  await t.press("\r");
  expect(t.outcomes).toEqual([{ kind: "submit", hook: false, coverage: true }]);
});

test("submit flow: with --dry-run the preview says nothing will be posted", async () => {
  const t = await open(undefined, { dryRun: true });
  await t.press("sa");
  expect(t.frame()).toContain("Enter prints the calls");
  expect(t.frame()).toContain("DRY RUN");
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
  expect(body).toContain("Hard-coded answer in main"); // the listing shows the title, not the claim
  expect(body).not.toContain("answer is hard-coded");
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

test("blind: before visiting, the gutter has no ▲, the rail shows ▲?, f and ]f are disabled and the decision keys do nothing", async () => {
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
  for (const k of ["b", "c", "u"]) {
    await t.press("jj" + k); // on the finding's line with no box open: the decision keys do nothing at all
    expect(t.frame()).not.toContain("›  comment");
    expect(t.frame()).not.toMatch(/decided|no finding here/);
    await t.press("gg");
  }
  expect(t.frame()).not.toContain("comment on the finding ›");
  expect(t.r.doc.human.decisions).toBeUndefined();
  expect(t.r.doc.human.comments).toEqual([]);
  expect(t.r.doc.human.revealed).toBeUndefined();
});

test("blind: F reveals early, lists the findings beside the reader's comments, and the reveal is recorded and written up", async () => {
  const t = await open({ comments: [{ hunk: h1!.id, side: "new", line: 11, text: "why 42?", at: "now" }], plan: { summary: "", by: "guide", mechanical: [], chapters: [{ title: "Both", intent: "Check it", why: "w", hunks: [h1!.id, h2!.id] }] } }, { blind: true });
  await t.press("F");
  const f = t.frame();
  expect(f).toContain("what the model found");
  expect(f).toContain("The model found 1:");
  expect(f).toContain("Hard-coded answer in main");
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

// ---------------------------------------------------------------- finding triage

const f2: Finding = { ...finding, id: "2", line: 12, severity: "warn", title: "Second line looks unused" };
const f3: Finding = { ...finding, id: "3", hunk: h2!.id, line: 2, severity: "nit", title: "Type changed to a string" };
const three = { findings: [finding, f2, f3] };

test("triage b: the comment line opens prefilled with the title, is edited, and saves at the finding's line as blocking; the pass moves on", async () => {
  const t = await open(three);
  await t.press("]f");
  expect(t.frame()).toContain("0/3 decided");
  await t.press("b");
  expect(t.frame()).toContain("block on it › Hard-coded answer in main");
  expect(t.frame()).toContain("ctrl-u clears");
  await t.press("\x15"); // ctrl-u: the prefill is rewritten whole
  await t.press("Where does 42 come from?\r");
  const [c] = t.r.doc.human.comments;
  expect(c).toMatchObject({ hunk: h1!.id, side: "new", line: 11, text: "Where does 42 come from?" });
  expect(t.r.doc.human.decisions).toEqual({ "1": { kind: "block", comment: c!.id } });
  expect(t.frame()).toMatch(/» Where does 42 come from\?/); // shown under its line like any comment
  // Straight to the next undecided finding, open, with the count.
  expect(t.r.pos).toEqual({ item: 0, line: 3 });
  expect(t.frame()).toContain("Second line looks unused");
  expect(t.frame()).toContain("1/3 decided");
});

test("triage c: Esc cancels the decision and saves nothing; Enter keeps the title as the comment", async () => {
  const t = await open(three);
  await t.press("]fc");
  expect(t.frame()).toContain("comment on the finding › Hard-coded answer in main");
  await t.press("\x1b");
  expect(t.r.doc.human.comments).toEqual([]);
  expect(t.r.doc.human.decisions).toBeUndefined();
  expect(t.frame()).toContain("0/3 decided"); // the finding is still open where it was
  await t.press("c\r");
  expect(t.r.doc.human.comments.map((c) => [c.line, c.text])).toEqual([[11, "Hard-coded answer in main"]]);
  expect(t.r.doc.human.decisions!["1"]!.kind).toBe("comment");
  // Emptying the line decides nothing.
  await t.press("c\x15\r");
  expect(t.r.doc.human.decisions!["2"]).toBeUndefined();
});

test("triage n: not an issue takes an optional reason, never a comment; each moves on", async () => {
  const t = await open(three);
  await t.press("]fn");
  expect(t.frame()).toContain("not an issue, why? ›");
  expect(t.frame()).toContain("never posted");
  await t.press("42 is the spec\r");
  expect(t.r.doc.human.decisions!["1"]).toEqual({ kind: "dismissed", reason: "42 is the spec" });
  expect(t.frame()).toContain("Second line looks unused");
  await t.press("n\r"); // no reason: still decided
  expect(t.r.doc.human.decisions!["2"]).toEqual({ kind: "dismissed" });
  expect(t.frame()).toContain("Type changed to a string");
  expect(t.r.pos.item).toBe(1); // across hunks
  await t.press("n\r");
  expect(t.r.doc.human.decisions!["3"]).toEqual({ kind: "dismissed" });
  expect(t.r.doc.human.comments).toEqual([]);
  expect(t.frame()).toContain("3/3 decided");
  expect(t.frame()).toContain("Every finding is decided");
  expect(t.frame()).toContain("0 ▲"); // the header counts what is left to decide
});

test("triage u: undo takes the decision back with the comment it wrote, and the finding is open again", async () => {
  const t = await open(three);
  await t.press("]fb\r");
  expect(t.r.doc.human.comments).toHaveLength(1);
  await t.press("[f"); // back to the first
  expect(t.frame()).toContain("Decided: blocking. Your comment: Hard-coded answer in main");
  await t.press("u");
  expect(t.r.doc.human.comments).toEqual([]);
  expect(t.r.doc.human.decisions).toEqual({});
  expect(t.frame()).toContain("0/3 decided");
  expect(t.frame()).not.toContain("Decided:");
  await t.press("u");
  expect(t.frame()).toContain("nothing decided on this finding");
});

test("triage: a whole pass is ]f and one key per finding; the decisions are in the saved review", async () => {
  const t = await open(three);
  await t.press("]fb\r");
  await t.press("c\r");
  await t.press("n\r");
  expect(t.r.doc.human.decisions).toMatchObject({ "1": { kind: "block" }, "2": { kind: "comment" }, "3": { kind: "dismissed" } });
  // What a reopen reads: the review as saved, through the document parser.
  const saved = JSON.parse(readFileSync(join(tmp, "t.json"), "utf8")).doc;
  const again = { doc: parseDocument({ ...saved, target: { ...saved.target, base: "a".repeat(40), head: "b".repeat(40) } }) }; // the fixture's commits are stand-ins
  expect(again.doc.human.decisions).toEqual(t.r.doc.human.decisions);
  expect(again.doc.human.comments.map((c) => c.text)).toEqual(["Hard-coded answer in main", "Second line looks unused"]);
});

test("triage with nothing to act on: off a finding the keys say so; in blind, a revealed chapter's findings are the only ones counted", async () => {
  const t = await open(three);
  await t.press("u");
  expect(t.r.doc.human.decisions).toBeUndefined();
  await t.press("jjc\r"); // on a finding's line with no box open, b/c/u are not keys: no decision, no comment line
  expect(t.frame()).not.toContain("comment on the finding ›");
  expect(t.r.doc.human.decisions).toBeUndefined();
  expect(t.r.doc.human.comments).toEqual([]);

  const b = await open(three, { blind: true });
  await b.press("]f"); // chapter 1 is read on open (one hunk); chapter 2 is not
  expect(b.frame()).toContain("0/2 decided");
  await b.press("c\rc\r");
  expect(b.frame()).toContain("Every finding you can see is decided");
  expect(b.r.doc.human.decisions!["3"]).toBeUndefined();
});

// ---------------------------------------------------------------- clipboard

import { askText, confirmation, copyText, findingText, osc52, routes, whyText } from "../src/clipboard.ts";

test("clipboard text: a finding is path:line — title, then the detail; one with no title leads with the claim's first sentence", () => {
  const bare = { ...finding, title: undefined };
  expect(findingText(bare, "src/a.rs:11")).toBe("src/a.rs:11 — Answer is hard-coded\n\n42 appears with no source"); // the short claim is the title: not said twice
  expect(findingText({ ...bare, refute: "still true" }, "src/a.rs:11")).toBe("src/a.rs:11 — Answer is hard-coded\n\n42 appears with no source\n\nSecond look: still true");
  expect(findingText(finding, "src/a.rs:11")).toBe("src/a.rs:11 — Hard-coded answer in main\n\nanswer is hard-coded\n\n42 appears with no source");
  expect(whyText("Core change", "Check the answer is derived", "It is the heart of it.")).toBe("Core change\n\nCheck the answer is derived\n\nIt is the heart of it.");
  expect(whyText("Mechanical", undefined, "why")).toBe("Mechanical\n\nwhy");
  expect(askText("why 42?", "Because.")).toBe("why 42?\n\nBecause.");
});

test("clipboard routes: pbcopy on macOS, wl-copy/xclip on Linux by display, OSC 52 last, and alone over ssh or when forced", () => {
  expect(routes("darwin", {})).toEqual([{ kind: "cmd", argv: ["pbcopy"] }, { kind: "osc52" }]);
  expect(routes("linux", { WAYLAND_DISPLAY: "w", DISPLAY: ":0" })).toEqual([{ kind: "cmd", argv: ["wl-copy"] }, { kind: "cmd", argv: ["xclip", "-selection", "clipboard"] }, { kind: "osc52" }]);
  expect(routes("linux", { DISPLAY: ":0" })).toEqual([{ kind: "cmd", argv: ["xclip", "-selection", "clipboard"] }, { kind: "osc52" }]);
  expect(routes("linux", {})).toEqual([{ kind: "osc52" }]);
  expect(routes("freebsd", {})).toEqual([{ kind: "osc52" }]);
  expect(routes("darwin", { SSH_CONNECTION: "1 2 3 4" })).toEqual([{ kind: "osc52" }]);
  expect(routes("darwin", { PRVIEW_CLIPBOARD: "osc52" })).toEqual([{ kind: "osc52" }]);
});

test("clipboard: the first route that works wins, a failing tool falls through, OSC 52 is base64 and tmux-wrapped", () => {
  const ran: string[][] = [], wrote: string[] = [];
  const base = { platform: "linux", write: (s: string) => { wrote.push(s); } };
  const env = { WAYLAND_DISPLAY: "w", DISPLAY: ":0" };
  const r = copyText("héllo\nworld", { ...base, env, run: (argv, input) => { ran.push([...argv, input]); return argv[0] === "xclip"; } });
  expect(r).toEqual({ ok: true, chars: 11, via: "xclip" });
  expect(ran.map((a) => a[0])).toEqual(["wl-copy", "xclip"]);
  expect(wrote).toEqual([]);
  expect(copyText("x", { ...base, env, run: () => { throw new Error("spawn"); } })).toEqual({ ok: true, chars: 1, via: "osc52" });
  expect(wrote[0]).toBe(`\x1b]52;c;${Buffer.from("x").toString("base64")}\x07`);
  expect(osc52("x", { TMUX: "/tmp/tmux" })).toBe(`\x1bPtmux;\x1b\x1b]52;c;eA==\x07\x1b\\`);
  expect(copyText("x", { platform: "linux", env: {}, run: () => true, write: () => { throw new Error("closed"); } })).toEqual({ ok: false, message: "no clipboard route worked (tried osc52)" });
  expect(copyText("", { ...base, env, run: () => true })).toEqual({ ok: false, message: "nothing to copy" });
  expect(confirmation({ ok: true, chars: 214, via: "pbcopy" })).toBe("copied 214 chars");
});

async function copying(over?: Over) {
  const copied: string[] = [];
  const copier = (t: string) => { copied.push(t); return { ok: true as const, chars: t.length, via: "pbcopy" }; };
  const r = fixture(over);
  const app = render(<App review={r} files={files} onDone={() => {}} copier={copier} size={{ cols: 120, rows: 40 }} />);
  await settle();
  const press = async (keys: string) => { for (const k of keys.match(/./gsu) ?? []) { app.stdin.write(k); await settle(); } };
  return { copied, press, frame: () => (app.lastFrame() ?? "").replace(/\x1b\[[0-9;]*m/g, "") };
}

test("y: with a finding open copies its source text and the footer says how much; with a ? box open, the why; with none, path:line", async () => {
  const t = await copying();
  await t.press("y");
  expect(t.copied).toEqual(["src/a.rs:10"]); // no float yet: the cursor line
  expect(t.frame()).toContain("copied 11 chars");
  await t.press("j");
  expect(t.frame()).not.toContain("copied 11 chars");
  await t.press("f");
  await t.press("y");
  expect(t.copied[1]).toBe("src/a.rs:11 — Hard-coded answer in main\n\nanswer is hard-coded\n\n42 appears with no source");
  expect(t.copied[1]).not.toMatch(/[│─╭╮╰╯]/);
  await t.press("\x1b?"); // with a finding box open only its own keys act: close it first
  await t.press("y");
  expect(t.copied[2]).toBe("Core change\n\nCheck the answer is derived\n\nIt is the heart of it.");
  expect(t.frame()).toContain(`copied ${t.copied[2]!.length} chars`);
});

test("y: a box with no source text says so instead of copying the hints", async () => {
  const t = await copying({ findings: [] });
  await t.press("f");
  expect(t.frame()).toContain("h hide  ]f finding"); // a hint has no source text, so the footer does not offer y
  await t.press("y");
  expect(t.copied).toEqual([]);
  expect(t.frame()).not.toContain("copied");
});

// -- resize ------------------------------------------------------------------------------------------------

import { tooSmall, WIPE } from "../src/resize.ts";

// ink-testing-library's stdout has fixed read-only columns; shadow them, then signal the change as a TTY would.
function resizeTo(out: { emit: (e: string) => boolean }, columns: number, rows: number) {
  Object.defineProperty(out, "columns", { value: columns, configurable: true });
  Object.defineProperty(out, "rows", { value: rows, configurable: true });
  out.emit("resize");
}

test("resize: a terminal that changes size recomputes the layout, and wipes the stale frame first", async () => {
  const r = fixture();
  const app = render(<App review={r} files={files} onDone={() => {}} />);
  const out = app.stdout as unknown as { columns: number; rows: number; emit: (e: string) => boolean };
  const strip = () => (app.lastFrame() ?? "").replace(/\x1b\[[0-9;]*m/g, "");
  resizeTo(out, 140, 40);
  await new Promise((r) => setTimeout(r, 120));
  expect(strip()).toContain("▸ 1 Core change");
  resizeTo(out, 80, 24);
  await new Promise((r) => setTimeout(r, 120));
  const f = strip();
  expect(f).not.toContain("▸ 1 Core change"); // the rail collapsed to numbers
  expect(f.split("\n").every((l) => l.length <= 80)).toBe(true);
  expect(app.frames.includes(WIPE)).toBe(true);
});

test("resize: a terminal below 40x10 shows a one-line notice, and the review comes back when it grows", async () => {
  const r = fixture();
  const app = render(<App review={r} files={files} onDone={() => {}} />);
  const out = app.stdout as unknown as { columns: number; rows: number; emit: (e: string) => boolean };
  const strip = () => (app.lastFrame() ?? "").replace(/\x1b\[[0-9;]*m/g, "");
  resizeTo(out, 30, 8);
  await new Promise((r) => setTimeout(r, 120));
  expect(strip()).toContain("terminal too small");
  expect(strip().split("\n").length).toBe(1);
  resizeTo(out, 120, 40);
  await new Promise((r) => setTimeout(r, 120));
  expect(strip()).toContain("Core change");
  expect(strip()).not.toContain("too small");
});

test("tooSmall: the limits are 40 columns and 10 rows", () => {
  expect(tooSmall({ cols: 39, rows: 40 })).toBe(true);
  expect(tooSmall({ cols: 120, rows: 9 })).toBe(true);
  expect(tooSmall({ cols: 40, rows: 10 })).toBe(false);
});

// ---------------------------------------------------------------- finding keys: the footer is the truth

test("finding box open: the footer lists exactly the keys the handler accepts, drawn from one table", async () => {
  const t = await open(three);
  await t.press("]f");
  expect(findingFooter()).toBe("n not an issue  b block  c comment  u undo  h hide  ]f next  y copy");
  expect(t.frame()).toContain(findingFooter());
  expect(t.frame()).not.toContain("Esc close");
  const box = () => t.frame().split("\n").filter((l) => l.includes("│ ")).length; // just to see the box did not change
  // Every letter the table does not list does nothing: same screen, nothing decided, no mode entered.
  const before = t.frame();
  const listed = new Set(FINDING_KEYS.map((k) => k.key[0]));
  for (const ch of "adefgijklmopqrstvwxzABCDEFGHIJKLMNOPQRSTUVWXYZ?".split("")) {
    if (listed.has(ch)) continue;
    await t.press(ch);
    expect(t.frame()).toBe(before);
  }
  expect(box()).toBeGreaterThan(0);
  expect(t.r.doc.human.decisions).toBeUndefined();
  expect(t.r.doc.human.comments).toEqual([]);
  // And every listed key acts.
  await t.press("n");
  expect(t.frame()).toContain("not an issue, why? ›");
  await t.press("\x1b");
  await t.press("b");
  expect(t.frame()).toContain("block on it ›");
  await t.press("\x1b");
  await t.press("c");
  expect(t.frame()).toContain("comment on the finding ›");
  await t.press("\x1b");
  await t.press("u");
  expect(t.frame()).toContain("nothing decided on this finding");
  await t.press("]f"); // y copies: covered by its own test, which stubs the clipboard
  expect(t.frame()).toContain("Second line looks unused");
  await t.press("h");
  expect(t.frame()).not.toContain("Second line looks unused");
  expect(t.frame()).not.toContain(findingFooter());
});

test("finding box: h hides without deciding; n records not an issue with its reason, shown on reopen; d and i do nothing", async () => {
  const t = await open(three);
  await t.press("]fh");
  expect(t.r.doc.human.decisions).toBeUndefined();
  expect(t.frame()).not.toContain("decided");
  expect(t.r.pos.item).toBe(0); // h closed the box; it did not go to the previous hunk
  await t.press("]fdi"); // the second finding
  expect(t.r.doc.human.decisions).toBeUndefined();
  expect(t.frame()).toContain("0/3 decided");
  await t.press("[f");
  await t.press("n42 is the spec\r");
  expect(t.r.doc.human.decisions).toEqual({ "1": { kind: "dismissed", reason: "42 is the spec" } });
  await t.press("[f");
  expect(t.frame()).toContain("Decided: not an issue (42 is the spec)");
});

test("no box open: h goes to the previous hunk and n opens a line comment", async () => {
  const t = await open(three);
  await t.press("l");
  expect(t.r.pos.item).toBe(1);
  await t.press("h");
  expect(t.r.pos.item).toBe(0);
  await t.press("n");
  expect(t.frame()).toContain("comment ›");
  await t.press("\x1b");
  await t.press("d");
  await t.press("i");
  expect(t.r.doc.human.decisions).toBeUndefined();
});

// ---------------------------------------------------------------- every box and the nav footer: the footer is the truth

const SUMMARY = "Replaces the hard-coded answer with one derived from the input.";
const withSummary = (plan: Partial<Doc["plan"]> = {}) => ({ plan: { summary: SUMMARY, by: "guide", mechanical: [], chapters: [{ title: "Core change", intent: "Check the answer is derived", why: "It is the heart of it.", hunks: [h1!.id] }, { title: "The ts side", intent: "Check the type", why: "Second.", hunks: [h2!.id] }], ...plan } });
const models = { guide: "g", critic: "c", refute: "r", ask: "a" };

test("opening summary: a double-ruled box titled as the summary, above the code and not under the cursor's ▲; no key list; footer is the info table; h closes it and h/l then move hunks", async () => {
  const t = await open(withSummary());
  const f = t.frame();
  expect(f).toContain("Summary of this change · not a finding");
  expect(f).toContain(SUMMARY);
  expect(f).toContain("╔"); // findings are round boxes (╭), so the two cannot be mistaken
  expect(f).not.toContain("╭");
  expect(f.indexOf("Summary of this change")).toBeLessThan(f.indexOf("keep")); // above the first code line, not hugging the ▲ line
  expect(f).not.toMatch(/not an issue|b block|u undo|Prepared by/); // no key list, no provenance without runs
  expect(f).toContain(infoFooter(true, false));
  expect(infoFooter(true, false)).toBe("h hide  y copy  ]f finding");
  await t.press("h");
  expect(t.frame()).not.toContain("Summary of this change");
  expect(t.r.pos.item).toBe(0); // h closed the box, it did not move a hunk
  await t.press("l");
  expect(t.r.pos.item).toBe(1);
  await t.press("h");
  expect(t.r.pos.item).toBe(0);
  expect(t.frame()).toContain(navFooter(120, false));
});

test("opening summary: a finding box keeps its own look, and the summary names who prepared it only when every run has a model id", async () => {
  const t = await open(withSummary(), { ai: { models, at: "now", errors: [], runs: [{ role: "guide", model: "claude-opus-5-5", ms: 1 }, { role: "critic", model: "claude-opus-5-5", ms: 1 }] } });
  expect(t.frame()).toContain("Prepared by claude-opus-5-5 (guide, critic)");
  await t.press("h]f");
  expect(t.frame()).toContain("╭");
  expect(t.frame()).not.toContain("╔");
  const old = await open(withSummary(), { ai: { models, at: "now", errors: [], runs: [{ role: "guide", ms: 1 }, { role: "critic", ms: 1 }] } });
  expect(old.frame()).toContain(SUMMARY);
  expect(old.frame()).not.toContain("Prepared by");
  expect(old.frame()).not.toContain("unknown");
});

test("info boxes (summary, ? why, F reveal, notices): footer from INFO_KEYS, only those keys act, h hides any of them", async () => {
  const boxes: [string, (t: Awaited<ReturnType<typeof open>>) => Promise<void>, boolean][] = [
    ["summary", async () => {}, true],
    ["? why", async (t) => { await t.press("h?"); }, true],
    ["F reveal", async (t) => { await t.press("hF"); }, true],
    ["f notice", async (t) => { await t.press("hf"); }, false],
  ];
  for (const [name, into, copyable] of boxes) {
    const t = await open({ ...withSummary(), findings: name === "f notice" ? [] : undefined }, { blind: name === "F reveal" });
    await into(t);
    const footer = infoFooter(copyable, false);
    expect(t.frame(), name).toContain(footer);
    expect(footer, name).toBe(copyable ? "h hide  y copy  ]f finding" : "h hide  ]f finding");
    const before = t.frame();
    const listed = new Set(["h", "]", "[", ...(copyable ? ["y"] : [])]);
    for (const ch of "abcdefgijklmnopqrstuvwxzABCDEGHIJKLMNOPQRSTUVWXYZ?".split("")) {
      if (listed.has(ch)) continue;
      await t.press(ch);
      expect(t.frame(), `${name}: ${ch}`).toBe(before);
    }
    expect(t.r.pos.item, name).toBe(0);
    expect(t.r.doc.human.comments, name).toEqual([]);
    await t.press("h");
    expect(t.frame(), name).not.toContain(footer);
  }
  // ]f acts from an info box: it opens a finding with the finding footer.
  const t = await open(withSummary());
  await t.press("]f");
  expect(t.frame()).toContain(findingFooter());
  // ]c is not listed, so it does nothing while a box is open, and works once it is closed.
  await t.press("h?]c");
  expect(t.r.pos.item).toBe(0);
  await t.press("h]c");
  expect(t.r.pos.item).toBe(1);
}, 30000);

test("info box that scrolls lists paging in the footer", async () => {
  const long = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
  const t = await open(withSummary({ summary: long }));
  expect(t.frame()).toContain("h hide  y copy  ]f finding  PgUp/PgDn page");
});

test("nav: the footer comes from NAV_KEYS, every listed key acts, b/c/u are not in it and do nothing; F only with --blind", async () => {
  const wide = await open(undefined, { cols: 140, blind: false });
  expect(wide.frame()).toContain(navFooter(140, false));
  expect(navFooter(140, false)).toBe("j/k line  h/l hunk  J/K chapter  ]f/f find  ? why  y copy  a ask  e edit  n/N note  w wrap  H/L pan  s submit  q quit");
  expect(navFooter(140, false)).not.toMatch(/decide|F reveal/);
  expect(navFooter(140, true)).toContain("F reveal");
  expect(NAV_KEYS.some((k) => /[bcu]/.test(k.key.replace("]f", "")) && k.key !== "q")).toBe(false);
  // Every listed key does something, from a state where it can.
  const prelude: Record<string, string> = { H: "L", k: "j", h: "l", K: "J" };
  const keys = NAV_KEYS.filter((k) => !k.blind).flatMap((k) => k.key.split("/"));
  for (const ch of keys) {
    const t = await open(undefined, { cols: 140, beside: () => undefined });
    await t.press(ch === "K" ? "J" : prelude[ch] ?? "");
    const before = `${t.frame()}|${t.r.pos.item}:${t.r.pos.line}|${t.outcomes.length}`;
    await t.press(ch);
    const after = `${t.frame()}|${t.r.pos.item}:${t.r.pos.line}|${t.outcomes.length}`;
    if (ch === "e") continue; // beside pane stub: nothing to see on screen; covered by the editor test
    expect(after, `key ${ch}`).not.toBe(before);
  }
  // Letters the table does not list do nothing without a box.
  const t = await open(undefined, { cols: 140 });
  const before = t.frame();
  for (const ch of "bcdgimoprtuvxzACDEGIMOPQRSTUVWXYZ".split("")) {
    if (ch === "g" || ch === "G") continue;
    await t.press(ch);
    expect(t.frame(), `key ${ch}`).toBe(before);
  }
  expect(t.r.doc.human.decisions).toBeUndefined();
  await t.press("F");
  expect(t.frame()).toBe(before); // not blind: F is not in the footer and does nothing
  const b = await open(undefined, { cols: 200, blind: true });
  expect(b.frame()).toContain(navFooter(200, true));
  await b.press("F");
  expect(b.frame()).toContain("what the model found");
});
