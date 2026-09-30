// Moving around the review: pure, so the keys can be tested without a screen.

import type { Hunk } from "./diff.ts";
import { RANK, type Finding } from "./guide.ts";

export type NavItem = { id: string; path: string; hunk: Hunk; chapter: number };
export type At = { item: number; line: number };

/** `123G`: the cursor goes to file line 123 of the file under the cursor, switching hunks if it lives in another one. */
export function gotoLine(items: NavItem[], current: number, n: number): At | undefined {
  const path = items[current]?.path;
  if (!path) return undefined;
  const mine = items.map((it, i) => ({ it, i })).filter(({ it }) => it.path === path);
  for (const { it, i } of mine) {
    const line = it.hunk.lines.findIndex((l) => l.n === n);
    if (line >= 0) return { item: i, line };
  }
  // Not in any hunk: the closest hunk of the file, at its nearest edge.
  let best: { at: At; d: number } | undefined;
  for (const { it, i } of mine) {
    const first = it.hunk.newStart, last = it.hunk.newStart + Math.max(0, it.hunk.newCount - 1);
    const d = n < first ? first - n : n > last ? n - last : 0;
    if (!best || d < best.d) best = { d, at: { item: i, line: n < first ? 0 : it.hunk.lines.length - 1 } };
  }
  return best?.at;
}

const lineOf = (h: Hunk, f: Finding) => h.lines.findIndex((l) => f.side === "new" ? l.n !== null && l.n === f.line : l.o !== null && l.o === f.line);

/** Every finding's place in reading order, across hunks and chapters; ties on one line keep the document's order. */
export function spotsOf(items: NavItem[], findings: Finding[]): (At & { finding: Finding })[] {
  return items.flatMap((it, item) =>
    findings.map((f, k) => ({ f, k })).filter(({ f }) => f.hunk === it.id).map(({ f, k }) => ({ item, line: Math.max(0, lineOf(it.hunk, f)), finding: f, k })),
  ).sort((a, b) => a.item - b.item || a.line - b.line || a.k - b.k).map(({ item, line, finding }) => ({ item, line, finding }));
}

/** The next or previous finding in reading order, across hunks and chapters; none past either end. */
export function nextFinding(items: NavItem[], findings: Finding[], from: At, dir: 1 | -1): (At & { finding: Finding }) | undefined {
  const spots = spotsOf(items, findings);
  const after = (s: At) => s.item > from.item || (s.item === from.item && s.line > from.line);
  const before = (s: At) => s.item < from.item || (s.item === from.item && s.line < from.line);
  return dir > 0 ? spots.find(after) : [...spots].reverse().find(before);
}

/**
 * `g h` / `g H` (most serious first, guide.ts's RANK): every high finding in reading order, then the medium ones, then the low ones, wrapping round. From the
 * open finding (`current`) it steps along that order; with none open it starts at the most serious (or, backwards, the least).
 */
export function nextBySeverity(items: NavItem[], findings: Finding[], current: string | undefined, dir: 1 | -1): (At & { finding: Finding }) | undefined {
  const order = spotsOf(items, findings).map((s, i) => ({ s, i })).sort((a, b) => RANK[a.s.finding.severity] - RANK[b.s.finding.severity] || a.i - b.i).map(({ s }) => s);
  if (!order.length) return undefined;
  const at = current ? order.findIndex((s) => s.finding.id === current) : -1;
  if (at < 0) return dir > 0 ? order[0] : order[order.length - 1];
  return order[(at + dir + order.length) % order.length];
}

/** `g f` / `g F`: the next or previous finding in reading order, wrapping round at either end. */
export function nextFindingWrapping(items: NavItem[], findings: Finding[], from: At, dir: 1 | -1): (At & { finding: Finding }) | undefined {
  const spots = spotsOf(items, findings);
  return nextFinding(items, findings, from, dir) ?? (dir > 0 ? spots[0] : spots[spots.length - 1]);
}

/** `g g` / `g e`: the first line of this file's first block, or the last line of its last block, by line number. */
export function fileEdge(items: NavItem[], current: number, edge: "top" | "end"): At | undefined {
  const path = items[current]?.path;
  const mine = items.map((it, i) => ({ it, i })).filter(({ it }) => it.path === path);
  if (!mine.length) return undefined;
  const pick = mine.reduce((a, b) => (edge === "top" ? b.it.hunk.newStart < a.it.hunk.newStart : b.it.hunk.newStart > a.it.hunk.newStart) ? b : a);
  return { item: pick.i, line: edge === "top" ? 0 : Math.max(0, pick.it.hunk.lines.length - 1) };
}

