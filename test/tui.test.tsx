import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { cleanup, render } from "ink-testing-library";
import { parseDiff } from "../src/diff.ts";
import { criticPrompt, hunksOf, type Finding } from "../src/guide.ts";
import { visible } from "../src/sanitize.ts";
import type { Review } from "../src/build.ts";
import type { Doc } from "../src/document.ts";
import { chapterHidden, earlyTitles, hiddenHunks } from "../src/blind.ts";
import { writeup } from "../src/build.ts";
import { entriesOf, panelCap, panelOf } from "../src/panel.ts";
import { DEFAULT_KEYMAP, effectiveKeys, installKeymap, keyOf, type KeyState } from "../src/keys.ts";
import { parseDocument, SCHEMA } from "../src/document.ts";
import { parseConfig } from "../src/config.ts";
import { App, type Outcome } from "../src/tui.tsx";
import { highlightLines, langOf, sliceSpans, styleOf } from "../src/highlight.ts";
import { clampScroll, floatHeight, layoutOf, pageStep, windowOf, wrapText } from "../src/layout.ts";
import { editorArgs, tmuxSplit, besideIn } from "../src/editor.ts";
import { nextBySeverity, nextFindingWrapping, fileEdge, chapterStart } from "../src/nav.ts";

// The screens, driven with keys the way a reader would. App writes the review to $PRVIEW_HOME as it
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

