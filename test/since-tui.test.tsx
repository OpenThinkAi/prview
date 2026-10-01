import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { cleanup, render } from "ink-testing-library";
import { inkTestHooks } from "./ink-hooks.ts";
import { parseDiff } from "../src/diff.ts";
import { hunksOf, type Finding } from "../src/guide.ts";
import type { Review } from "../src/build.ts";
import type { Doc } from "../src/document.ts";
import { App } from "../src/tui.tsx";
import { entriesOf, panelTitle } from "../src/panel.ts";
import type { Since } from "../src/since.ts";

// The re-review layer on screen (AGT-1512): blocks changed since your review marked ● in the table of contents and the
// gutter, `v s` showing only those, and the status area saying which review this follows.
let tmp = "", saved: string | undefined;
beforeAll(() => { saved = process.env.PRVIEW_HOME; tmp = mkdtempSync(join(tmpdir(), "prview-since-tui-")); process.env.PRVIEW_HOME = tmp; });
inkTestHooks();
afterAll(() => { cleanup(); rmSync(tmp, { recursive: true, force: true }); if (saved === undefined) delete process.env.PRVIEW_HOME; else process.env.PRVIEW_HOME = saved; });

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1..2 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -2,3 +2,3 @@
 l2
-l3
+read before
 l4
@@ -20,3 +20,3 @@
 l20
-l21
+changed since
 l22
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
const [h1, h2, h3] = hunksOf(files);
const HEAD = "abc1234def5678900000000000000000000000000";
const SINCE: Since = { head: HEAD, at: "2026-09-30T10:00:00.000Z", files: [{ path: "src/a.ts", status: "modified", hunks: [{ oldStart: 21, oldCount: 1, newStart: 21, newCount: 1 }] }] };
const before: Finding = { id: "f1", source: "critic", hunk: h1!.id, side: "new", line: 3, severity: "high", kind: "bug", title: "Read before", claim: "was there last time", evidence: "", status: "upheld" };
const after: Finding = { id: "f2", source: "critic", hunk: h2!.id, side: "new", line: 21, severity: "medium", kind: "bug", title: "New since", claim: "came with the push", evidence: "", status: "upheld" };