/** `g c <n> Enter`: chapter n's first block (chapters count from 1; the mechanical group is the one after the last). */
export function chapterStart(items: NavItem[], n: number): At | undefined {
  const i = items.findIndex((it) => it.chapter === n - 1);
  return i < 0 ? undefined : { item: i, line: 0 };
}

// ---------------------------------------------------------------- the table of contents

/**
 * Where the table of contents' cursor is: on block `item`, or (`onChapter`) on the row of the chapter holding it, and
 * then `item` is that chapter's first block, which is what the code shows meanwhile.
 */
export type TocAt = { item: number; onChapter: boolean };
/** A row the table of contents draws: every chapter's own row, then its blocks while it is expanded. `item` is the block, or the chapter's first. */
export type TocRow = { kind: "chapter" | "block"; chapter: number; item: number };
export type TocMove = "down" | "up" | "next_chapter" | "prev_chapter" | "expand" | "collapse";

export function tocRows(items: NavItem[], collapsed: ReadonlySet<number>): TocRow[] {
  const rows: TocRow[] = [];
  items.forEach((it, i) => {
    if (i === 0 || items[i - 1]!.chapter !== it.chapter) rows.push({ kind: "chapter", chapter: it.chapter, item: i });
    if (!collapsed.has(it.chapter)) rows.push({ kind: "block", chapter: it.chapter, item: i });
  });
  return rows;
}

/** The row the cursor is on; a block of a collapsed chapter (the code got there some other way) is its chapter's row. */
export function tocIndex(rows: TocRow[], items: NavItem[], at: TocAt): number {
  const chapter = items[at.item]?.chapter;
  const block = at.onChapter ? -1 : rows.findIndex((r) => r.kind === "block" && r.item === at.item);
  return block >= 0 ? block : rows.findIndex((r) => r.kind === "chapter" && r.chapter === chapter);
}

/**
 * One key in the table of contents. ↓/↑ go block to block, and a collapsed chapter is one stop (its blocks are
 * skipped); ⇧↓/⇧↑ go to the next or previous chapter's row. → expands a collapsed chapter, goes down from an
 * expanded one to its first block, and on a block `enter`s its code; ← collapses an expanded chapter, and on a block
 * goes up to its chapter's row. Nowhere to go leaves the cursor where it is.
 */
export function tocMove(items: NavItem[], collapsed: ReadonlySet<number>, at: TocAt, move: TocMove): { at: TocAt; collapsed: ReadonlySet<number>; enter?: true } {
  const rows = tocRows(items, collapsed);
  const i = tocIndex(rows, items, at);
  const row = rows[i];
  const stay = { at, collapsed };
  if (!row) return stay;
  const to = (r: TocRow | undefined) => (r ? { at: { item: r.item, onChapter: r.kind === "chapter" }, collapsed } : stay);
  const toggled = (c: number, fold: boolean) => { const s = new Set(collapsed); if (fold) s.add(c); else s.delete(c); return s; };
  switch (move) {
    case "down": case "up": {
      const stop = (r: TocRow) => r.kind === "block" || collapsed.has(r.chapter);
      return to(move === "down" ? rows.slice(i + 1).find(stop) : rows.slice(0, i).reverse().find(stop));
    }
    case "next_chapter": return to(rows.find((r) => r.kind === "chapter" && r.chapter > row.chapter));
    case "prev_chapter": return to(rows.filter((r) => r.kind === "chapter" && r.chapter < row.chapter).pop());
    case "expand":
      if (row.kind === "block") return { ...stay, enter: true };
      if (collapsed.has(row.chapter)) return { at: { item: row.item, onChapter: true }, collapsed: toggled(row.chapter, false) };
      return to(rows[i + 1]);
    case "collapse":
      if (row.kind === "block") return to(rows.find((r) => r.kind === "chapter" && r.chapter === row.chapter));
      return collapsed.has(row.chapter) ? stay : { at: { item: row.item, onChapter: true }, collapsed: toggled(row.chapter, true) };
  }
}
