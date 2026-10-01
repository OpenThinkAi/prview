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
import { entriesOf, panelOf, panelTitle, plain, type Entry } from "../src/panel.ts";
import { DEFAULT_KEYMAP, effectiveKeys, installKeymap, keyOf, type KeyState } from "../src/keys.ts";
import { parseDocument, SCHEMA } from "../src/document.ts";
import { parseConfig } from "../src/config.ts";
import { App, type Outcome } from "../src/tui.tsx";
import { highlightLines, langOf, sliceSpans, styleOf } from "../src/highlight.ts";
import { bottomHeight, boxLines, clampScroll, layoutOf, pageStep, windowOf, wrapText } from "../src/layout.ts";
import { DROP_ORDER, fitFields, statusFields, type StatusInput } from "../src/status.ts";
import { editorArgs, tmuxSplit, besideIn } from "../src/editor.ts";
import { nextBySeverity, nextFindingWrapping, fileEdge, chapterStart, tocIndex, tocMove, tocRows, type TocAt, type TocMove } from "../src/nav.ts";
import { DEFAULTS, type Defaults } from "../src/triage.ts";
import type { Flow } from "../src/submit-flow.ts";

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

const finding: Finding = { id: "1", source: "critic", hunk: h1!.id, side: "new", line: 11, severity: "high", kind: "bug", title: "Hard-coded answer in main", claim: "answer is hard-coded", evidence: "42 appears with no source", status: "upheld" };
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