function fixture(since?: Since): Review {
  const doc: Doc = {
    schema: "prview-review/1",
    target: { repo: "/nowhere", base: "a", head: "b", title: "A change", body: "", label: "main..x" },
    plan: { summary: "", by: "guide", mechanical: [], chapters: [
      { title: "First", intent: "i1", why: "w1", hunks: [h1!.id, h2!.id] },
      { title: "Second", intent: "i2", why: "w2", hunks: [h3!.id] },
    ] },
    findings: [before, after], human: { comments: [], visited: [] },
  };
  return { slug: "since-tui", repo: "/nowhere", worktree: "/nowhere", context: 3, created: "now", pos: { item: 0, line: 0 }, doc, ...(since ? { since } : {}) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = async (app: { lastFrame(): string | undefined }) => {
  await sleep(30);
  let prev = app.lastFrame();
  for (let i = 0; i < 50; i++) { await sleep(20); const f = app.lastFrame(); if (f === prev) return; prev = f; }
};
const KEY = /\x1b\[[0-9;]*[A-Za-z~]|./gsu;
const DOWN = "\x1b[B", RIGHT = "\x1b[C";
async function open(since?: Since) {
  const r = fixture(since);
  const app = render(<App review={r} files={files} onDone={() => {}} copier={() => ({ ok: true as const, chars: 0, via: "test" })} size={{ cols: 120, rows: 40 }} />);
  await settle(app);
  const press = async (keys: string) => { for (const k of keys.match(KEY) ?? []) { app.stdin.write(k); await settle(app); } };
  return { r, app, press, frame: () => (app.lastFrame() ?? "").replace(/\x1b\[[0-9;]*m/g, "") };
}
const rail = (frame: string) => frame.split("\n").map((l) => l.split("│")[0]!).join("\n");

test("a re-review: the status says since which head, the opening says what changed, ● marks the changed block in the rail and the gutter", async () => {
  const t = await open(SINCE);
  expect(t.frame()).toContain("re-review · since abc1234 2026-09-30");
  expect(t.frame()).toContain("view whole PR");
  expect(t.frame()).toContain("Re-review: you last submitted on this at abc1234 2026-09-30. 1 block");
  expect(t.frame()).toContain("shows only those.");
  // The rail: the chapter counts its changed blocks; only a.ts:20's block is marked.
  expect(t.frame()).toMatch(/1 First.*●1/);
  expect(t.frame()).toMatch(/a\.ts:20 ▲ ●/);
  expect(t.frame()).not.toMatch(/a\.ts:2 .*●/);
  expect(t.frame()).not.toMatch(/2 Second.*●/);
  // The gutter: in the changed block, the line that changed since (21) is marked; its neighbours are not.
  await t.press(DOWN); await t.press(RIGHT);
  expect(t.frame()).toMatch(/ 21●▲ \+changed since/);
  expect(t.frame()).toMatch(/ 20 {4}l20/);
  // The v prefix lists the toggle here, and nowhere else.
  expect(entriesOf({ state: "code", since: true }, { prefix: "v" }).map((e) => e.label)).toContain("since your review");
  expect(entriesOf({ state: "code" }, { prefix: "v" }).map((e) => e.label)).not.toContain("since your review");
  expect(panelTitle({ state: "code", since: true }, { prefix: "v" })).toBe("v view");
});

test("v s: only the changed blocks, kept with the review; navigation and g f stay inside them; v s again is the whole PR", async () => {
  const t = await open(SINCE);
  await t.press("vs");
  expect(t.r.sinceOnly).toBe(true);
  expect(t.frame()).toContain("view since review");
  expect(t.frame()).toContain("since your review: 1 block changed since abc1234 2026-09-30");
  // The rail holds only the changed block; the second chapter, with none, is gone.
  expect(rail(t.frame())).toContain("a.ts:20");
  expect(rail(t.frame())).not.toContain("a.ts:2 ");
  expect(rail(t.frame())).not.toContain("Second");
  // The cursor was on a.ts:2 (not changed): it went to the next changed block. ↓ has nowhere further to go.
  expect(t.frame()).toContain("src/a.ts · lines 20–22 · 1/1");
  await t.press(DOWN);
  expect(t.frame()).toContain("1/1");
  // g f finds only the finding in a shown block, wrapping onto itself.
  await t.press("gf");
  expect(t.frame()).toContain("New since");
  await t.press("gf");
  expect(t.frame()).toContain("New since");
  expect(t.frame()).not.toContain("Read before");
  // Back to the whole PR, the cursor still on its block.
  await t.press("\x1b"); await t.press("vs");
  expect(t.r.sinceOnly).toBeUndefined();
  expect(t.frame()).toContain("view whole PR");
  expect(t.frame()).toContain("src/a.ts · lines 20–22 · 2/3");
  // The reading progress is the whole PR's either way.
  expect(t.frame()).toMatch(/read \d\/3/);
});

test("the toggle is restored with the review; a re-review whose head is gone has no view and no v s; a review that is no re-review has neither", async () => {
  const r = fixture(SINCE);
  r.sinceOnly = true;
  const app = render(<App review={r} files={files} onDone={() => {}} size={{ cols: 120, rows: 40 }} />);
  await settle(app);
  expect((app.lastFrame() ?? "").replace(/\x1b\[[0-9;]*m/g, "")).toContain("view since review");
  app.unmount();

  const gone = await open({ head: HEAD, at: "2026-09-30T10:00:00.000Z", gone: true });
  expect(gone.frame()).toContain("re-review · since abc1234 2026-09-30");
  expect(gone.frame()).not.toContain("view whole PR");
  expect(gone.frame()).toContain("2026-09-30. Your earlier");
  expect(gone.frame()).toContain("head is gone; showing the whole PR.");
  await gone.press("vs");
  expect(gone.r.sinceOnly).toBeUndefined();
  expect(gone.frame()).not.toContain("●");

  const plain = await open();
  expect(plain.frame()).not.toContain("re-review");
  await plain.press("vs");
  expect(plain.r.sinceOnly).toBeUndefined();
});
