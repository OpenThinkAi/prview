// Moving around the review: pure, so the keys can be tested without a screen.

import type { Hunk } from "./diff.ts";
import type { Finding } from "./guide.ts";

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

/** Most serious first: what "by severity" walks through. */
const RANK = { blocking: 0, warn: 1, nit: 2 } as const;

/**
 * `g h` / `g H`: every blocking finding in reading order, then the warnings, then the nits, wrapping round. From the
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