// The key panel draws each entry as its keys, then its label; a second column is at least two spaces from the first.
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const row = (keys: string, label: string) => new RegExp(`(?:│ |  )${esc(keys)} +${esc(label)}(?: |\\s*│)`);
const listing = (e: { keys: string; label: string }[]) => e.map((x) => `${x.keys} ${x.label}`);
const settle = () => new Promise((r) => setTimeout(r, 30));
/** `code`: step from the table of contents, where a review opens, into the first block's code (→), as most tests start there. */
async function open(over?: Over, props: { ai?: Review["ai"]; suggested?: Review["suggested"]; blind?: boolean; dryRun?: boolean; cols?: number; rows?: number; beside?: (p: string, l: number) => string | undefined; code?: boolean; defaults?: Defaults; resume?: Flow } = {}) {
  const outcomes: Outcome[] = [];
  const r = fixture(over);
  r.ai = props.ai;
  if (props.suggested) r.suggested = props.suggested;
  const app = render(<App review={r} files={files} onDone={(o) => outcomes.push(o)} beside={props.beside} blind={props.blind} dryRun={props.dryRun} defaults={props.defaults} resume={props.resume} size={{ cols: props.cols ?? 120, rows: props.rows ?? 40 }} />);
  await settle();
  // One key at a time: a handler closes over the state of its render, so two keys in one chunk would both see the old cursor.
  const press = async (keys: string) => { for (const k of keys.match(KEY) ?? []) { app.stdin.write(k); await settle(); } };
  if (props.code) await press(RIGHT);
  return { r, app, press, outcomes, cols: props.cols ?? 120, rows: props.rows ?? 40, frame: () => (app.lastFrame() ?? "").replace(/\x1b\[[0-9;]*m/g, "") };
}
type Shown = { frame: () => string; cols: number; rows: number };
/** The key panel for state `s` as the screen lays it out at this size: the submit flow's send step (and `full`) is the full-screen one. */
const panelAt = (t: Shown, s: KeyState, full = false) => {
  const L = layoutOf(t.cols, t.rows - 1, { full: full || (s.state === "submit" && s.step === "send") });
  return panelOf(panelTitle(s), entriesOf(s), L.panelW, L.bottomH);
};
/** Every line of the state's key panel is on the screen, and the grid holds every entry, secondaries included, at this size. */
const shown = (t: Shown, s: KeyState, full = false) => {
  const p = panelAt(t, s, full);
  for (const l of p.lines) expect(t.frame(), plain(l)).toContain(plain(l).trimEnd());
  if (p.fit === "grid") for (const e of entriesOf(s)) expect(t.frame(), `${e.keys} ${e.label}`).toMatch(row(e.keys, e.label));
};

test("rail: every chapter with its blocks (▾ expanded), the cursor's block marked, a read chapter ticked, findings counted", async () => {
  const t = await open();
  expect(t.frame()).toContain("✓▾ 1 Core change ▲1"); // its one block is read on open
  expect(t.frame()).toContain("› a.rs:10 ▲");
  expect(t.frame()).toContain(" ▾ 2 The ts side");
  expect(t.frame()).toContain("b.ts:1");
  await t.press("J");
  expect(t.frame()).toContain("✓▾ 2 The ts side");
  expect(t.r.doc.human.visited).toEqual([h1!.id, h2!.id]);
});

test("layout: the bottom panel is a third of the screen, 8 to 14 rows; the middle keeps its room; full-screen takes all but the status area", () => {
  // The rows the app lays out are the terminal's less one.
  expect([24, 28, 32, 40, 60, 80].map((r) => bottomHeight(r - 1))).toEqual([8, 9, 10, 13, 14, 14]);
  for (const [cols, rows] of [[120, 31], [100, 27], [80, 23], [60, 19], [200, 59]] as const) {
    const L = layoutOf(cols, rows);
    expect(4 + L.middleH + L.bottomH + 1, `${cols}x${rows}`).toBe(rows); // status, middle, bottom panel, footer
    expect(L.middleH, `${cols}x${rows}`).toBeGreaterThanOrEqual(8);
    expect(L.contentW + L.panelW).toBe(cols);
    expect(L.contentW / cols).toBeGreaterThanOrEqual(0.6); // the content area is about two thirds
    // The finding box on its line never leaves the code window fewer than three rows.
    expect(L.middleH - 2 - (3 + boxLines(L.middleH)), `${cols}x${rows}`).toBeGreaterThanOrEqual(3);
  }
  expect(boxLines(16)).toBe(2);
  const F = layoutOf(120, 31, { full: true });
  expect(F.middleH).toBe(0);
  expect(F.bottomH).toBe(31 - 4 - 1);
  expect(F.contentRows).toBe(F.bottomH - 3);
});

test("rail: below 100 columns it collapses to chapter numbers and the code keeps the room", async () => {
  const t = await open(undefined, { cols: 80 });
  expect(t.frame()).toContain("▾1▲1");
  expect(t.frame()).toContain(" ›1 ▲"); // its block, by number
  expect(regions(t).middle).not.toContain("Core change");
  expect(regions(t).middle).toContain("Check the answer is derived"); // the chapter's intent is still on the hunk header
  for (const line of t.frame().split("\n")) expect([...line].length).toBeLessThanOrEqual(80);
});

test("cursor: ↓/↑ and j/k move a line and run on across blocks; ⇧↓/⇧↑ and J/K move a chapter; g g and g e the file's edges", async () => {
  const t = await open(undefined, { cols: 100, code: true });
  expect(t.r.pos.line).toBe(0);
  await t.press("jj");
  expect(t.r.pos.line).toBe(2);
  await t.press(DOWN);
  expect(t.r.pos.line).toBe(3);
  await t.press(UP + "k");
  expect(t.r.pos.line).toBe(1);
  await t.press("ge"); // the file's "whole file" row after its last line
  expect(t.r.pos).toEqual({ item: 0, line: 5 });
  await t.press("j"); // the end of the block: on into the next one, which starts with its own file's row
  expect(t.r.pos).toEqual({ item: 1, line: -1 });
  await t.press("k"); // and back to the row that ended the one before
  expect(t.r.pos).toEqual({ item: 0, line: 5 });
  await t.press("k"); // then its last line
  expect(t.r.pos).toEqual({ item: 0, line: 4 });
  await t.press("gg");
  expect(t.r.pos.line).toBe(-1);
  await t.press("k"); // the very first row: nowhere to go
  expect(t.r.pos).toEqual({ item: 0, line: -1 });
  await t.press("j");
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

test("g <digits> g goes to that line of the file, g c <digits> g to a chapter (Enter too); the footer shows the chord as it is typed", async () => {
  const t = await open();
  await t.press("g1");
  expect(t.frame()).toMatch(/ g 1\s*$/m);
  expect(t.frame()).toMatch(row("g Enter", "go")); // the panel says how to finish
  await t.press("2\r");
  expect(t.r.pos).toEqual({ item: 0, line: 3 }); // new-side line 12 is the fourth row
  await t.press("gc2\r");
  expect(t.r.pos).toEqual({ item: 1, line: 0 });
  await t.press("gc1g"); // g closes the chapter number too
  expect(t.r.pos).toEqual({ item: 0, line: 0 });
  await t.press("g12g");
  expect(t.r.pos).toEqual({ item: 0, line: 3 });
  await t.press("gc2\r");
  await t.press("gc9\r");
  expect(t.frame()).toContain("there is no chapter 9");
  await t.press("g7" + ESC); // Esc cancels a half-typed number
  expect(t.r.pos).toEqual({ item: 1, line: 0 });
  expect(t.frame()).not.toMatch(/ g 7\s*$/m);
});

test("a prefix shows its second keys in the panel; Esc cancels it, an unknown second key does nothing", async () => {
  const t = await open(undefined, { code: true });
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

test("finding: → on its line opens it with its action, the panel lists the finding's keys, x closes it", async () => {
  const t = await open(undefined, { code: true });
  await t.press(RIGHT);
  expect(t.frame()).toContain("no finding on this line");
  await t.press("jj" + RIGHT);
  expect(t.frame()).toContain("critic · bug · high · block (default)"); // a high finding starts as block
  const fr = t.frame();
  expect(fr.indexOf("Hard-coded answer in main")).toBeGreaterThan(fr.indexOf("critic · bug · high"));
  expect(fr.indexOf("answer is hard-coded")).toBeGreaterThan(fr.indexOf("Hard-coded answer in main"));
  expect(fr).toContain("Action: block (default). A high finding starts as block.");
  expect(fr).not.toContain("decided");
  shown(t, { state: "finding" });
  expect(listing(entriesOf({ state: "finding" }))).toEqual(["x close", "← h back", "b block", "c comment", "i ignore", "y copy", "PgDn/PgUp ctrl-d/ctrl-u page", "Tab content", "a AI…", "v view…", "g go to…"]);
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

test("g h / g H: by severity, every high finding first, then the medium ones, then the low ones, wrapping", async () => {
  const warn: Finding = { ...finding, id: "w", line: 12, severity: "medium", title: "A warning" };
  const nit: Finding = { ...finding, id: "n", hunk: h2!.id, line: 2, severity: "low", title: "A nit" };
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

test("Enter on a line makes your own finding there: pick a severity (arrows, Enter), write the comment (several lines), save; it behaves like any finding", async () => {
  const t = await open(undefined, { code: true });
  await t.press("jj\r");
  expect(t.frame()).toContain("New finding at src/a.rs:11 · pick its severity");
  shown(t, { state: "prompt", kind: "severity" });
  await t.press(UP); // medium is where it starts; up is high
  await t.press("\r");
  expect(t.frame()).toContain("New high finding at src/a.rs:11");
  shown(t, { state: "prompt", kind: "finding" });
  await t.press("why 42?");
  await t.press("\x0e"); // ctrl-n: a new line
  await t.press("it is not derived");
  expect(t.frame()).toContain("it is not derived");
  await t.press("\r");
  const mine = t.r.doc.findings.find((f) => f.source === "you")!;
  expect(mine).toMatchObject({ source: "you", hunk: h1!.id, side: "new", line: 11, severity: "high", claim: "why 42?\nit is not derived" });
  expect(mine.file).toBeUndefined();
  // High starts as block: the action is carried out as the reader's own comment with exactly those words.
  expect(t.r.doc.human.decisions![mine.id]).toMatchObject({ kind: "block" });
  expect(t.r.doc.human.comments.map((n) => [n.hunk, n.side, n.line, n.text])).toEqual([[h1!.id, "new", 11, "why 42?\nit is not derived"]]);
  // It opens like any finding, on its line, with the action keys.
  expect(t.frame()).toContain("▲ you · finding · high · block");
  expect(t.frame()).toContain("findings ▲ 2 high");
  await t.press("c\r"); // comment instead, prefilled with what was written
  expect(t.r.doc.human.decisions![mine.id]).toMatchObject({ kind: "comment" });
  await t.press("y");
  expect(t.frame()).toContain("copied");
});

test("a new finding takes the severity's default action; an empty comment or Esc makes none", async () => {
  const t = await open(undefined, { code: true, defaults: { high: "block", medium: "comment", low: "ignore" } });
  await t.press("\r" + DOWN + "\r"); // low, whose default here is ignore
  await t.press("fine but odd\r");
  const low = t.r.doc.findings.find((f) => f.source === "you")!;
  expect(low.severity).toBe("low");
  expect(t.r.doc.human.decisions?.[low.id]).toBeUndefined(); // still on its default, ignore: nothing is posted
  expect(t.r.doc.human.comments).toEqual([]);
  await t.press("x\r\r\r"); // close it; a new finding at medium; an empty comment stays in the prompt
  expect(t.frame()).toContain("a finding needs its comment");
  expect(t.r.doc.findings.filter((f) => f.source === "you")).toHaveLength(1);
  await t.press(ESC);
  expect(t.r.doc.findings.filter((f) => f.source === "you")).toHaveLength(1);
});

test("each file's diff starts and ends with a whole file row; g g and g e land on them, and Enter there makes a file-level finding", async () => {
  const t = await open(undefined, { code: true });
  expect(t.frame()).toContain("┌ whole file · src/a.rs");
  expect(t.frame()).toContain("└ whole file · src/a.rs");
  await t.press("gg");
  expect(t.r.pos).toEqual({ item: 0, line: -1 });
  await t.press("\r\r"); // medium
  expect(t.frame()).toContain("New medium finding at src/a.rs (whole file)");
  await t.press("the whole file is too clever\r");
  const mine = t.r.doc.findings.find((f) => f.source === "you")!;
  expect(mine).toMatchObject({ hunk: h1!.id, file: true, line: 0, severity: "medium", claim: "the whole file is too clever" });
  expect(t.r.doc.human.comments).toEqual([expect.objectContaining({ hunk: h1!.id, line: null, file: true, text: "the whole file is too clever" })]);
  expect(t.frame()).toContain("▲ you · finding · medium · comment");
  expect(t.frame()).toMatch(/▲ ┌ whole file/); // marked in the gutter of its row
  await t.press("x");
  await t.press("ge");
  expect(t.r.pos).toEqual({ item: 0, line: 5 });
  await t.press("\r\r");
  await t.press("and the end of it\r");
  expect(t.r.doc.findings.filter((f) => f.file).map((f) => f.line)).toEqual([0, 1]);
  // → on a row opens a finding there; Enter there makes a new one.
  await t.press("x");
  await t.press("gg" + RIGHT);
  expect(t.frame()).toContain("the whole file is too clever");
  // g f walks to the file-level findings too.
  await t.press("x");
  await t.press("gf");
  expect(t.r.pos.line).toBe(2); // the critic's finding, between the two rows
  await t.press("gf");
  expect(t.r.pos.line).toBe(5); // then the one on the end row
  await t.press("gf");
  expect(t.r.pos.line).toBe(-1); // and round to the start row
  expect(writeup(t.r.doc, files)).toContain("src/a.rs (whole file)");
  // Copy on a row is the file's path.
  await t.press("x");
  await t.press("gg");
  await t.press("y");
  expect(t.frame()).toContain("copied");
});

test("→ on a line opens an existing finding and never makes one; Enter always makes a new one, even where a finding is", async () => {
  const t = await open(undefined, { code: true });
  await t.press("jj" + RIGHT);
  expect(t.frame()).toContain("critic · bug · high");
  await t.press("x" + "\r");
  expect(t.frame()).toContain("New finding at src/a.rs:11 · pick its severity");
  await t.press(ESC + "j" + RIGHT);
  expect(t.frame()).toContain("no finding on this line");
});

const second: Finding = { ...finding, id: "2", hunk: h2!.id, line: 2, severity: "medium", title: "Type changed to a string", claim: "y is a string now" };
const dropped: Finding = { ...finding, id: "3", hunk: h2!.id, line: 2, severity: "low", title: "Maybe a nit", claim: "a nit", status: "withdrawn" };
const PR_URL = "https://github.com/o/r/pull/7";
const S_TAB = "\x1b[Z";

test("submit step 1: every finding with its severity, action and title; block and comment ticked, ignore not; Space, a, Esc", async () => {
  const t = await open({ findings: [finding, second, dropped] });
  await t.press("s");
  expect(t.frame()).toContain("Submit · 1 Findings › 2 Verdict › 3 Comment › 4 Send");
  expect(t.frame()).toContain("[x] high · block (default) · src/a.rs:11 · Hard-coded answer in main");
  expect(t.frame()).toContain("[x] medium · comment (default) · src/b.ts:2 · Type changed to a string");
  expect(t.frame()).toContain("[ ] low · ignore (default) · src/b.ts:2 · Maybe a nit");
  shown(t, { state: "submit", step: "findings" });
  await t.press(" "); // the cursor starts on the first
  expect(t.frame()).toContain("[ ] high · block (default)");
  await t.press("j ");
  expect(t.frame()).toContain("[ ] medium · comment (default)");
  await t.press("a"); // not all ticked: tick all
  expect(t.frame()).toContain("[x] low · ignore (default)");
  expect(t.frame()).toContain("[x] high");
  await t.press("a"); // all ticked: untick all
  expect(t.frame()).not.toContain("[x]");
  await t.press(ESC); // leaves the flow; nothing sent, nothing recorded
  expect(t.frame()).not.toContain("Submit ·");
  expect(t.outcomes).toEqual([]);
  expect(t.r.doc.human.verdict).toBeUndefined();
  expect(t.r.doc.human.decisions).toBeUndefined();
});

test("submit step 2: the platform's verdicts as a radio, starting on what the ticks imply; always changeable; ⇧Tab back", async () => {
  const t = await open({ findings: [finding, second] }, { suggested: [{ by: "prview", verdict: "comment", reason: "x" }] });
  t.r.doc.target.platform = "github";
  await t.press("s" + TAB);
  shown(t, { state: "submit", step: "verdict" });
  expect(t.frame()).toContain("(•) Request changes"); // a ticked block
  expect(t.frame()).toContain("( ) Approve");
  expect(t.frame()).toContain("( ) Comment");
  expect(t.frame()).toContain("suggested, information only: prview Comment");
  await t.press(S_TAB + " " + TAB); // untick the block: only a comment is ticked
  expect(t.frame()).toContain("(•) Comment");
  await t.press(S_TAB + "j " + TAB); // nothing ticked: no selection
  expect(t.frame()).not.toContain("(•)");
  expect(t.frame()).toContain("Nothing ticked implies a verdict");
  await t.press("j");
  expect(t.frame()).toContain("(•) Approve");
  await t.press("jjj"); // stops at the last
  expect(t.frame()).toContain("(•) Comment");
  await t.press(S_TAB + "a" + TAB); // a verdict picked by hand stays, whatever is ticked
  expect(t.frame()).toContain("(•) Comment");
});

test("submit step 3: a multi-line comment box, prefilled with the summary comments; Esc stops typing, v e opens the editor", async () => {
  const t = await open({ comments: [{ hunk: null, side: "new", line: null, text: "An old summary", at: "now" }] });
  await t.press("s" + TAB + TAB);
  shown(t, { state: "submit", step: "comment", typing: true });
  expect(t.frame()).toContain("│ An old summary");
  await t.press("\rvery good, ve");
  expect(t.frame()).toContain("│ very good, ve"); // typing: v is text, not a prefix
  await t.press("\x17"); // ctrl-w
  expect(t.frame()).toContain("│ very good,");
  expect(t.frame()).not.toContain("good, ve");
  await t.press(ESC); // stops typing; still in the step
  shown(t, { state: "submit", step: "comment", typing: false });
  expect(t.frame()).toContain("Submit ·");
  await t.press("ve");
  expect(t.outcomes).toHaveLength(1);
  const o = t.outcomes[0]!;
  expect(o.kind).toBe("edit_comment");
  if (o.kind === "edit_comment") expect(o.flow).toMatchObject({ step: "comment", comment: "An old summary\nvery good," });
});

test("submit: after the editor the flow reopens where it was, with the comment it wrote", async () => {
  const t = await open({ findings: [finding] }, { resume: { step: "comment", listed: ["1"], ticked: [], at: 0, verdicts: ["approve", "request_changes", "comment"], verdict: "approve", picked: true, comment: "From the editor\nline two", typing: false, hook: false, coverage: false, box: 0 } });
  expect(t.frame()).toContain("│ From the editor");
  expect(t.frame()).toContain("│ line two");
  await t.press(TAB);
  expect(t.frame()).toContain("Verdict: Approve");
  expect(t.frame()).toContain("From the editor");
  await t.press(S_TAB + S_TAB + S_TAB);
  expect(t.frame()).toContain("[ ] high · block (default)"); // the ticks came back too
});

test("submit step 4: exactly what posts, checkboxes for the command and the coverage line (both off), Enter sends the selection", async () => {
  const t = await open({ findings: [finding, second, dropped] });
  Object.assign(t.r.doc.target, { platform: "github", url: PR_URL });
  t.r.doc.on_submit = { run: ["notify-tool", "--file", "{file}"] };
  await t.press("gfb\x15mine: derive it\r" + ESC); // block on the first with words of your own
  await t.press("s" + TAB + TAB + "Looks close." + TAB);
  shown(t, { state: "submit", step: "send", dryRun: false, boxes: true });
  const f = t.frame();
  expect(f).not.toContain("READ IN ORDER"); // full-screen
  expect(f).toContain("[ ] Run the document's on_submit command: notify-tool --file");
  expect(f).toContain(`[ ] Add "I read`);
  expect(f).toContain(`What posts to ${PR_URL}`);
  expect(f).toContain("Verdict: Request changes");
  expect(f).toContain("  Looks close.");
  expect(f).toContain("Line comments (2):");
  expect(f).toContain("mine: derive it"); // your comment on the block
  expect(f).toContain("y is a string now"); // the medium one on its default comment: its own text
  expect(f).not.toContain("a nit"); // ignored, unticked: nothing
  expect(f.slice(f.indexOf("── What posts"), f.indexOf("── On submit"))).not.toMatch(/critic|prview/i); // never a word of tooling in what posts
  await t.press(" "); // tick the command
  expect(t.frame()).toContain("[x] Run the document's on_submit command");
  await t.press(PGDN + PGDN);
  expect(t.frame()).toContain("Allowed for this submit: it runs after the post.");
  await t.press(PGUP + PGUP + "j "); // and the coverage line
  expect(t.frame()).toMatch(/\[x\] Add "I read \d of 2 hunks\."/);
  expect(t.r.doc.human.verdict).toBeUndefined(); // nothing is recorded until it is sent
  await t.press("\r");
  expect(t.outcomes).toEqual([{ kind: "submit", hook: true, coverage: true, selection: { listed: ["1", "2", "3"], include: ["1", "2"], comment: "Looks close.", verdict: "request_changes" }, defaults: DEFAULTS }]);
});

test("submit step 4: the checkboxes do not outlive the flow; Esc from it leaves, and s starts over with both off", async () => {
  const t = await open();
  t.r.doc.on_submit = { run: ["notify-tool"] };
  await t.press("s" + TAB + TAB + TAB + " ");
  expect(t.frame()).toContain("[x] Run");
  await t.press(ESC + "s" + TAB + TAB + TAB);
  expect(t.frame()).toContain("[ ] Run");
  await t.press("\r");
  expect(t.outcomes).toEqual([{ kind: "submit", hook: false, coverage: false, selection: { listed: ["1"], include: ["1"], comment: "", verdict: "request_changes" }, defaults: DEFAULTS }]);
});

test("submit step 4: without a verdict Enter sends nothing and says so; with no platform the file is the review", async () => {
  const t = await open();
  await t.press("s " + TAB + TAB + TAB); // untick the one finding: nothing ticked, no verdict
  expect(t.frame()).toContain("Pick a verdict first");
  expect(t.frame()).toContain("Nothing is posted (the document has no platform)");
  shown(t, { state: "submit", step: "send", dryRun: false, boxes: false });
  await t.press("\r");
  expect(t.outcomes).toEqual([]);
  expect(t.frame()).toContain("pick a verdict first");
});

test("submit flow: with --dry-run the send step says nothing will be posted, and Enter prints the calls", async () => {
  const t = await open(undefined, { dryRun: true });
  await t.press("s" + TAB + TAB + TAB);
  expect(t.frame()).toContain("dry run");
  expect(t.frame()).toContain("DRY RUN");
  expect(t.frame()).toMatch(row("Enter", "print the calls"));
});

test("long lines: cut with an ellipsis, v w wraps onto more rows and back", async () => {
  const t = await open(undefined, { cols: 100, code: true });
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
  const plain = await open(undefined, { code: true });
  await plain.press("jjve");
  expect(plain.outcomes).toEqual([{ kind: "edit", path: "src/a.rs", line: 11 }]);

  const opened: [string, number][] = [];
  const t = await open(undefined, { code: true, beside: (p, l) => { opened.push([p, l]); return undefined; } });
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

test("layout: 100 columns is the edge of the narrow rail; zen gives the code the rail's width; pages stay in range", () => {
  expect(layoutOf(99, 31).narrow).toBe(true);
  expect(layoutOf(100, 31).narrow).toBe(false);
  expect(layoutOf(80, 23).codeW).toBeGreaterThan(60);
  expect(layoutOf(120, 31, { zen: true }).railW).toBe(0);
  expect(layoutOf(120, 31, { zen: true }).codeW).toBe(layoutOf(120, 31).codeW + layoutOf(120, 31).railW);
  expect(clampScroll(99, 40, 7)).toBe(33);
  expect(clampScroll(-5, 40, 7)).toBe(0);
  expect(pageStep(7)).toBe(6);
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
  expect(editorArgs(["hx"], "a.rs", 7, "/wt")).toEqual(["hx", "+7", "--", "/wt/a.rs"]);
  expect(editorArgs(["code"], "a.rs", 7, "/wt")).toEqual(["code", "-g", "/wt/a.rs:7", "--wait"]);
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

test("blind: before visiting, the gutter has no ▲, the rail shows ▲?, → and g f find nothing and the action keys do nothing", async () => {
  // Two hunks in one chapter, cursor on the first: the chapter is not read yet.
  const t = await open({ plan: { summary: "", by: "guide", mechanical: [], chapters: [{ title: "Both", intent: "Check it", why: "w", hunks: [h1!.id, h2!.id] }] } }, { blind: true, code: true });
  expect(t.frame()).not.toContain("▲ ");
  expect(t.frame()).toContain("Both ▲?");
  expect(t.frame()).toContain("findings none · more hidden ▲?"); // status: nothing revealed, something hidden
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
    await t.press(ESC + "gg" + "jj" + k); // on the finding's line with no box open: the action keys do nothing at all
    expect(t.frame()).not.toContain("comment on the finding ›");
    expect(t.frame()).not.toContain("private note ›");
  }
  expect(t.r.doc.human.decisions).toBeUndefined();
  expect(t.r.doc.human.comments).toEqual([]);
  expect(t.r.doc.human.revealed).toBeUndefined();
});

test("blind: visiting every hunk of a chapter reveals it without recording anything", async () => {
  const t = await open({ plan: { summary: "", by: "guide", mechanical: [], chapters: [{ title: "Both", intent: "Check it", why: "w", hunks: [h1!.id, h2!.id] }] } }, { blind: true, code: true });
  expect(t.frame()).toContain("Both ▲?");
  await t.press("jjjjjjj"); // runs on through the first file's closing row and the second's opening row into the second hunk; the first was visited on open
  expect(t.r.pos.item).toBe(1);
  expect(t.frame()).toContain("1 Both ▲1");
  await t.press("gf");
  expect(t.frame()).toContain("answer is hard-coded");
  expect(t.r.doc.human.revealed).toBeUndefined();
  expect(writeup(t.r.doc, files)).not.toContain("seen before reading");
});

// ---------------------------------------------------------------- actions on findings

const f2: Finding = { ...finding, id: "2", line: 12, severity: "medium", title: "Second line looks unused", claim: "new2 is never read" };
const f3: Finding = { ...finding, id: "3", hunk: h2!.id, line: 2, severity: "low", title: "Type changed to a string", claim: "y is a string now" };
const three = { findings: [finding, f2, f3] };

test("b: the comment line opens in the content area prefilled with the finding's text, is edited and saved at its line; the finding stays open, blocked", async () => {
  const t = await open(three);
  await t.press("gf");
  expect(t.frame()).toContain("critic · bug · high · block (default)");
  await t.press("b");
  expect(regions(t).bottom).toContain("block on it › answer is hard-coded");
  expect(t.frame()).toMatch(row("ctrl-u", "clear line")); // the prompt's panel, with Enter worded for an action
  expect(t.frame()).toMatch(row("Enter", "save"));
  await t.press("\x15"); // ctrl-u: the prefill is rewritten whole
  await t.press("Where does 42 come from?\r");
  const [c] = t.r.doc.human.comments;
  expect(c).toMatchObject({ hunk: h1!.id, side: "new", line: 11, text: "Where does 42 come from?" });
  expect(t.r.doc.human.decisions).toEqual({ "1": { kind: "block", comment: c!.id } });
  expect(t.frame()).toMatch(/» Where does 42 come from\?/); // shown under its line like any comment
  // The finding stays open where it was, its action no longer the default.
  expect(t.r.pos).toEqual({ item: 0, line: 2 });
  expect(t.frame()).toContain("critic · bug · high · block");
  expect(t.frame()).not.toContain("block (default)");
  expect(t.frame()).toContain("Action: block. Your comment: Where does 42 come from?");
});

test("c: Esc cancels and saves nothing; Enter keeps the finding's text as the comment; an emptied line changes nothing", async () => {
  const t = await open(three);
  await t.press("gfc");
  expect(t.frame()).toContain("comment on the finding › answer is hard-coded");
  await t.press(ESC);
  expect(t.r.doc.human.comments).toEqual([]);
  expect(t.r.doc.human.decisions).toBeUndefined();
  expect(t.frame()).toContain("block (default)"); // the finding is still open, on its default
  await t.press("c\r");
  expect(t.r.doc.human.comments.map((c) => [c.line, c.text])).toEqual([[11, "answer is hard-coded"]]);
  expect(t.r.doc.human.decisions!["1"]!.kind).toBe("comment");
  await t.press("gf"); // the medium one, on its default comment
  expect(t.frame()).toContain("critic · bug · medium · comment (default)");
  await t.press("c\x15\r");
  expect(t.r.doc.human.decisions!["2"]).toBeUndefined();
  expect(t.frame()).toContain("comment (default)");
});

test("i: ignore takes an optional private note, with a placeholder saying it is never posted; never a comment", async () => {
  const t = await open(three);
  await t.press("gfi");
  expect(regions(t).bottom).toContain("ignore · private note ›");
  expect(regions(t).bottom).toContain("private note — never posted"); // the placeholder, while nothing is typed
  await t.press("42");
  expect(regions(t).bottom).not.toContain("never posted");
  await t.press(" is the spec\r");
  expect(t.r.doc.human.decisions!["1"]).toEqual({ kind: "ignore", reason: "42 is the spec" });
  expect(t.frame()).toContain("critic · bug · high · ignore");
  expect(t.frame()).toContain("Private note: 42 is the spec");
  await t.press("gfi\r"); // no note: still ignored
  expect(t.r.doc.human.decisions!["2"]).toEqual({ kind: "ignore" });
  expect(t.r.doc.human.comments).toEqual([]);
  expect(t.frame()).toContain("findings ▲ 1 high · 1 medium · 1 low"); // the status area counts findings by severity, whatever their action
});

test("pressing b, c or i again changes the action; the comment is edited, not duplicated, and ignoring drops it", async () => {
  const t = await open(three);
  await t.press("gfb\r");
  expect(t.r.doc.human.comments).toHaveLength(1);
  expect(t.frame()).toContain("Action: block. Your comment: answer is hard-coded");
  await t.press("c");
  expect(t.frame()).toContain("comment on the finding › answer is hard-coded"); // prefilled with what was written
  await t.press(" (minor)\r");
  expect(t.r.doc.human.comments.map((c) => c.text)).toEqual(["answer is hard-coded (minor)"]);
  expect(t.r.doc.human.decisions!["1"]!.kind).toBe("comment");
  await t.press("i\r");
  expect(t.r.doc.human.comments).toEqual([]);
  expect(t.r.doc.human.decisions!["1"]).toEqual({ kind: "ignore" });
  await t.press("b");
  expect(t.frame()).toContain("block on it › answer is hard-coded"); // the comment was dropped: the finding's text again
});

test("a pass is g f and a key per finding; the actions are in the saved review", async () => {
  const t = await open(three);
  await t.press("gfb\r");
  await t.press("gfc\r");
  await t.press("gfi\r");
  expect(t.r.doc.human.decisions).toMatchObject({ "1": { kind: "block" }, "2": { kind: "comment" }, "3": { kind: "ignore" } });
  // What a reopen reads: the review as saved, through the document parser.
  const saved = JSON.parse(readFileSync(join(tmp, "t.json"), "utf8")).doc;
  const again = { doc: parseDocument({ ...saved, target: { ...saved.target, base: "a".repeat(40), head: "b".repeat(40) } }) }; // the fixture's commits are stand-ins
  expect(again.doc.human.decisions).toEqual(t.r.doc.human.decisions);
  expect(again.doc.findings.map((f) => f.severity)).toEqual(["high", "medium", "low"]);
  expect(again.doc.human.comments.map((c) => c.text)).toEqual(["answer is hard-coded", "new2 is never read"]);
});

test("a finding the refute step dropped shows, ignored by default, with the reason in its detail; it can still be acted on", async () => {
  const dropped: Finding = { ...finding, status: "withdrawn", refute: "Line 12 already derives it (cites n12)" };
  const t = await open({ findings: [dropped] }, { code: true });
  expect(t.frame()).toContain("▾ 1 Core change ▲1"); // counted like any other, its ▲ dim: its only finding is ignored
  expect(t.frame()).toContain("findings ▲ 1 high");
  expect(t.frame()).not.toContain("withdrawn");
  await t.press("jj");
  expect(t.frame()).toMatch(/11 △ \+/); // a dim mark: every finding on the line is ignored
  await t.press("gf");
  expect(t.frame()).toContain("critic · bug · high · ignore (default)");
  expect(t.frame()).toContain("Second look: Line 12 already derives it (cites n12)");
  expect(t.frame()).toContain("Action: ignore (default). The second look dropped this finding");
  await t.press("c\r");
  expect(t.r.doc.human.decisions!["1"]!.kind).toBe("comment");
  expect(t.frame()).toMatch(/11 ▲ \+/);
});

test("the default actions come from the config: a finding on its default says so", async () => {
  const t = await open(three, { defaults: { high: "comment", medium: "ignore", low: "block" } });
  await t.press("gf");
  expect(t.frame()).toContain("critic · bug · high · comment (default)");
  await t.press("gf");
  expect(t.frame()).toContain("critic · bug · medium · ignore (default)");
  await t.press("gf");
  expect(t.frame()).toContain("critic · bug · low · block (default)");
  expect(parseConfig('[defaults]\nhigh = "comment"\nlow = "ignore"').defaults).toEqual({ high: "comment", medium: "comment", low: "ignore" });
  expect(parseConfig("").defaults).toEqual({ high: "block", medium: "comment", low: "comment" });
  expect(() => parseConfig('[defaults]\nhigh = "dismiss"')).toThrow('[defaults]: high must be one of "block", "comment", "ignore"');
  expect(() => parseConfig('[defaults]\nblocking = "block"')).toThrow("[defaults]: blocking is not a severity; use high, medium or low");
});

test("with nothing to act on: off a finding b/c/i are not keys; in blind, a revealed chapter's findings are the only ones reachable", async () => {
  const t = await open(three, { code: true });
  await t.press("jjc\r"); // on a finding's line with no box open: c is nothing, Enter starts your own finding
  expect(t.frame()).not.toContain("comment on the finding ›");
  expect(t.frame()).toContain("pick its severity");
  await t.press(ESC);
  expect(t.r.doc.human.decisions).toBeUndefined();
  expect(t.r.doc.human.comments).toEqual([]);

  const b = await open(three, { blind: true });
  expect(b.frame()).toContain("findings ▲ 1 high · 1 medium · more hidden ▲?"); // chapter 1 is read on open (one hunk); chapter 2 is not
  await b.press("gfc\r");
  await b.press("gfc\r");
  await b.press("gf"); // wraps to the first: the third is still hidden
  expect(b.frame()).toContain("critic · bug · high · comment");
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
  expect(fileEdge(items, 0, "end")).toEqual({ item: 0, line: 5 }); // the whole-file row after the last line
  expect(fileEdge(items, 1, "top")).toEqual({ item: 1, line: -1 });
  expect(chapterStart(items, 2)).toEqual({ item: 1, line: 0 });
  expect(chapterStart(items, 3)).toBeUndefined();
});

test("table of contents (pure): rows, ↓/↑ block to block with a collapsed chapter one stop, chapters, expand, collapse, enter", () => {
  // Chapter 0 with two blocks, chapter 1 with one, chapter 2 (mechanical, collapsed) with two.
  const mk = (chapter: number) => ({ id: `h${chapter}`, path: "p", hunk: h1!.hunk!, chapter });
  const items = [mk(0), mk(0), mk(1), mk(2), mk(2)];
  const folded: ReadonlySet<number> = new Set([2]);
  expect(tocRows(items, folded).map((r) => `${r.kind[0]}${r.item}`)).toEqual(["c0", "b0", "b1", "c2", "b2", "c3"]);
  const move = (at: TocAt, m: TocMove, c = folded) => tocMove(items, c, at, m);
  const on = (item: number, onChapter = false): TocAt => ({ item, onChapter });
  expect(move(on(0), "down").at).toEqual(on(1));
  expect(move(on(1), "down").at).toEqual(on(2)); // over chapter 1's row, to its block
  expect(move(on(2), "down").at).toEqual(on(3, true)); // a collapsed chapter is one stop
  expect(move(on(3, true), "down").at).toEqual(on(3, true)); // the end
  expect(move(on(2), "up").at).toEqual(on(1));
  expect(move(on(0), "up").at).toEqual(on(0)); // the top
  expect(move(on(0, true), "down").at).toEqual(on(0)); // a chapter row down to its first block
  expect(move(on(1), "next_chapter").at).toEqual(on(2, true));
  expect(move(on(2), "next_chapter").at).toEqual(on(3, true));
  expect(move(on(2), "prev_chapter").at).toEqual(on(0, true));
  expect(move(on(0, true), "prev_chapter").at).toEqual(on(0, true));
  const opened = move(on(3, true), "expand");
  expect([...opened.collapsed]).toEqual([]);
  expect(opened.at).toEqual(on(3, true));
  expect(move(on(3, true), "expand", opened.collapsed).at).toEqual(on(3)); // expanded: down to the first block
  expect(move(on(1), "expand").enter).toBe(true);
  expect(move(on(1), "collapse").at).toEqual(on(0, true)); // a block goes up to its chapter
  const shut = move(on(0, true), "collapse");
  expect([...shut.collapsed].sort()).toEqual([0, 2]);
  expect(move(on(3, true), "collapse")).toEqual({ at: on(3, true), collapsed: folded }); // already collapsed: nothing
  // A block of a collapsed chapter (the code got there some other way) sits on its chapter's row.
  expect(tocIndex(tocRows(items, folded), items, on(4))).toBe(5);
  expect(move(on(4), "up").at).toEqual(on(2));
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
  await press(RIGHT); // into the code
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
  await t.press("x" + LEFT); // close the finding, then ← goes back to the table of contents, which shows the chapter
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
  expect(strip()).toContain("▾ 1 Core change");
  resizeTo(out, 80, 24);
  await new Promise((r) => setTimeout(r, 120));
  const f = strip();
  expect(f).not.toContain("▾ 1 Core change"); // the rail collapsed to numbers
  expect(f.split("\n").every((l) => l.length <= 80)).toBe(true);
  expect(app.frames.includes(WIPE)).toBe(true);
});

test("resize: a terminal below 60x20 shows a one-line notice, and the review comes back when it grows", async () => {
  const r = fixture();
  const app = render(<App review={r} files={files} onDone={() => {}} />);
  const out = app.stdout as unknown as { columns: number; rows: number; emit: (e: string) => boolean };
  const strip = () => (app.lastFrame() ?? "").replace(/\x1b\[[0-9;]*m/g, "");
  resizeTo(out, 59, 30);
  await new Promise((r) => setTimeout(r, 120));
  expect(strip()).toContain("terminal too small");
  expect(strip().split("\n").length).toBe(1);
  resizeTo(out, 120, 40);
  await new Promise((r) => setTimeout(r, 120));
  expect(strip()).toContain("Core change");
  expect(strip()).not.toContain("too small");
});

test("tooSmall: the limits are 60 columns and 20 rows", () => {
  expect(tooSmall({ cols: 59, rows: 40 })).toBe(true);
  expect(tooSmall({ cols: 120, rows: 19 })).toBe(true);
  expect(tooSmall({ cols: 60, rows: 20 })).toBe(false);
});

test("an imported review's verdict is in the opening summary as information only; submit does not start from it", async () => {
  const t = await open({}, { suggested: [{ by: "mylinter", verdict: "request_changes" }, { by: "imported", verdict: "approve" }] });
  const f = t.frame();
  expect(f).toContain("Summary of this change · not a finding");
  expect(f).toContain("mylinter's review suggested Request changes.");
  expect(f).toContain("An imported review suggested Approve.");
  expect(f).toContain("information only");
  await t.press(ESC + "s" + " " + TAB); // nothing ticked: the radio starts with no selection, whatever was suggested
  expect(t.frame()).toContain("( ) Approve");
  expect(t.frame()).not.toContain("(•)");
  expect(t.r.doc.human.verdict).toBeUndefined();
});

test("the in-house suggestion shows its reason in the summary and as a picker hint, and never becomes the default", async () => {
  const t = await open({}, { suggested: [{ by: "prview", verdict: "comment", reason: "1 warn: Off by one" }, { by: "imported", verdict: "approve" }] });
  expect(t.frame()).toContain("prview's review suggested Comment: 1 warn: Off by one.");
  expect(t.frame()).toContain("suggested Comment"); // and in the status area, the in-house one only
  await t.press(ESC + "s" + " " + TAB);
  expect(t.frame()).toContain("suggested, information only: prview Comment, imported Approve");
  expect(t.frame()).not.toContain("(•)");
  expect(t.r.doc.human.verdict).toBeUndefined();
});

// ---------------------------------------------------------------- the summary and the content area

const SUMMARY = "Replaces the hard-coded answer with one derived from the input.";
const withSummary = (plan: Partial<Doc["plan"]> = {}) => ({ plan: { summary: SUMMARY, by: "guide", mechanical: [], chapters: [{ title: "Core change", intent: "Check the answer is derived", why: "It is the heart of it.", hunks: [h1!.id] }, { title: "The ts side", intent: "Check the type", why: "Second.", hunks: [h2!.id] }], ...plan } });
const models = { guide: "g", critic: "c", refute: "r", ask: "a" };

test("opening summary: in the content area under the code, titled as the summary; the code's keys act beside it; Esc closes it", async () => {
  const t = await open(withSummary(), { code: true });
  const f = t.frame();
  expect(f).toContain("Summary of this change · not a finding");
  expect(f).toContain(SUMMARY);
  expect(f).not.toContain("╭"); // no box over the code: only a finding has one, on its line
  expect(f.indexOf("Summary of this change")).toBeGreaterThan(f.indexOf("keep")); // below the code, in the bottom panel
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
  expect(t.frame()).toContain(SUMMARY);
  const none = await open(withSummary({ summary: "" }), { code: true });
  expect(none.frame()).not.toContain("Summary of this change");
  expect(none.frame()).toContain("Nothing here. a i shows the summary"); // the empty content area says how to fill it
  await none.press("ai");
  expect(none.frame()).toContain("no summary for this review");
});

test("opening summary: a finding opens on its line and in the content area, and the summary names who prepared it only when every run has a model id", async () => {
  const t = await open(withSummary(), { ai: { models, at: "now", errors: [], runs: [{ role: "guide", model: "claude-opus-5-5", ms: 1 }, { role: "critic", model: "claude-opus-5-5", ms: 1 }] } });
  expect(t.frame()).toContain("Prepared by claude-opus-5-5 (guide, critic)");
  await t.press("gf");
  expect(t.frame()).toContain("╭ ▲ critic · bug · high · block (default)");
  expect(t.frame()).not.toContain("Prepared by"); // the content area shows one thing at a time
  const old = await open(withSummary(), { ai: { models, at: "now", errors: [], runs: [{ role: "guide", ms: 1 }, { role: "critic", ms: 1 }] } });
  expect(old.frame()).toContain(SUMMARY);
  expect(old.frame()).not.toContain("Prepared by");
  expect(old.frame()).not.toContain("unknown");
});

test("Tab moves focus into the content area: the arrows scroll it, y copies it, Tab or Esc comes back; with nothing there it says so", async () => {
  const long = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
  const t = await open(withSummary({ summary: long }), { code: true });
  expect(t.frame()).toContain("Tab to scroll"); // the box says it scrolls, and how
  await t.press(TAB);
  expect(t.frame()).toContain("focused");
  shown(t, { state: "content" });
  expect(listing(entriesOf({ state: "content" }))).toEqual(["↓/↑ j/k scroll", "PgDn/PgUp ctrl-d/ctrl-u page", "y copy", "Tab back", "v view…"]);
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

test("Tab with a finding open focuses its detail: the arrows scroll it, y copies it, Tab or Esc return to the finding, still open", async () => {
  const evidence = Array.from({ length: 40 }, (_, i) => `evidence ${i}`).join("\n");
  const t = await open({ findings: [{ ...finding, evidence }] }, { code: true });
  await t.press("gf");
  shown(t, { state: "finding" });
  expect(t.frame()).toContain("Tab to scroll");
  await t.press(TAB);
  expect(t.frame()).toContain("· focused");
  shown(t, { state: "content" });
  const at = t.r.pos;
  await t.press("jj" + DOWN);
  expect(t.r.pos).toEqual(at); // the arrows scroll the detail, not the code
  expect(t.frame()).toMatch(/· 4-\d+\/\d+/);
  await t.press(UP);
  expect(t.frame()).toMatch(/· 3-\d+\/\d+/);
  await t.press(TAB); // back to the finding, open, with its keys
  expect(t.frame()).not.toContain("focused");
  expect(t.frame()).toContain("Hard-coded answer in main");
  shown(t, { state: "finding" });
  await t.press(TAB + ESC); // Esc returns to the finding too: it does not close it
  shown(t, { state: "finding" });
  expect(t.frame()).toContain("critic · bug · high");
  await t.press("b"); // the finding's keys act again
  shown(t, { state: "prompt", kind: "comment", decide: true });
  await t.press(ESC + ESC);
  shown(t, { state: "code" });
});

test("Tab with a finding open: y copies the finding, v c goes full-screen and comes back to the same focus", async () => {
  const t = await copying();
  await t.press("jj" + RIGHT + TAB);
  await t.press("y");
  expect(t.copied).toEqual(["src/a.rs:11 — Hard-coded answer in main\n\nanswer is hard-coded\n\n42 appears with no source"]);
  await t.press("vc");
  expect(t.frame()).not.toContain("READ IN ORDER");
  await t.press("vc"); // out of full-screen, still focused in the detail
  expect(t.frame()).toContain("· focused");
  await t.press(TAB + "vc" + ESC); // from the finding: full-screen and back leaves focus on the finding
  expect(t.frame()).not.toContain("focused");
  expect(t.frame()).toContain("Hard-coded answer in main");
  await t.press("x");
  expect(t.frame()).not.toContain("answer is hard-coded");
});

test("Tab from the table of contents focuses the chapter's why and comes back to the same block; from the code, the summary", async () => {
  const t = await open();
  shown(t, { state: "toc" });
  await t.press(TAB);
  shown(t, { state: "content" });
  expect(t.frame()).toContain("· focused");
  expect(t.frame()).toContain("It is the heart of it.");
  await t.press("j");
  expect(t.r.pos).toEqual({ item: 0, line: 0 }); // the cursor stays put
  await t.press(TAB);
  shown(t, { state: "toc" });
  await t.press("j"); // the table of contents moves again
  expect(t.r.pos.item).toBe(1);
  await t.press(TAB + ESC);
  shown(t, { state: "toc" });
  await t.press(RIGHT + "ai" + TAB); // the summary (here, that there is none), from the code
  shown(t, { state: "content" });
  expect(t.frame()).toContain("There is no summary for this review.");
  await t.press(ESC);
  shown(t, { state: "code" });
  expect(t.frame()).toContain("There is no summary for this review.");
});

// ---------------------------------------------------------------- the table of contents

const withMechanical = (): Over => ({ plan: { summary: "", by: "guide", mechanical: [{ id: h2!.id, why: "whitespace only" }], chapters: [{ title: "Core change", intent: "Check the answer is derived", why: "It is the heart of it.", hunks: [h1!.id] }] } });

test("a review opens in the table of contents on the first block: the code shows it, the content area its chapter's intent and why", async () => {
  const t = await open();
  const { middle, bottom } = regions(t);
  expect(middle).toContain("› a.rs:10");
  expect(middle).toContain("src/a.rs · fn main()"); // the code pane shows the cursor's block
  expect(bottom).toContain("1 · Core change");
  expect(bottom).toContain("Check the answer is derived");
  expect(bottom).toContain("It is the heart of it.");
  expect(bottom).toMatch(/contents/); // the key panel is the table of contents'
  await t.press("j");
  expect(t.r.pos).toEqual({ item: 1, line: 0 });
  expect(regions(t).bottom).toContain("2 · The ts side");
  expect(regions(t).bottom).toContain("Second.");
  expect(regions(t).middle).toContain("src/b.ts");
  await t.press("j"); // the last block: nowhere to go
  expect(t.r.pos).toEqual({ item: 1, line: 0 });
  await t.press(UP);
  expect(t.r.pos).toEqual({ item: 0, line: 0 });
});

test("table of contents: ← goes up to the chapter and collapses it, → expands it and goes down to the block, → again enters the code", async () => {
  const t = await open();
  await t.press(LEFT); // the block's chapter row: the block stays listed, no longer marked
  expect(regions(t).middle).toContain("a.rs:10");
  expect(regions(t).middle).not.toContain("› a.rs:10");
  await t.press(LEFT); // collapsed: its block is gone from the rail
  expect(regions(t).middle).toContain("▸ 1 Core change");
  expect(regions(t).middle).not.toContain("a.rs:10");
  await t.press("j"); // on to the next block, past the collapsed chapter's
  expect(t.r.pos.item).toBe(1);
  await t.press("K" + RIGHT); // back to chapter 1's row, expanded again
  expect(regions(t).middle).toContain("▾ 1 Core change");
  expect(regions(t).middle).toContain("a.rs:10");
  await t.press(RIGHT + RIGHT); // down to the block, then into its code
  expect(regions(t).bottom).toMatch(/│ keys/); // the code's key panel
  await t.press("jj");
  expect(t.r.pos).toEqual({ item: 0, line: 2 });
  await t.press(LEFT); // no finding open: back to the table of contents at this block
  expect(regions(t).bottom).toContain("It is the heart of it.");
  expect(regions(t).bottom).toMatch(/│ contents/);
  await t.press(RIGHT); // and in again, on the line it left
  expect(t.r.pos).toEqual({ item: 0, line: 2 });
});

test("table of contents: ⇧↓/⇧↑ and J/K go chapter to chapter; the mechanical chapter starts collapsed and is one stop for ↓", async () => {
  const t = await open(withMechanical());
  expect(regions(t).middle).toContain("▸ 2 Mechanical (1)");
  expect(regions(t).middle).not.toContain("b.ts:1");
  await t.press("j"); // the collapsed chapter's row
  expect(t.r.pos.item).toBe(1);
  expect(regions(t).bottom).toContain("Classified by rule");
  await t.press(RIGHT + "j"); // expanded, then down to its block
  expect(regions(t).middle).toContain("b.ts:1");
  await t.press(SUP);
  expect(t.r.pos.item).toBe(0);
  await t.press(SDOWN);
  expect(t.r.pos.item).toBe(1);
  await t.press("K" + "J");
  expect(t.r.pos.item).toBe(1);
});

test("code: ← closes an open finding first, then goes back to the table of contents; g commands move between the two", async () => {
  const t = await open(undefined, { code: true });
  await t.press("jj" + RIGHT);
  expect(t.frame()).toContain("answer is hard-coded");
  await t.press(LEFT);
  expect(t.frame()).not.toContain("answer is hard-coded");
  expect(regions(t).bottom).toMatch(/│ keys/); // still in the code
  await t.press("h");
  expect(regions(t).bottom).toMatch(/│ contents/);
  await t.press("gf"); // from the table of contents a finding opens in the code
  expect(t.frame()).toContain("answer is hard-coded");
  expect(regions(t).bottom).toMatch(/│ finding/);
  await t.press("x" + LEFT + "gc2\r"); // g c: the table of contents, on chapter 2's first block
  expect(t.r.pos).toEqual({ item: 1, line: 0 });
  expect(regions(t).bottom).toMatch(/│ contents/);
  expect(regions(t).bottom).toContain("2 · The ts side");
  await t.press("g2\r"); // a line is in the code (new-side line 2 is the third row: the second is the removed one)
  expect(t.r.pos).toEqual({ item: 1, line: 2 });
  expect(regions(t).bottom).toMatch(/│ keys/);
});

test("g c into a collapsed chapter expands it; ← from its code comes back with it expanded", async () => {
  const t = await open(withMechanical());
  await t.press("gc2\r");
  expect(regions(t).middle).toContain("▾ 2 Mechanical (1)");
  expect(regions(t).middle).toContain("› b.ts:1");
  await t.press("K" + LEFT); // chapter 1's row, collapsed
  expect(regions(t).middle).toContain("▸ 1 Core change");
  await t.press("ge"); // g e: the end of this file, in the code
  expect(t.r.pos).toEqual({ item: 0, line: 5 });
  expect(regions(t).bottom).toMatch(/│ keys/);
  await t.press(LEFT); // back at that block, its chapter expanded so the cursor shows
  expect(regions(t).middle).toContain("▾ 1 Core change");
  expect(regions(t).middle).toContain("› a.rs:10");
});

test("a a and a x are not keys inside a finding until an answer about it is waiting; nothing says it is coming", async () => {
  const t = await open();
  // a a and a x are not keys inside a finding until an answer about it is waiting: the prefix is cancelled, nothing else.
  await t.press("gf" + "aa");
  expect(t.frame()).not.toContain("coming with");
  expect(t.frame()).toContain("Hard-coded answer in main"); // the finding stays open
});

// ---------------------------------------------------------------- the key panel: always there, per state

test("the panel is always there with the keys for where you are; it follows the state and never needs a key to show", async () => {
  const t = await open(undefined, { cols: 140 });
  shown(t, { state: "toc" }); // a review opens in the table of contents
  expect(listing(entriesOf({ state: "toc" }))).toEqual(["↓/↑ j/k block", "⇧↓/⇧↑ J/K chapter", "→ l expand / enter", "← h collapse", "Tab content", "s submit", "y copy", "? search docs", "\\ settings", "q quit", "a AI…", "f filter…", "v view…", "g go to…"]);
  expect(t.frame()).toContain("contents");
  await t.press(RIGHT);
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
    { name: "new finding: severity", into: "\r", state: { state: "prompt", kind: "severity" }, out: ESC },
    { name: "new finding: comment", into: "\r\r", state: { state: "prompt", kind: "finding" }, out: ESC },
    { name: "ignore note", into: "gfi", state: { state: "prompt", kind: "reason" }, out: ESC + ESC },
    { name: "block comment", into: "gfb", state: { state: "prompt", kind: "comment", decide: true }, out: ESC + ESC },
    { name: "findings", into: "s", state: { state: "submit", step: "findings" }, out: ESC },
    { name: "verdict", into: "s" + TAB, state: { state: "submit", step: "verdict" }, out: ESC },
    { name: "comment", into: "s" + TAB + TAB, state: { state: "submit", step: "comment", typing: true }, out: ESC + ESC },
    { name: "send", into: "s" + TAB + TAB + TAB, state: { state: "submit", step: "send", dryRun: false, boxes: false }, out: ESC },
    { name: "docs results", into: "?mark this finding as wrong\r", state: { state: "content", results: true }, out: ESC },
  ];
  for (const s of states) {
    const t = await open(s.over, { cols: 140, rows: 40, code: true });
    await t.press(s.into);
    shown(t, s.state);
    await t.press(s.out);
    shown(t, { state: "code" });
  }
});

test("prompts: their panel is the keys that work; text goes in as typed, prefixes and backslash included", async () => {
  const t = await open(undefined, { code: true });
  await t.press("\r"); // Enter: the severity first, then the comment
  expect(listing(entriesOf({ state: "prompt", kind: "severity" }))).toEqual(["Enter choose", "Esc cancel", "↑/↓ k/j severity"]);
  shown(t, { state: "prompt", kind: "severity" });
  await t.press("\r");
  expect(listing(entriesOf({ state: "prompt", kind: "finding" }))).toEqual(["Enter save", "ctrl-u clear line", "ctrl-w delete word", "Esc cancel", "ctrl-n new line"]);
  await t.press("one gv two\\ ?");
  expect(t.frame()).toContain("comment › one gv two\\ ?");
  shown(t, { state: "prompt", kind: "finding" }); // g, v, \ and ? did nothing but type
  await t.press("\x17"); // ctrl-w
  expect(t.frame()).toContain("comment › one gv two\\ ");
  await t.press("zzz\x15"); // ctrl-u
  expect(t.frame()).not.toContain("zzz");
  await t.press("x\r");
  expect(t.r.doc.human.comments.map((c) => c.text)).toEqual(["x"]);
  expect(listing(entriesOf({ state: "prompt", kind: "ask" }))[0]).toBe("Enter ask");
  expect(listing(entriesOf({ state: "prompt", kind: "reason" }))).toEqual(["Enter ignore", "ctrl-u clear line", "Esc cancel"]);
  expect(listing(entriesOf({ state: "prompt", kind: "comment", decide: true }))).toEqual(["Enter save", "ctrl-u clear line", "ctrl-w delete word", "Esc cancel", "ctrl-n new line"]);
});

test("the submit steps: each panel lists what acts there; the send step's checkbox keys only when it has a checkbox", () => {
  expect(listing(entriesOf({ state: "submit", step: "findings" }))).toEqual(["↓/↑ j/k finding", "Space tick", "a tick all", "Tab next step", "Esc leave"]);
  expect(listing(entriesOf({ state: "submit", step: "verdict" }))).toEqual(["↓/↑ j/k verdict", "Tab next step", "⇧Tab step back", "Esc leave"]);
  expect(listing(entriesOf({ state: "submit", step: "comment", typing: true }))).toEqual(["Enter new line", "ctrl-u clear line", "ctrl-w delete word", "Esc done typing", "Tab next step", "⇧Tab step back"]);
  expect(listing(entriesOf({ state: "submit", step: "comment", typing: false }))).toEqual(["Enter type", "Tab next step", "⇧Tab step back", "Esc leave", "v view…"]);
  expect(listing(entriesOf({ state: "submit", step: "comment", typing: false }, { prefix: "v" }))).toEqual(["e editor"]);
  expect(listing(entriesOf({ state: "submit", step: "send", dryRun: false, boxes: false }))).toEqual(["Enter send", "PgDn/PgUp ctrl-d/ctrl-u page", "⇧Tab step back", "Esc leave"]);
  expect(listing(entriesOf({ state: "submit", step: "send", dryRun: true, boxes: true }))).toEqual(["↓/↑ j/k checkbox", "Space tick", "Enter print the calls", "PgDn/PgUp ctrl-d/ctrl-u page", "⇧Tab step back", "Esc leave"]);
});

test("the bottom panel never covers the cursor line or the finding's box, and its text is all reachable, at any width or height", async () => {
  for (const [cols, rows] of [[140, 40], [100, 30], [90, 28], [80, 24], [60, 20], [100, 20]] as const) {
    const t = await open(undefined, { cols, rows });
    await t.press("gf"); // a finding box open under the cursor line, with its panel
    const f = t.frame();
    const at = `${cols}x${rows}`;
    expect(f, at).toContain("let answer = 42"); // the cursor line
    expect(f, at).toContain("Hard-coded answer in main");
    // The finding's whole text is in the content area; on a short screen the last of it is a page down.
    for (let i = 0; i < 3 && !t.frame().includes("42 appears with no source"); i++) await t.press(PGDN);
    expect(t.frame(), at).toContain("42 appears with no source");
    expect(f.split("\n").length, at).toBeLessThanOrEqual(rows);
    for (const line of f.split("\n")) expect([...line].length, at).toBeLessThanOrEqual(cols);
    await t.press("x");
    expect(t.frame(), at).toContain("let answer = 42");
    expect(t.frame().split("\n").length, at).toBeLessThanOrEqual(rows);
  }
});

test("the key panel at narrow widths: the grid drops the secondaries, then flows; every primary and label is still there", async () => {
  for (const [cols, rows] of [[90, 40], [80, 24], [60, 20]] as const) {
    const t = await open(undefined, { cols, rows, code: true });
    shown(t, { state: "code" });
    const p = panelAt(t, { state: "code" });
    if (p.fit !== "flow") for (const e of entriesOf({ state: "code" })) expect(t.frame(), `${cols}x${rows} ${e.label}`).toMatch(row(e.prim, e.label));
    for (const line of t.frame().split("\n")) expect([...line].length).toBeLessThanOrEqual(cols);
    expect(t.frame().split("\n").length).toBeLessThanOrEqual(rows);
  }
});

test("panelOf: the fewest columns that fit the height, secondaries dim; without them when too wide; flowing, then cut with …", () => {
  const e = (n: number, sec = ""): Entry[] => Array.from({ length: n }, (_, i) => ({ keys: [String.fromCharCode(97 + i), sec].filter(Boolean).join(" "), prim: String.fromCharCode(97 + i), sec, label: `act${i}` }));
  const one = panelOf("t", e(4, "x"), 40, 10);
  expect(one.fit).toBe("grid");
  expect(one.lines.map(plain)).toEqual(["a x  act0", "b x  act1", "c x  act2", "d x  act3"]);
  expect(one.lines[0]!.find((s) => s.text === " x")?.dim).toBe(true); // the secondary is drawn dim
  const two = panelOf("t", e(12), 40, 10); // 7 rows inside the border and title: two columns
  expect(two.fit).toBe("grid");
  expect(two.lines.length).toBe(7);
  expect(plain(two.lines[0]!)).toBe("a  act0  h  act7");
  const noSec = panelOf("t", e(12, "shift-x"), 30, 10); // with secondaries the two columns are wider than 26
  expect(noSec.fit).toBe("primaries");
  expect(noSec.lines.map(plain).join(" ")).not.toContain("shift-x");
  const flow = panelOf("t", e(20), 30, 6); // 3 rows: no grid fits, the entries flow
  expect(flow.fit).toBe("flow");
  expect(flow.lines.length).toBe(3);
  expect(plain(flow.lines[2]!)).toMatch(/…$/);
  for (const l of flow.lines) expect(plain(l).length).toBeLessThanOrEqual(26);
  expect(panelOf("t", [], 30, 6).lines).toEqual([]);
});

// ---------------------------------------------------------------- configurable bindings

test("remapped keys: the panel and the hints show the new keys, the new keys act and the old ones do not", async () => {
  installKeymap(effectiveKeys({ "finding.ignore": { primary: "d" }, "finding.close": { primary: "X" }, "go.next_finding": { primary: "n" }, "code.down": { secondary: "" }, "ai.info": { primary: "o" } }));
  try {
    const t = await open({ ...three, ...withSummary() }, { code: true });
    expect(t.frame()).toContain("Esc closes this; a o brings it back"); // the summary's hint names the key as bound now
    expect(t.frame()).toMatch(row("↓/↑ k", "line"));
    await t.press("j"); // the removed secondary does nothing
    expect(t.r.pos.line).toBe(0);
    await t.press(DOWN);
    expect(t.r.pos.line).toBe(1);
    await t.press("gf"); // the old second key is nothing now
    expect(t.frame()).not.toContain("critic · bug · high");
    await t.press("gn");
    expect(t.frame()).toContain("critic · bug · high");
    expect(listing(entriesOf({ state: "finding" })).slice(0, 5)).toEqual(["X close", "← h back", "b block", "c comment", "d ignore"]);
    shown(t, { state: "finding" });
    await t.press("i"); // the old key is nothing at all
    expect(t.frame()).not.toContain("private note ›");
    await t.press("d");
    expect(t.frame()).toContain("private note ›");
    await t.press(ESC);
    await t.press("x"); // and x no longer closes
    expect(t.frame()).toContain("critic · bug · high");
    await t.press("X");
    expect(t.frame()).not.toContain("critic · bug · high");
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
  const t = await open(undefined, { code: true });
  await t.press("?mark this finding as wrong\r");
  const f = t.frame();
  expect(f).toContain("Search the docs · mark this finding as wrong");
  expect(f).toMatch(/1\. ignore: i, in an open finding/);
  expect(f).toMatch(/[2-4]\. /); // several answers, not one
  expect(f).not.toMatch(/5\. /);
  expect(listing(entriesOf({ state: "content", results: true }))).toEqual(["↓/↑ j/k select", "PgDn/PgUp ctrl-d/ctrl-u page", "y copy", "Tab close", "v view…"]);
  shown(t, { state: "content", results: true }); // focus is in the results
  await t.press(ESC);
  expect(t.frame()).not.toContain("Search the docs ·");
  await t.press("\r");
  expect(t.frame()).toContain("pick its severity"); // back in the code: Enter is a new finding again
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

// ---------------------------------------------------------------- layout v2: the regions

/** The rows of a frame: the status area is the first four, the bottom panel and the footer the last ones. */
const regions = (t: Shown) => {
  const lines = t.frame().split("\n"), L = layoutOf(t.cols, t.rows - 1);
  return { status: lines.slice(0, 4).join("\n"), middle: lines.slice(4, 4 + L.middleH).join("\n"), bottom: lines.slice(4 + L.middleH, 4 + L.middleH + L.bottomH).join("\n"), footer: lines[4 + L.middleH + L.bottomH] ?? "" };
};

test("status area: the title on its own line, then separate labelled fields; the in-house suggestion only", async () => {
  const t = await open({ findings: [finding, f2, f3] }, { cols: 130, suggested: [{ by: "prview", verdict: "request_changes" }, { by: "imported", verdict: "approve" }] });
  const { status, middle } = regions(t);
  const [top, title, fields, bottom] = status.split("\n");
  expect(top).toMatch(/^┌─+┐$/);
  expect(title).toMatch(/^│ A change\s+│?$/);
  expect(fields).toContain("branches main ← x   read 1/2   findings ▲ 1 high · 1 medium · 1 low   filter all   comments 0   suggested Request changes");
  expect(fields).not.toContain("Approve");
  expect(bottom).toMatch(/^└─+┘$/);
  expect(middle).toContain("READ IN ORDER");
});

test("status fields (pure): a PR shows its number and commits, a range its branches; narrow widths drop whole fields in order", () => {
  const base: StatusInput = { label: "acme/app#1016", base: "a".repeat(40), head: "b".repeat(40), read: { seen: 1, total: 5 }, findings: { high: 2, medium: 1, low: 0 }, hidden: false, comments: 3, filter: "medium", suggested: "Comment" };
  const all = statusFields(base);
  expect(all.map((f) => `${f.label} ${f.value}`)).toEqual(["PR #1016", "commits aaaaaaa ← bbbbbbb", "read 1/5", "findings ▲ 2 high · 1 medium", "filter high and medium", "comments 3", "suggested Comment"]);
  expect(statusFields({ ...base, label: "main..feature", suggested: undefined }).map((f) => f.key)).toEqual(["branch", "read", "findings", "filter", "comments"]);
  expect(statusFields({ ...base, findings: { high: 0, medium: 0, low: 0 }, hidden: true }).find((f) => f.key === "findings")!.value).toBe("none · more hidden ▲?");
  const w = (fs: ReturnType<typeof statusFields>) => fs.map((f) => `${f.label} ${f.value}`).join("   ").length;
  expect(fitFields(all, 200)).toEqual(all);
  let prev = all.length;
  const dropped: string[] = [];
  for (let width = w(all); width > 0; width--) {
    const kept = fitFields(all, width);
    if (kept.length < prev) { dropped.push(...all.filter((f) => !kept.includes(f) && !dropped.includes(f.key)).map((f) => f.key)); prev = kept.length; }
    if (kept.length > 1) expect(w(kept)).toBeLessThanOrEqual(width); // whole fields only, never one cut to fit another
  }
  expect(dropped).toEqual([...DROP_ORDER]);
  expect(fitFields(all, 5).map((f) => f.key)).toEqual(["findings"]); // never dropped
});

test("bottom panel: the content area on the left and the key panel on the right share the same rows, under the code", async () => {
  for (const [cols, rows] of [[120, 32], [100, 28], [80, 24]] as const) {
    const t = await open(withSummary(), { cols, rows, code: true });
    const { middle, bottom } = regions(t);
    const at = `${cols}x${rows}`;
    expect(middle, at).toContain("let answer");
    expect(bottom, at).toContain("Summary of this change");
    const title = bottom.split("\n")[1]!;
    expect(title, at).toMatch(/Summary of this change.*keys/); // one row: content left, keys right
    expect(bottom.split("\n").length, at).toBe(layoutOf(cols, rows - 1).bottomH);
    shown(t, { state: "code" });
  }
});

test("content area: prompts, docs search, answers and the verdict show there, one at a time, not over the code", async () => {
  const t = await open(withSummary(), { code: true });
  await t.press("\r");
  expect(regions(t).bottom).toContain("New finding at src/a.rs:10 · pick its severity");
  expect(regions(t).bottom).not.toContain(SUMMARY); // one thing at a time
  await t.press(ESC);
  expect(regions(t).bottom).toContain(SUMMARY); // the prompt gone, what was there is back
  await t.press("?");
  expect(regions(t).bottom).toContain("search the docs ›");
  await t.press("mark this finding as wrong\r");
  expect(regions(t).bottom).toContain("Search the docs · mark this finding as wrong");
  expect(regions(t).bottom).toMatch(/1\. ignore: i/);
  await t.press(ESC + "gfi");
  expect(regions(t).bottom).toContain("ignore · private note ›");
  expect(regions(t).middle).toContain("╭ ▲ critic"); // the finding stays open on its line
  await t.press(ESC + ESC + "s");
  expect(regions(t).bottom).toContain("Submit · 1 Findings");
  expect(regions(t).middle).toContain("let answer");
});

test("finding: a short box on its line (header in its border, bold title, at most two lines of claim), the whole detail in the content area", async () => {
  const evidence = Array.from({ length: 6 }, (_, i) => `evidence-${i}`).join("\n");
  const claim = Array.from({ length: 30 }, (_, i) => `claimword${i}`).join(" ");
  const t = await open({ findings: [{ ...finding, claim, evidence, status: "upheld", refute: "It holds (cites n11)" }] });
  await t.press("gf");
  const { middle, bottom } = regions(t);
  const box = middle.split("\n").filter((l) => /[╭│╰]/.test(l.slice(34)));
  expect(middle).toMatch(/╭ ▲ critic · bug · high · block \(default\) ─+╮/); // source · kind · severity · action
  expect(middle).toContain("Hard-coded answer in main");
  expect(middle).toContain("claimword0");
  expect(middle).not.toContain("claimword29"); // two lines of the claim at most
  expect(middle).not.toContain("evidence-0"); // the evidence is not in the box
  expect(middle).not.toContain("Second look");
  expect(box.length).toBeLessThanOrEqual(5);
  // The content area has all of it: the claim, the evidence, the second look with its citations, and the action.
  const all = bottom + (await (async () => { await t.press(PGDN); return regions(t).bottom; })());
  expect(all).toContain("claimword29");
  for (let i = 0; i < 6; i++) expect(all).toContain(`evidence-${i}`);
  expect(all).toContain("Second look: It holds (cites n11)");
  expect(all).toContain("Action: block (default)");
});

test("v z hides the table of contents and gives the code its width; again brings it back", async () => {
  const t = await open(undefined, { code: true });
  const longs = () => (regions(t).middle.match(/long/g) ?? []).length;
  expect(regions(t).middle).toContain("READ IN ORDER");
  const before = longs();
  await t.press("vz");
  expect(regions(t).middle).not.toContain("READ IN ORDER");
  expect(regions(t).middle).not.toContain("Core change");
  expect(regions(t).middle).toContain("· zen");
  expect(longs()).toBeGreaterThan(before + 5); // the long line shows more of itself
  await t.press("j"); // the code's keys act as before
  expect(t.r.pos.line).toBe(1);
  await t.press("vz");
  expect(regions(t).middle).toContain("READ IN ORDER");
});

test("v c makes the content area full-screen: the arrows scroll it, Esc or v c restores it; with nothing there it says so", async () => {
  const long = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
  const t = await open(withSummary({ summary: long }), { cols: 120, rows: 32, code: true });
  await t.press("vc");
  const lines = t.frame().split("\n");
  expect(t.frame()).not.toContain("READ IN ORDER"); // no middle
  expect(t.frame()).not.toContain("let answer");
  expect(lines[4]).toMatch(/^┌/); // the content area starts right under the status area
  expect(t.frame()).toContain("line 20"); // far more of the text than the bottom panel holds
  expect(t.frame()).toContain("· focused");
  expect(regions(t).footer).toContain("v c or Esc restores the layout");
  shown(t, { state: "content" }, true);
  await t.press("jjj");
  expect(t.r.pos.line).toBe(0); // the arrows scroll the content, not the code
  expect(t.frame()).toMatch(/· 4-\d+\/\d+/);
  await t.press(ESC);
  expect(t.frame()).toContain("READ IN ORDER");
  expect(t.frame()).not.toContain("focused");
  await t.press("vc");
  expect(t.frame()).not.toContain("READ IN ORDER");
  await t.press("vc");
  expect(t.frame()).toContain("READ IN ORDER");
  await t.press(ESC + "vc"); // the summary closed: nothing to make full-screen
  expect(t.frame()).toContain("the content area is empty");
  expect(t.frame()).toContain("READ IN ORDER");
});

test("the submit flow's send step reads full-screen; Esc leaves with the code in view", async () => {
  const t = await open();
  await t.press("s");
  expect(t.frame()).toContain("READ IN ORDER"); // one finding: the checklist fits the content area
  await t.press(TAB + TAB + TAB);
  expect(t.frame()).not.toContain("READ IN ORDER");
  expect(t.frame()).toContain("4 Send");
  await t.press(ESC);
  expect(t.frame()).toContain("READ IN ORDER");
  expect(t.frame()).not.toContain("Submit ·");
});

test("the findings checklist goes full-screen when it needs the room, and keeps its cursor in view", async () => {
  const many = Array.from({ length: 40 }, (_, i): Finding => ({ ...finding, id: `m${i}`, title: `Finding number ${i}` }));
  const t = await open({ findings: many }, { rows: 32 });
  await t.press("s");
  expect(t.frame()).not.toContain("READ IN ORDER");
  await t.press("j".repeat(39));
  expect(t.frame()).toContain("Finding number 39");
  expect(t.frame()).not.toContain("Finding number 0 ");
});

test("smoke sizes: every region fits 120x32 and 100x28, in each state", async () => {
  for (const [cols, rows] of [[120, 32], [100, 28]] as const) {
    for (const keys of ["", "gf", TAB, "vc", "g", "\r", "?mark this finding as wrong\r", "s", "s" + TAB, "s" + TAB + TAB, "s" + TAB + TAB + TAB]) {
      const t = await open(withSummary(), { cols, rows });
      await t.press(keys);
      const f = t.frame(), at = `${cols}x${rows} ${JSON.stringify(keys)}`;
      expect(f.split("\n").length, at).toBeLessThanOrEqual(rows);
      for (const l of f.split("\n")) expect([...l].length, at).toBeLessThanOrEqual(cols);
      expect(regions(t).status, at).toContain("A change");
    }
  }
});

// ---- f h / f m / f a: the severity filter
const mixed = () => {
  const warn: Finding = { ...finding, id: "w", line: 12, severity: "medium", title: "A warning" };
  const nit: Finding = { ...finding, id: "n", hunk: h2!.id, line: 2, severity: "low", title: "A nit" };
  return [finding, warn, nit];
};

test("filter: f h leaves only high findings on the gutter, the rail and the counts; f a brings them back; the status shows the level", async () => {
  const t = await open({ findings: mixed() }, { code: true });
  expect(t.frame()).toContain("filter all");
  expect(t.frame()).toContain("findings ▲ 1 high · 1 medium · 1 low");
  await t.press("fm");
  expect(t.frame()).toContain("filter high and medium");
  expect(t.frame()).toContain("findings ▲ 1 high · 1 medium");
  expect(t.frame()).not.toContain("1 low");
  expect(regions(t).middle).not.toContain("b.ts:1 ▲"); // the nit's block has no mark
  await t.press("fh");
  expect(t.frame()).toContain("filter high only");
  expect(t.frame()).toContain("findings ▲ 1 high");
  expect(t.frame()).not.toContain("1 medium");
  const gutter = regions(t).middle.split("\n").filter((l) => l.includes("▲"));
  expect(gutter.some((l) => /1 Core change ▲1/.test(l))).toBe(true);
  // the medium finding sat on line 12; its mark is gone, the high one's on line 11 stays
  expect(regions(t).middle).toMatch(/11 ▲ \+let answer/);
  expect(regions(t).middle).not.toMatch(/12 ▲/);
  await t.press("fa");
  expect(t.frame()).toContain("filter all");
  expect(t.frame()).toMatch(/12 ▲ \+new2/);
});

test("filter: a filtered-out finding cannot be reached with g f or g h, and an open one closes when the filter hides it", async () => {
  const t = await open({ findings: mixed() }, { code: true });
  await t.press("fh");
  for (let i = 0; i < 3; i++) { await t.press("gf"); expect(t.frame()).toContain("Hard-coded answer in main"); expect(t.frame()).not.toContain("A warning"); expect(t.frame()).not.toContain("A nit"); }
  await t.press("gh");
  expect(t.frame()).toContain("Hard-coded answer in main");
  // open the medium one, then filter to high: it closes
  await t.press("x" + "fa" + "gh" + "gh");
  expect(t.frame()).toContain("A warning");
  await t.press("fh");
  expect(t.frame()).not.toContain("A warning");
  await t.press("fm");
  await t.press("fa");
  // nothing matches: a clear note
  const none = await open({ findings: [mixed()[2]!] });
  await none.press("fh");
  await none.press("gf");
  expect(none.frame()).toContain("There are no findings to go to.");
  expect(none.frame()).toContain("high only");
});

test("filter: the level is kept with the stored review, not in the document, and comes back when it is opened again", async () => {
  const t = await open({ findings: mixed() });
  Object.assign(t.r.doc.target, { base: "a".repeat(40), head: "b".repeat(40) }); // a stored review has real commit ids
  await t.press("fh");
  expect(t.r.filter).toBe("high");
  expect(JSON.stringify(t.r.doc)).not.toContain("filter");
  const back = (await import("../src/build.ts")).load(t.r.slug);
  expect(back.filter).toBe("high");
  expect(JSON.stringify(back.doc)).not.toContain("\"filter\"");
  const again = render(<App review={back} files={files} onDone={() => {}} size={{ cols: 120, rows: 40 }} />);
  await settle();
  expect((again.lastFrame() ?? "").replace(/\x1b\[[0-9;]*m/g, "")).toContain("filter high only");
  await t.press("fa");
  expect(t.r.filter).toBeUndefined();
});

test("filter: the submit checklist still lists every finding and says a filter is active; the implied verdict ignores the filter", async () => {
  const t = await open({ findings: mixed() });
  await t.press("fh" + "s");
  const f = t.frame();
  expect(f).toContain("[x] high · block (default) · src/a.rs:11 · Hard-coded answer in main");
  expect(f).toContain("[x] medium · comment (default) · src/a.rs:12 · A warning");
  expect(f).toContain("[x] low · comment (default) · src/b.ts:2 · A nit");
  expect(f).toContain("The filter (high only) is only for reading");
  await t.press(" " + TAB); // untick the high one: the hidden medium and low still imply a comment
  expect(t.frame()).toContain("(•) Comment");
  const all = await open({ findings: mixed() });
  await all.press("s");
  expect(all.frame()).not.toContain("is only for reading");
});