// The keys as a terminal sends them.
const DOWN = "\x1b[B", UP = "\x1b[A", RIGHT = "\x1b[C", LEFT = "\x1b[D", SDOWN = "\x1b[1;2B", SUP = "\x1b[1;2A", TAB = "\t", ESC = "\x1b", PGDN = "\x1b[6~", PGUP = "\x1b[5~";
const KEY = /\x1b\[[0-9;]*[A-Za-z~]|./gsu;

// The key panel draws each entry as its keys, then its label; a second column is three spaces from the first.
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const row = (keys: string, label: string) => new RegExp(`(?:│ |   )${esc(keys)} +${esc(label)}(?: |\\s*│)`);
const listing = (e: { keys: string; label: string }[]) => e.map((x) => `${x.keys} ${x.label}`);
const settle = () => new Promise((r) => setTimeout(r, 30));
async function open(over?: Over, props: { ai?: Review["ai"]; suggested?: Review["suggested"]; blind?: boolean; dryRun?: boolean; cols?: number; rows?: number; beside?: (p: string, l: number) => string | undefined } = {}) {
  const outcomes: Outcome[] = [];
  const r = fixture(over);
  r.ai = props.ai;
  if (props.suggested) r.suggested = props.suggested;
  const app = render(<App review={r} files={files} onDone={(o) => outcomes.push(o)} beside={props.beside} blind={props.blind} dryRun={props.dryRun} size={{ cols: props.cols ?? 120, rows: props.rows ?? 40 }} />);
  await settle();
  // One key at a time: a handler closes over the state of its render, so two keys in one chunk would both see the old cursor.
  const press = async (keys: string) => { for (const k of keys.match(KEY) ?? []) { app.stdin.write(k); await settle(); } };
  return { r, app, press, outcomes, frame: () => (app.lastFrame() ?? "").replace(/\x1b\[[0-9;]*m/g, "") };
}
const shown = (t: { frame: () => string }, s: KeyState) => { for (const e of entriesOf(s)) expect(t.frame(), `${e.keys} ${e.label}`).toMatch(row(e.keys, e.label)); };
const notShown = (t: { frame: () => string }, s: KeyState) => expect(entriesOf(s).filter((e) => !/copy|submit|quit|…$/.test(e.label)).some((e) => row(e.keys, e.label).test(t.frame()))).toBe(false);

test("rail: the current chapter is marked with its hunks, a read chapter is ticked, findings are counted", async () => {
  const t = await open();
  expect(t.frame()).toContain("▸ 1 Core change ▲1");
  expect(t.frame()).toContain("› a.rs:10");
  expect(t.frame()).toContain("2 The ts side");
  await t.press("J");
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
});

test("cursor: ↓/↑ and j/k move a line and run on across blocks; ⇧↓/⇧↑ and J/K move a chapter; g g and g e the file's edges", async () => {
  const t = await open(undefined, { cols: 100 });
  expect(t.r.pos.line).toBe(0);
  await t.press("jj");
  expect(t.r.pos.line).toBe(2);
  await t.press(DOWN);
  expect(t.r.pos.line).toBe(3);
  await t.press(UP + "k");
  expect(t.r.pos.line).toBe(1);
  await t.press("ge");
  expect(t.r.pos).toEqual({ item: 0, line: 4 });
  await t.press("j"); // the end of the block: on into the next one
  expect(t.r.pos).toEqual({ item: 1, line: 0 });
  await t.press("k"); // and back to the last line of the one before
  expect(t.r.pos).toEqual({ item: 0, line: 4 });
  await t.press("gg");
  expect(t.r.pos.line).toBe(0);
  await t.press("k"); // the very first line: nowhere to go
  expect(t.r.pos).toEqual({ item: 0, line: 0 });
  await t.press(SDOWN);
  expect(t.r.pos.item).toBe(1);
  await t.press(SUP);
  expect(t.r.pos.item).toBe(0);
  await t.press("JK");
  expect(t.r.pos.item).toBe(0);
  expect(t.frame()).toMatch(/10\s+ keep/);
  expect(t.frame()).toMatch(/11\s+▲\s*\+let answer/);
});

test("g <digits> Enter goes to that line of the file, g c <digits> Enter to a chapter; the footer shows the chord as it is typed", async () => {
  const t = await open();
  await t.press("g1");
  expect(t.frame()).toMatch(/ g 1\s*$/m);
  expect(t.frame()).toMatch(row("Enter", "go")); // the panel says how to finish
  await t.press("2\r");
  expect(t.r.pos).toEqual({ item: 0, line: 3 }); // new-side line 12 is the fourth row
  await t.press("gc2\r");
  expect(t.r.pos).toEqual({ item: 1, line: 0 });
  await t.press("gc9\r");
  expect(t.frame()).toContain("there is no chapter 9");
  await t.press("g7" + ESC); // Esc cancels a half-typed number
  expect(t.r.pos).toEqual({ item: 1, line: 0 });
  expect(t.frame()).not.toMatch(/ g 7\s*$/m);
});

test("a prefix shows its second keys in the panel; Esc cancels it, an unknown second key does nothing", async () => {
  const t = await open();
  await t.press("g");
  for (const e of entriesOf({ state: "code" }, { prefix: "g" })) expect(t.frame()).toMatch(row(e.keys, e.label));
  expect(t.frame()).toContain("g go to");
  await t.press(ESC);
  expect(t.frame()).not.toContain("g go to");
  expect(t.r.pos).toEqual({ item: 0, line: 0 });
  await t.press("gz"); // not a g key: cancelled, nothing moved
  expect(t.r.pos).toEqual({ item: 0, line: 0 });
  await t.press("j");
  expect(t.r.pos.line).toBe(1); // and the next key is an ordinary key again
});

test("finding: → on its line opens it with progress, the panel lists the finding's keys, x closes it", async () => {
  const t = await open();
  await t.press(RIGHT);
  expect(t.frame()).toContain("no finding on this line");
  await t.press("jj" + RIGHT);
  expect(t.frame()).toContain("critic · bug · blocking");
  const fr = t.frame();
  expect(fr.indexOf("Hard-coded answer in main")).toBeGreaterThan(fr.indexOf("critic · bug · blocking"));
  expect(fr.indexOf("answer is hard-coded")).toBeGreaterThan(fr.indexOf("Hard-coded answer in main"));
  expect(fr).toContain("0/1 decided");
  shown(t, { state: "finding" });
  expect(listing(entriesOf({ state: "finding" }))).toEqual(["x close", "← h back", "b block", "c comment", "i ignore", "y copy", "PgDn/PgUp ctrl-d/ctrl-u page", "a AI…", "v view…", "g go to…"]);
  await t.press("x");
  expect(t.frame()).not.toContain("answer is hard-coded");
  await t.press("l"); // l is → too
  expect(t.frame()).toContain("answer is hard-coded");
  await t.press(LEFT); // ← closes it
  expect(t.frame()).not.toContain("answer is hard-coded");
  await t.press("l" + ESC); // and so does Esc
  expect(t.frame()).not.toContain("answer is hard-coded");
  expect(t.r.pos).toEqual({ item: 0, line: 2 });
});

test("finding: g f opens the next finding anywhere and wraps; a long body pages with PgDn and never scrolls past its end", async () => {
  const evidence = Array.from({ length: 40 }, (_, i) => `line-${i}`).join("\n");
  const t = await open({ findings: [{ ...finding, evidence }] }, { rows: 24 });
  await t.press("gf");
  expect(t.r.pos.line).toBe(2);
  expect(t.frame()).toContain("line-0");
  expect(t.frame()).not.toContain("line-39");
  await t.press(PGDN);
  expect(t.frame()).not.toContain("line-0\n");
  for (let i = 0; i < 12; i++) await t.press(PGDN);
  expect(t.frame()).toContain("line-39"); // the last page shows the end, not blank space
  await t.press(PGUP);
  expect(t.frame()).toContain("line-");
  expect(t.frame()).toContain("+let answer");
  await t.press("x" + SDOWN + "gf"); // from the next chapter, g f wraps round to the only finding
  expect(t.r.pos).toEqual({ item: 0, line: 2 });
  expect(t.frame()).toContain("Hard-coded answer in main");
});

test("g h / g H: by severity, every blocking finding first, then the warnings, then the nits, wrapping", async () => {
  const warn: Finding = { ...finding, id: "w", line: 12, severity: "warn", title: "A warning" };
  const nit: Finding = { ...finding, id: "n", hunk: h2!.id, line: 2, severity: "nit", title: "A nit" };
  const block2: Finding = { ...finding, id: "b2", hunk: h2!.id, line: 1, title: "Another blocker" };
  const t = await open({ findings: [nit, warn, finding, block2] });
  const title = async (k: string) => { await t.press(k); return ["Hard-coded answer in main", "Another blocker", "A warning", "A nit"].find((x) => t.frame().includes(x)); };
  expect(await title("gh")).toBe("Hard-coded answer in main");
  expect(await title("gh")).toBe("Another blocker");
  expect(await title("gh")).toBe("A warning");
  expect(await title("gh")).toBe("A nit");
  expect(await title("gh")).toBe("Hard-coded answer in main");
  expect(await title("gH")).toBe("A nit");
});

test("Enter on a line writes your own finding there, shown under the line with a mark in the gutter", async () => {
  const t = await open();
  await t.press("jj\r");
  expect(t.frame()).toContain("new finding ›");
  shown(t, { state: "prompt", kind: "comment" });
  await t.press("why 42?");
  await t.press("\r");
  expect(t.r.doc.human.comments.map((n) => [n.hunk, n.side, n.line, n.text])).toEqual([[h1!.id, "new", 11, "why 42?"]]);
  expect(t.frame()).toMatch(/» why 42\?/);
  expect(t.frame()).toContain("1 comment");
});

test("submit flow: s asks for a verdict, previews the write-up, Esc goes back, Enter submits", async () => {
  const t = await open({ comments: [{ hunk: h1!.id, side: "new", line: 11, text: "why 42?", at: "now" }] });
  await t.press("s");
  expect(t.frame()).toContain("verdict ›");
  shown(t, { state: "submit", step: "verdict" });
  await t.press("r");
  expect(t.r.doc.human.verdict).toBe("request_changes");
  expect(t.frame()).toContain("Request changes");
  expect(t.frame()).toContain("why 42?");
  await t.press(ESC);
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
  await t.press(PGDN + PGDN + PGDN); // page down to the end of the preview
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
  await t.press(ESC);
  await t.press("a\r");
  expect(t.outcomes).toEqual([{ kind: "submit", hook: false, coverage: false }]);
});

test("submit flow: the preview leads with the undecided findings; with one blocking, Enter picks request changes", async () => {
  const second: Finding = { ...finding, id: "2", hunk: h2!.id, line: 2, severity: "warn", title: "Type changed to a string" };
  const t = await open({ findings: [finding, second] });
  await t.press("s");
  expect(t.frame()).not.toContain("Enter takes"); // nothing blocking and no verdict yet: no default
  await t.press("\r");
  expect(t.frame()).toContain("verdict ›"); // so Enter picks nothing
  await t.press("a");
  expect(t.frame()).toContain("Not decided yet (2)");
  expect(t.frame()).toContain("▲ src/a.rs:11 · blocking · Hard-coded answer in main");
  expect(t.frame()).toContain("▲ src/b.ts:2 · warn · Type changed to a string");
  await t.press(ESC + ESC);
  await t.press("gfi\r"); // the first ignored, the second is open next
  await t.press(ESC);
  await t.press("s");
  expect(t.frame()).toContain("Enter takes Approve"); // nothing blocking: Enter keeps the verdict chosen before
  await t.press(ESC);
  await t.press(RIGHT + "b\r"); // open the second (on the cursor line), and block on it, with its title as the comment
  await t.press(ESC); // the all-decided box
  await t.press("s");
  expect(t.frame()).toContain("Enter takes Request changes");
  await t.press("\r");
  expect(t.r.doc.human.verdict).toBe("request_changes");
  expect(t.frame()).not.toContain("Not decided yet"); // all decided: the list is gone
  expect(t.frame()).toContain("Type changed to a string"); // the comment it wrote, in the write-up
});

test("submit flow: v adds the coverage line for a platform that posts; off again with v; Esc backs out of the question", async () => {
  const t = await open();
  t.r.doc.target.platform = "github";
  await t.press("sa");
  await t.press(ESC);
  expect(t.frame()).toContain("verdict ›");
  await t.press("a");
  expect(t.frame()).toMatch(row("v", "add coverage line"));
  await t.press("v");
  expect(t.frame()).toMatch(row("v", "drop coverage line"));
  await t.press("\r");
  expect(t.outcomes).toEqual([{ kind: "submit", hook: false, coverage: true }]);
});

test("submit flow: with --dry-run the preview says nothing will be posted", async () => {
  const t = await open(undefined, { dryRun: true });
  await t.press("sa");
  expect(t.frame()).toContain("Enter prints the calls");
  expect(t.frame()).toContain("DRY RUN");
});

test("long lines: cut with an ellipsis, v w wraps onto more rows and back", async () => {
  const t = await open(undefined, { cols: 100 });
  await t.press("jj");
  expect(t.frame()).toContain("…");
  expect(t.frame()).not.toContain("end");
  await t.press("vw");
  expect(t.frame()).toContain("wrapped");
  expect(t.frame()).toContain("↪");
  expect(t.frame()).toContain("end");
  await t.press("vw");
  expect(t.frame()).not.toContain("wrapped");
});

test("editor: without tmux `v e` hands the file and line back; with a side pane it opens there and the screen stays", async () => {
  const plain = await open();
  await plain.press("jjve");
  expect(plain.outcomes).toEqual([{ kind: "edit", path: "src/a.rs", line: 11 }]);

  const opened: [string, number][] = [];
  const t = await open(undefined, { beside: (p, l) => { opened.push([p, l]); return undefined; } });
  await t.press("jve");
  expect(opened).toEqual([["src/a.rs", 11]]); // the cursor is on a removed line: the next new line is the anchor
  expect(t.outcomes).toEqual([]);
  expect(t.frame()).toContain("Core change");

  const bad = await open(undefined, { beside: () => "tmux could not open a pane: no space" });
  await bad.press("ve");
  expect(bad.frame()).toContain("no space");
});

test("a hunk taller than the screen scrolls its window and keeps each line's own colour", async () => {
  const body = Array.from({ length: 60 }, (_, i) => (i === 50 ? "+const marker = 1;" : `+// filler ${i}`)).join("\n");
  const tall = parseDiff(`diff --git a/t.ts b/t.ts\n--- a/t.ts\n+++ b/t.ts\n@@ -0,0 +1,60 @@\n${body}\n`);
  const [hk] = hunksOf(tall);
  const r = fixture({ findings: [], plan: { summary: "", by: "files", mechanical: [], chapters: [{ title: "T", intent: "", why: "", hunks: [hk!.id] }] } });
  const app = render(<App review={r} files={tall} onDone={() => {}} size={{ cols: 100, rows: 20 }} />);
  await settle();
  for (const k of ["g", "5", "1", "\r"]) { app.stdin.write(k); await settle(); }
  const raw = app.lastFrame() ?? "";
  const row = raw.split("\n").find((l) => l.includes("marker"))!;
  expect(row).toBeDefined();
  // The keyword is bold inside the green line: colour alignment follows the line, not its position in the window.
  expect(row).toMatch(/\x1b\[1mconst\x1b\[22m/);
  expect(raw.split("\n").filter((l) => l.includes("filler")).every((l) => !/\x1b\[1m/.test(l))).toBe(true);
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


// ---------------------------------------------------------------- blind first pass

test("blind gate (pure): hidden until every hunk is visited, or revealed early in an older review; the write-up names those", () => {
  const ch = [["a", "b"], ["c"]];
  expect(chapterHidden(false, ch[0]!, { visited: [] })).toBe(false); // blind off: nothing is hidden
  expect(chapterHidden(true, [], { visited: [] })).toBe(false);
  expect([...hiddenHunks(true, ch, { visited: ["a"] })]).toEqual(["a", "b", "c"]);
  expect([...hiddenHunks(true, ch, { visited: ["a", "b"] })]).toEqual(["c"]);
  expect([...hiddenHunks(true, ch, { visited: [], revealed: ["c"] })]).toEqual(["a", "b"]);
  expect(earlyTitles([{ title: "One", ids: ["a", "b"] }, { title: "Two", ids: ["c"] }], { visited: [], revealed: ["c"] })).toEqual(["Two"]);
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

test("blind: before visiting, the gutter has no ▲, the rail shows ▲?, → and g f find nothing and the decision keys do nothing", async () => {
  // Two hunks in one chapter, cursor on the first: the chapter is not read yet.
  const t = await open({ plan: { summary: "", by: "guide", mechanical: [], chapters: [{ title: "Both", intent: "Check it", why: "w", hunks: [h1!.id, h2!.id] }] } }, { blind: true });
  expect(t.frame()).not.toContain("▲ ");
  expect(t.frame()).toContain("Both ▲?");
  expect(t.frame()).toContain("0 ▲?"); // header: nothing revealed, something hidden
  await t.press("jj" + RIGHT);
  expect(t.frame()).toContain("Hidden until you have been through this chapter");
  expect(t.frame()).not.toContain("answer is hard-coded");
  await t.press(ESC + "gf");
  expect(t.frame()).toContain("no findings to go to");
  expect(t.frame()).not.toContain("answer is hard-coded");
  expect(t.r.pos.item).toBe(0);
  await t.press(ESC + "gh");
  expect(t.frame()).not.toContain("answer is hard-coded");
  for (const k of ["b", "c", "i"]) {
    await t.press(ESC + "gg" + "jj" + k); // on the finding's line with no box open: the decision keys do nothing at all
    expect(t.frame()).not.toContain("comment on the finding ›");
    expect(t.frame()).not.toContain("private note ›");
  }
  expect(t.r.doc.human.decisions).toBeUndefined();
  expect(t.r.doc.human.comments).toEqual([]);
  expect(t.r.doc.human.revealed).toBeUndefined();
});

test("blind: visiting every hunk of a chapter reveals it without recording anything", async () => {
  const t = await open({ plan: { summary: "", by: "guide", mechanical: [], chapters: [{ title: "Both", intent: "Check it", why: "w", hunks: [h1!.id, h2!.id] }] } }, { blind: true });
  expect(t.frame()).toContain("Both ▲?");
  await t.press("jjjjj"); // runs on into the second hunk; the first was visited on open
  expect(t.r.pos.item).toBe(1);
  expect(t.frame()).toContain("1 Both ▲1");
  await t.press("gf");
  expect(t.frame()).toContain("answer is hard-coded");
  expect(t.r.doc.human.revealed).toBeUndefined();
  expect(writeup(t.r.doc, files)).not.toContain("seen before reading");
});

// ---------------------------------------------------------------- finding triage

const f2: Finding = { ...finding, id: "2", line: 12, severity: "warn", title: "Second line looks unused" };
const f3: Finding = { ...finding, id: "3", hunk: h2!.id, line: 2, severity: "nit", title: "Type changed to a string" };
const three = { findings: [finding, f2, f3] };

test("triage b: the comment line opens prefilled with the title, is edited, and saves at the finding's line as blocking; the pass moves on", async () => {
  const t = await open(three);
  await t.press("gf");
  expect(t.frame()).toContain("0/3 decided");
  await t.press("b");
  expect(t.frame()).toContain("block on it › Hard-coded answer in main");
  expect(t.frame()).toMatch(row("ctrl-u", "clear line")); // the prompt's panel, with Enter worded for a decision
  expect(t.frame()).toMatch(row("Enter", "save"));
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
  await t.press("gfc");
  expect(t.frame()).toContain("comment on the finding › Hard-coded answer in main");
  await t.press(ESC);
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

test("triage i: ignore takes an optional private note, never a comment; each moves on", async () => {
  const t = await open(three);
  await t.press("gfi");
  expect(t.frame()).toContain("ignore · private note ›");
  expect(t.frame()).toContain("never posted");
  await t.press("42 is the spec\r");
  expect(t.r.doc.human.decisions!["1"]).toEqual({ kind: "dismissed", reason: "42 is the spec" });
  expect(t.frame()).toContain("Second line looks unused");
  await t.press("i\r"); // no note: still decided
  expect(t.r.doc.human.decisions!["2"]).toEqual({ kind: "dismissed" });
  expect(t.frame()).toContain("Type changed to a string");
  expect(t.r.pos.item).toBe(1); // across hunks
  await t.press("i\r");
  expect(t.r.doc.human.decisions!["3"]).toEqual({ kind: "dismissed" });
  expect(t.r.doc.human.comments).toEqual([]);
  expect(t.frame()).toContain("3/3 decided");
  expect(t.frame()).toContain("Every finding is decided");
  expect(t.frame()).toContain("0 ▲"); // the header counts what is left to decide
});

test("triage: pressing b, c or i again changes the decision; the comment is edited, not duplicated, and ignoring drops it", async () => {
  const t = await open(three);
  await t.press("gfb\r");
  expect(t.r.doc.human.comments).toHaveLength(1);
  await t.press("gF"); // back to the first
  expect(t.frame()).toContain("Decided: blocking. Your comment: Hard-coded answer in main");
  await t.press("c");
  expect(t.frame()).toContain("comment on the finding › Hard-coded answer in main"); // prefilled with what was written
  await t.press(" (minor)\r");
  expect(t.r.doc.human.comments.map((c) => c.text)).toEqual(["Hard-coded answer in main (minor)"]);
  expect(t.r.doc.human.decisions!["1"]!.kind).toBe("comment");
  await t.press("gF");
  await t.press("i\r");
  expect(t.r.doc.human.comments).toEqual([]);
  expect(t.r.doc.human.decisions!["1"]).toEqual({ kind: "dismissed" });
});

test("triage: a whole pass is g f and one key per finding; the decisions are in the saved review", async () => {
  const t = await open(three);
  await t.press("gfb\r");
  await t.press("c\r");
  await t.press("i\r");
  expect(t.r.doc.human.decisions).toMatchObject({ "1": { kind: "block" }, "2": { kind: "comment" }, "3": { kind: "dismissed" } });
  // What a reopen reads: the review as saved, through the document parser.
  const saved = JSON.parse(readFileSync(join(tmp, "t.json"), "utf8")).doc;
  const again = { doc: parseDocument({ ...saved, target: { ...saved.target, base: "a".repeat(40), head: "b".repeat(40) } }) }; // the fixture's commits are stand-ins
  expect(again.doc.human.decisions).toEqual(t.r.doc.human.decisions);
  expect(again.doc.human.comments.map((c) => c.text)).toEqual(["Hard-coded answer in main", "Second line looks unused"]);
});

test("triage with nothing to act on: off a finding b/c/i are not keys; in blind, a revealed chapter's findings are the only ones counted", async () => {
  const t = await open(three);
  await t.press("jjc\r"); // on a finding's line with no box open: c is nothing, Enter starts your own finding
  expect(t.frame()).not.toContain("comment on the finding ›");
  expect(t.frame()).toContain("new finding ›");
  await t.press(ESC);
  expect(t.r.doc.human.decisions).toBeUndefined();
  expect(t.r.doc.human.comments).toEqual([]);

  const b = await open(three, { blind: true });
  await b.press("gf"); // chapter 1 is read on open (one hunk); chapter 2 is not
  expect(b.frame()).toContain("0/2 decided");
  await b.press("c\rc\r");
  expect(b.frame()).toContain("Every finding you can see is decided");
  expect(b.r.doc.human.decisions!["3"]).toBeUndefined();
});

test("nav helpers (pure): wrapping, severity order, file edges and chapter starts", () => {
  const items = [{ id: h1!.id, path: "src/a.rs", hunk: h1!.hunk!, chapter: 0 }, { id: h2!.id, path: "src/b.ts", hunk: h2!.hunk!, chapter: 1 }];
  const fs = [finding, f2, f3];
  expect(nextFindingWrapping(items, fs, { item: 1, line: 3 }, 1)?.finding.id).toBe("1");
  expect(nextFindingWrapping(items, fs, { item: 0, line: 0 }, -1)?.finding.id).toBe("3");
  expect(nextFindingWrapping(items, [], { item: 0, line: 0 }, 1)).toBeUndefined();
  expect(nextBySeverity(items, [f3, f2, finding], undefined, 1)?.finding.id).toBe("1");
  expect(nextBySeverity(items, [f3, f2, finding], "1", 1)?.finding.id).toBe("2");
  expect(nextBySeverity(items, [f3, f2, finding], "3", 1)?.finding.id).toBe("1");
  expect(nextBySeverity(items, [f3, f2, finding], undefined, -1)?.finding.id).toBe("3");
  expect(fileEdge(items, 0, "end")).toEqual({ item: 0, line: 4 });
  expect(fileEdge(items, 1, "top")).toEqual({ item: 1, line: 0 });
  expect(chapterStart(items, 2)).toEqual({ item: 1, line: 0 });
  expect(chapterStart(items, 3)).toBeUndefined();
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
  const press = async (keys: string) => { for (const k of keys.match(KEY) ?? []) { app.stdin.write(k); await settle(); } };
  return { copied, press, frame: () => (app.lastFrame() ?? "").replace(/\x1b\[[0-9;]*m/g, "") };
}

test("y: with a finding open copies its source text and the footer says how much; with the chapter's why open, the why; with none, path:line", async () => {
  const t = await copying();
  await t.press("y");
  expect(t.copied).toEqual(["src/a.rs:10"]); // no box yet: the cursor line
  expect(t.frame()).toContain("copied 11 chars");
  await t.press("j");
  expect(t.frame()).not.toContain("copied 11 chars");
  await t.press("j" + RIGHT);
  await t.press("y");
  expect(t.copied[1]).toBe("src/a.rs:11 — Hard-coded answer in main\n\nanswer is hard-coded\n\n42 appears with no source");
  expect(t.copied[1]).not.toMatch(/[│─╭╮╰╯]/);
  await t.press("x" + LEFT); // close the finding, then ← opens the chapter's intent and why
  await t.press("y");
  expect(t.copied[2]).toBe("Core change\n\nCheck the answer is derived\n\nIt is the heart of it.");
  expect(t.frame()).toContain(`copied ${t.copied[2]!.length} chars`);
});

test("y: a box with no source text says so instead of copying the hints", async () => {
  const t = await copying({ findings: [] });
  await t.press("gf");
  expect(t.frame()).toContain("no findings to go to");
  await t.press("y");
  expect(t.copied).toEqual([]);
  expect(t.frame()).toContain("nothing to copy here");
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

test("an imported review's verdict is in the opening summary as information only; submit does not start from it", async () => {
  const t = await open({}, { suggested: [{ by: "mylinter", verdict: "request_changes" }, { by: "imported", verdict: "approve" }] });
  const f = t.frame();
  expect(f).toContain("Summary of this change · not a finding");
  expect(f).toContain("mylinter's review suggested Request changes.");
  expect(f).toContain("An imported review suggested Approve.");
  expect(f).toContain("information only");
  await t.press("s");
  expect(t.frame()).toContain("verdict ›");
  expect(t.frame()).not.toContain("Enter takes");
  expect(t.r.doc.human.verdict).toBeUndefined();
});

test("the in-house suggestion shows its reason in the summary and as a picker hint, and never becomes the default", async () => {
  const t = await open({}, { suggested: [{ by: "prview", verdict: "comment", reason: "1 warn: Off by one" }, { by: "imported", verdict: "approve" }] });
  expect(t.frame()).toContain("prview's review suggested Comment: 1 warn: Off by one.");
  await t.press("s");
  expect(t.frame()).toContain("verdict ›");
  expect(t.frame()).toContain("suggested, information only: prview Comment, imported Approve");
  expect(t.frame()).not.toContain("Enter takes");
  expect(t.r.doc.human.verdict).toBeUndefined();
});

// ---------------------------------------------------------------- the summary and the content area

const SUMMARY = "Replaces the hard-coded answer with one derived from the input.";
const withSummary = (plan: Partial<Doc["plan"]> = {}) => ({ plan: { summary: SUMMARY, by: "guide", mechanical: [], chapters: [{ title: "Core change", intent: "Check the answer is derived", why: "It is the heart of it.", hunks: [h1!.id] }, { title: "The ts side", intent: "Check the type", why: "Second.", hunks: [h2!.id] }], ...plan } });
const models = { guide: "g", critic: "c", refute: "r", ask: "a" };

test("opening summary: a double-ruled box titled as the summary, above the code; the code's keys act beside it; Esc closes it", async () => {
  const t = await open(withSummary());
  const f = t.frame();
  expect(f).toContain("Summary of this change · not a finding");
  expect(f).toContain(SUMMARY);
  expect(f).toContain("╔"); // findings are round boxes (╭), so the two cannot be mistaken
  expect(f).not.toContain("╭");
  expect(f.indexOf("Summary of this change")).toBeLessThan(f.indexOf("keep")); // above the first code line, not hugging the ▲ line
  expect(f).not.toMatch(/Prepared by/); // no provenance without runs
  expect(f).toContain("Esc closes this; a i brings it back"); // the box names its keys, as bound now
  shown(t, { state: "code" }); // the code's panel: the summary is only something to read
  await t.press("j");
  expect(t.r.pos.line).toBe(1);
  expect(t.frame()).toContain("Summary of this change"); // a move within the block keeps it
  await t.press(ESC);
  expect(t.frame()).not.toContain("Summary of this change");
  expect(t.r.pos.line).toBe(1);
});

test("a i brings the summary back after Esc closed it; with none, it says so", async () => {
  const t = await open(withSummary());
  await t.press(ESC);
  expect(t.frame()).not.toContain("Summary of this change");
  await t.press("ai");
  expect(t.frame()).toContain("Summary of this change · not a finding");
  expect(t.frame()).toContain("╔");
  const none = await open(withSummary({ summary: "" }));
  expect(none.frame()).not.toContain("Summary of this change");
  await none.press("ai");
  expect(none.frame()).toContain("no summary for this review");
  expect(none.frame()).not.toContain("╔");
});

test("opening summary: a finding box keeps its own look, and the summary names who prepared it only when every run has a model id", async () => {
  const t = await open(withSummary(), { ai: { models, at: "now", errors: [], runs: [{ role: "guide", model: "claude-opus-5-5", ms: 1 }, { role: "critic", model: "claude-opus-5-5", ms: 1 }] } });
  expect(t.frame()).toContain("Prepared by claude-opus-5-5 (guide, critic)");
  await t.press("gf");
  expect(t.frame()).toContain("╭");
  expect(t.frame()).not.toContain("╔");
  const old = await open(withSummary(), { ai: { models, at: "now", errors: [], runs: [{ role: "guide", ms: 1 }, { role: "critic", ms: 1 }] } });
  expect(old.frame()).toContain(SUMMARY);
  expect(old.frame()).not.toContain("Prepared by");
  expect(old.frame()).not.toContain("unknown");
});

test("Tab moves focus into the box: the arrows scroll it, y copies it, Tab or Esc comes back; with nothing there it says so", async () => {
  const long = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
  const t = await open(withSummary({ summary: long }));
  expect(t.frame()).toContain("Tab to scroll"); // the box says it scrolls, and how
  await t.press(TAB);
  expect(t.frame()).toContain("focused");
  shown(t, { state: "content" });
  expect(listing(entriesOf({ state: "content" }))).toEqual(["↓/↑ j/k scroll", "PgDn/PgUp ctrl-d/ctrl-u page", "y copy", "Tab back"]);
  await t.press("jj" + DOWN);
  expect(t.r.pos.line).toBe(0); // the arrows scroll the box, not the code
  expect(t.frame()).toMatch(/· 4-\d+\/\d+/);
  await t.press(PGDN);
  expect(t.frame()).not.toMatch(/· 4-\d+\/\d+/);
  await t.press(TAB);
  expect(t.frame()).not.toContain("focused");
  await t.press("j");
  expect(t.r.pos.line).toBe(1); // back in the code
  await t.press(TAB + ESC); // Esc comes back too, and the box stays
  expect(t.frame()).not.toContain("focused");
  expect(t.frame()).toContain("Summary of this change");
  await t.press(ESC + TAB);
  expect(t.frame()).toContain("the content area is empty");
});

test("← shows the chapter's intent and why (where the table of contents will); a mechanical hunk says it was classified by rule", async () => {
  const t = await open();
  await t.press(LEFT);
  expect(t.frame()).toContain("1 · Core change");
  expect(t.frame()).toContain("It is the heart of it.");
  await t.press("h"); // h is ← too
  expect(t.frame()).toContain("It is the heart of it.");
});

test("keys that come with later changes say so, and do nothing else", async () => {
  const t = await open();
  for (const [keys, id] of [["fh", "filter.high"], ["vz", "view.zen"], ["vc", "view.fullscreen"], ["as", "ai.draft"], ["\\", "review.settings"]] as const) {
    await t.press(keys);
    expect(t.frame(), id).toContain(`${keyOf(id)} `);
    expect(t.frame(), id).toContain("not built yet, coming with");
    expect(t.r.pos, id).toEqual({ item: 0, line: 0 });
  }
  await t.press("gf" + "aa");
  expect(t.frame()).toContain("coming with follow-up answers on findings");
  expect(t.frame()).toContain("Hard-coded answer in main"); // the finding stays open
});

// ---------------------------------------------------------------- the key panel: always there, per state

test("the panel is always there with the keys for where you are; it follows the state and never needs a key to show", async () => {
  const t = await open(undefined, { cols: 140 });
  shown(t, { state: "code" });
  expect(listing(entriesOf({ state: "code" }))).toEqual(["↓/↑ j/k line", "⇧↓/⇧↑ J/K chapter", "→ l open finding", "← h contents", "Tab content", "Enter new finding", "s submit", "y copy", "? search docs", "\\ settings", "q quit", "a AI…", "f filter…", "v view…", "g go to…"]);
  await t.press("gf");
  shown(t, { state: "finding" });
  await t.press("x");
  shown(t, { state: "code" });
});

test("each state's panel lists its keys, and leaving the state brings the code's back", async () => {
  const states: { name: string; into: string; state: KeyState; out: string; over?: Over }[] = [
    { name: "finding", into: "gf", state: { state: "finding" }, out: ESC },
    { name: "content", into: TAB, state: { state: "content" }, out: ESC + ESC, over: withSummary() },
    { name: "ask prompt", into: "a?", state: { state: "prompt", kind: "ask" }, out: ESC },
    { name: "new finding", into: "\r", state: { state: "prompt", kind: "comment" }, out: ESC },
    { name: "ignore note", into: "gfi", state: { state: "prompt", kind: "reason" }, out: ESC + ESC },
    { name: "block comment", into: "gfb", state: { state: "prompt", kind: "comment", decide: true }, out: ESC + ESC },
    { name: "verdict", into: "s", state: { state: "submit", step: "verdict" }, out: ESC },
    { name: "preview", into: "sa", state: { state: "submit", step: "preview", dryRun: false, hook: null, coverage: null }, out: ESC + ESC },
    { name: "docs results", into: "?mark this finding as wrong\r", state: { state: "content", results: true }, out: ESC },
  ];
  for (const s of states) {
    const t = await open(s.over, { cols: 140, rows: 40 });
    await t.press(s.into);
    shown(t, s.state);
    await t.press(s.out);
    shown(t, { state: "code" });
  }
});

test("prompts: their panel is the keys that work; text goes in as typed, prefixes and backslash included", async () => {
  const t = await open();
  await t.press("\r");
  expect(listing(entriesOf({ state: "prompt", kind: "comment" }))).toEqual(["Enter send", "ctrl-u clear line", "ctrl-w delete word", "Esc cancel"]);
  await t.press("one gv two\\ ?");
  expect(t.frame()).toContain("new finding › one gv two\\ ?");
  shown(t, { state: "prompt", kind: "comment" }); // g, v, \ and ? did nothing but type
  await t.press("\x17"); // ctrl-w
  expect(t.frame()).toContain("new finding › one gv two\\ ");
  await t.press("zzz\x15"); // ctrl-u
  expect(t.frame()).not.toContain("zzz");
  await t.press("x\r");
  expect(t.r.doc.human.comments.map((c) => c.text)).toEqual(["x"]);
  expect(listing(entriesOf({ state: "prompt", kind: "ask" }))[0]).toBe("Enter ask");
  expect(listing(entriesOf({ state: "prompt", kind: "reason" }))).toEqual(["Enter ignore", "ctrl-u clear line", "Esc cancel"]);
  expect(listing(entriesOf({ state: "prompt", kind: "comment", decide: true }))).toEqual(["Enter save", "ctrl-u clear line", "ctrl-w delete word", "Esc cancel decision"]);
});

test("verdict and preview: the panel lists what acts; x and v appear only when the submit has that choice", async () => {
  expect(listing(entriesOf({ state: "submit", step: "verdict" }))).toEqual(["a approve", "r request changes", "c comment", "Enter default verdict", "Esc cancel"]);
  const t = await open();
  await t.press("sr"); // request changes
  expect(t.r.doc.human.verdict).toBe("request_changes");
  expect(listing(entriesOf({ state: "submit", step: "preview", dryRun: false, hook: null, coverage: null }))).toEqual(["Enter submit", "↓/↑ j/k scroll", "PgDn/PgUp ctrl-d/ctrl-u page", "Esc back"]);
  shown(t, { state: "submit", step: "preview", dryRun: false, hook: null, coverage: null });
  expect(t.frame()).not.toMatch(row("x", "allow command"));
  expect(t.frame()).not.toMatch(row("v", "add coverage line"));
  await t.press(ESC);
  const g = await open(undefined, { dryRun: true });
  g.r.doc.target.platform = "github";
  g.r.doc.on_submit = { run: ["true"] } as Doc["on_submit"];
  await g.press("sc");
  expect(g.frame()).toMatch(row("Enter", "print the calls"));
  expect(g.frame()).toMatch(row("x", "allow command"));
  expect(g.frame()).toMatch(row("v", "add coverage line"));
  await g.press("x");
  expect(g.frame()).toMatch(row("x", "disallow command"));
  await g.press("v");
  expect(g.frame()).toMatch(row("v", "drop coverage line"));
  await g.press("\r");
  expect(g.outcomes).toEqual([{ kind: "submit", hook: true, coverage: true }]);
});

test("the panel never covers the cursor line or the open box's text, at any width or height", async () => {
  for (const [cols, rows] of [[140, 40], [100, 30], [90, 28], [80, 24], [60, 20], [100, 20]] as const) {
    const t = await open(undefined, { cols, rows });
    await t.press("gf"); // a finding box open under the cursor line, with its panel
    const f = t.frame();
    const at = `${cols}x${rows}`;
    expect(f, at).toContain("let answer = 42"); // the cursor line
    expect(f, at).toContain("Hard-coded answer in main");
    expect(f, at).toContain("42 appears with no source"); // the box's text, to its last line
    expect(f.split("\n").length, at).toBeLessThanOrEqual(rows);
    for (const line of f.split("\n")) expect([...line].length, at).toBeLessThanOrEqual(cols);
    await t.press("x");
    expect(t.frame(), at).toContain("let answer = 42");
    expect(t.frame().split("\n").length, at).toBeLessThanOrEqual(rows);
  }
});

test("below 100 columns the code's panel still lists every key in a grid; too short, it collapses to one line", async () => {
  const t = await open(undefined, { cols: 90, rows: 40 });
  shown(t, { state: "code" });
  for (const line of t.frame().split("\n")) expect([...line].length).toBeLessThanOrEqual(90);
  const short = await open(undefined, { cols: 90, rows: 14 });
  const lines = short.frame().split("\n");
  expect(lines.some((l) => l.includes("↓/↑ j/k line"))).toBe(true);
  expect(short.frame()).not.toContain("┌"); // no box: one dim line
});

test("panelOf: the fewest columns that fit the height; one line when none fits; always within the width", () => {
  const e = (n: number) => Array.from({ length: n }, (_, i) => ({ keys: String.fromCharCode(97 + i), label: `act${i}` }));
  const one = panelOf("t", e(4), 80, 40);
  expect(one).toMatchObject({ boxed: true, height: 7 }); // border, title, four rows
  const wide = panelOf("t", e(20), 80, 40); // cap 13 → 10 inner rows → two columns
  expect(wide.boxed).toBe(true);
  expect(wide.lines.length).toBe(10);
  expect(wide.width).toBeLessThanOrEqual(80);
  expect(panelOf("t", e(20), 12, 40)).toMatchObject({ boxed: false, height: 1 }); // no grid fits 12 columns
  const tiny = panelOf("t", e(20), 30, 12);
  expect(tiny.boxed).toBe(false);
  expect(tiny.lines[0]!.length).toBeLessThanOrEqual(29);
  expect(tiny.lines[0]).toMatch(/…$/);
  expect(panelCap(40)).toBe(13);
  expect(panelCap(19)).toBe(1); // never so tall that a box and the code lose their room
  for (const rows of [19, 24, 30, 40, 80]) expect(rows - panelCap(rows)).toBeGreaterThanOrEqual(18);
});

// ---------------------------------------------------------------- configurable bindings

test("remapped keys: the panel and the hints show the new keys, the new keys act and the old ones do not", async () => {
  installKeymap(effectiveKeys({ "finding.ignore": { primary: "d" }, "finding.close": { primary: "X" }, "go.next_finding": { primary: "n" }, "code.down": { secondary: "" }, "ai.info": { primary: "o" } }));
  try {
    const t = await open({ ...three, ...withSummary() });
    expect(t.frame()).toContain("Esc closes this; a o brings it back"); // the summary's hint names the key as bound now
    expect(t.frame()).toMatch(row("↓/↑ k", "line"));
    await t.press("j"); // the removed secondary does nothing
    expect(t.r.pos.line).toBe(0);
    await t.press(DOWN);
    expect(t.r.pos.line).toBe(1);
    await t.press("gf"); // the old second key is nothing now
    expect(t.frame()).not.toContain("0/3 decided");
    await t.press("gn");
    expect(t.frame()).toContain("0/3 decided");
    expect(listing(entriesOf({ state: "finding" })).slice(0, 5)).toEqual(["X close", "← h back", "b block", "c comment", "d ignore"]);
    shown(t, { state: "finding" });
    await t.press("i"); // the old key is nothing at all
    expect(t.frame()).not.toContain("private note ›");
    await t.press("d");
    expect(t.frame()).toContain("private note ›");
    await t.press(ESC);
    await t.press("x"); // and x no longer closes
    expect(t.frame()).toContain("0/3 decided");
    await t.press("X");
    expect(t.frame()).not.toContain("0/3 decided");
    expect(keyOf("finding.ignore")).toBe("d");
  } finally { installKeymap(DEFAULT_KEYMAP); }
});

// ---------------------------------------------------------------- ? search the docs

/** An App whose clipboard records what `y` copies. */
async function openCopying() {
  const copied: string[] = [];
  const copier = (t: string) => { copied.push(t); return { ok: true as const, chars: t.length, via: "test" }; };
  const r = fixture();
  const app = render(<App review={r} files={files} onDone={() => {}} copier={copier} size={{ cols: 120, rows: 40 }} />);
  await settle();
  const press = async (keys: string) => { for (const k of keys.match(KEY) ?? []) { app.stdin.write(k); await settle(); } };
  return { app, press, copied, frame: () => (app.lastFrame() ?? "").replace(/\x1b\[[0-9;]*m/g, "") };
}

test("? is listed in the code's panel as search docs, and opens a one-line question box that Esc closes", async () => {
  const t = await open();
  expect(t.frame()).toMatch(row("?", "search docs"));
  await t.press("?");
  expect(t.frame()).toContain("search the docs › ");
  expect(listing(entriesOf({ state: "prompt", kind: "docs" }))).toEqual(["Enter search", "ctrl-u clear line", "ctrl-w delete word", "Esc cancel"]);
  shown(t, { state: "prompt", kind: "docs" });
  await t.press("mark /\\?");
  expect(t.frame()).toContain("search the docs › mark /\\?"); // text goes in as typed
  await t.press(ESC);
  expect(t.frame()).not.toContain("search the docs ›");
  // An empty question closes without searching.
  await t.press("?\r");
  expect(t.frame()).not.toContain("search the docs ›");
  expect(t.frame()).not.toContain("Search the docs ·");
});

test("? a question: the top answers show the action, the user's key, where it works and the why; Esc closes", async () => {
  const t = await open();
  await t.press("?mark this finding as wrong\r");
  const f = t.frame();
  expect(f).toContain("Search the docs · mark this finding as wrong");
  expect(f).toMatch(/1\. ignore: i, in an open finding/);
  expect(f).toMatch(/[2-4]\. /); // several answers, not one
  expect(f).not.toMatch(/5\. /);
  expect(listing(entriesOf({ state: "content", results: true }))).toEqual(["↓/↑ j/k select", "PgDn/PgUp ctrl-d/ctrl-u page", "y copy", "Tab close"]);
  shown(t, { state: "content", results: true }); // focus is in the results
  await t.press(ESC);
  expect(t.frame()).not.toContain("Search the docs ·");
  await t.press("\r");
  expect(t.frame()).toContain("new finding › "); // back in the code: Enter is a new finding again
});

test("? results: j and k move the selection, y copies the selected answer as plain text, other keys do nothing", async () => {
  const t = await openCopying();
  await t.press("?mark this finding as wrong\r");
  expect(t.frame()).toContain("› 1. ");
  await t.press("y");
  expect(t.copied).toHaveLength(1);
  expect(t.copied[0]).toMatch(/^ignore: i, in an open finding\n\S/);
  expect(t.copied[0]).not.toMatch(/[›│╭]/); // no marker, no box
  await t.press("j");
  expect(t.frame()).toContain("› 2. ");
  expect(t.frame()).not.toContain("› 1. ");
  await t.press("y");
  expect(t.copied[1]).not.toBe(t.copied[0]);
  await t.press("k");
  expect(t.frame()).toContain("› 1. ");
  await t.press("k");
  expect(t.frame()).toContain("› 1. "); // stops at the first
  await t.press("s"); // a code key: does nothing here
  expect(t.frame()).toContain("Search the docs ·");
  expect(t.frame()).not.toContain("verdict › ");
  await t.press(TAB); // Tab closes the results too
  expect(t.frame()).not.toContain("Search the docs ·");
});

test("? results show the key as bound now: a remap reaches the answer", async () => {
  installKeymap(effectiveKeys({ "finding.ignore": { primary: "d" }, "review.search_docs": { primary: "/" } }));
  try {
    const t = await open();
    await t.press("?"); // the old key is gone
    expect(t.frame()).not.toContain("search the docs ›");
    await t.press("/");
    expect(t.frame()).toContain("search the docs › ");
    await t.press("mark this finding as wrong\r");
    expect(t.frame()).toMatch(/1\. ignore: d, in an open finding/);
    await t.press(ESC);
    expect(t.frame()).toMatch(row("/", "search docs"));
  } finally { installKeymap(DEFAULT_KEYMAP); }
});

test("? with no match and with nothing typed: a plain answer, no crash", async () => {
  const t = await open();
  await t.press("?   \r");
  expect(t.frame()).not.toContain("Search the docs ·");
  await t.press("?zzzzqqqq\r");
  expect(t.frame()).toContain("Search the docs · zzzzqqqq");
  await t.press("y");
  await t.press(ESC);
  expect(t.frame()).not.toContain("Search the docs ·");
});

test("a hunk line with an OSC/CSI payload is drawn with visible stand-ins; no raw ESC reaches the screen, and models still get the raw text", async () => {
  const payload = "\x1b]0;pwned\x07\x1b[2Jboom\x85\r";
  const evil = DIFF.replace("+new2", `+new2 ${payload}`);
  const efiles = parseDiff(evil);
  const r = fixture();
  const app = render(<App review={r} files={efiles} onDone={() => {}} size={{ cols: 120, rows: 40 }} />);
  await settle();
  const all = app.frames.join("\n") + (app.lastFrame() ?? "");
  expect(all.replace(/\x1b\[[0-9;]*m/g, "")).not.toMatch(/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f-\x9f]|\x1b/);
  expect(app.lastFrame()).toContain("new2 ␛]0;pwned␇␛[2Jboom\\x85␍");
  // What a model is sent is the code as written.
  expect(efiles[0]!.hunks[0]!.lines.some((l) => l.text.includes("\x1b]0;pwned\x07"))).toBe(true);
  expect(criticPrompt({ title: "t" }, { title: "c", intent: "i", why: "w", hunks: [hunksOf(efiles)[0]!.id] }, hunksOf(efiles))).toContain("\x1b]0;pwned\x07");
  expect(visible("a\tb\x7f")).toBe("a\tb␡");
});
