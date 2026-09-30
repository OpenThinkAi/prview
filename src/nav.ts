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

/** `]f` / `[f`: the next or previous finding in reading order, across hunks and chapters. */
export function nextFinding(items: NavItem[], findings: Finding[], from: At, dir: 1 | -1): (At & { finding: Finding }) | undefined {
  const spots = items.flatMap((it, item) =>
    findings.filter((f) => f.hunk === it.id).map((f) => ({ item, line: Math.max(0, lineOf(it.hunk, f)), finding: f })),
  ).sort((a, b) => a.item - b.item || a.line - b.line || a.finding.id - b.finding.id);
  const after = (s: At) => s.item > from.item || (s.item === from.item && s.line > from.line);
  const before = (s: At) => s.item < from.item || (s.item === from.item && s.line < from.line);
  return dir > 0 ? spots.find(after) : [...spots].reverse().find(before);
}
