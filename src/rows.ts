// The rows of a block and your own findings, pure. Each file's diff starts and ends with a "whole file" row: a row of
// its own, before the first line of the file's first block and after the last line of its last block, where Enter
// writes a finding about the file instead of a line. The cursor's `line` counts from 0 at a block's first diff line;
// -1 is the row that starts the file (only on the file's first block) and `lines.length` the row that ends it.

import type { NavItem, At } from "./nav.ts";
import { clip, type Finding, type Severity } from "./guide.ts";
import { decide, defaultAction, type Defaults, DEFAULTS } from "./triage.ts";
import type { Human } from "./document.ts";

/** The block of a file that starts (by line number) or ends it: the first one wins a tie. */
export function edgeItem(items: NavItem[], current: number, edge: "top" | "end"): number | undefined {
  const path = items[current]?.path;
  const mine = items.map((it, i) => ({ it, i })).filter(({ it }) => it.path === path);
  if (!mine.length) return undefined;
  return mine.reduce((a, b) => (edge === "top" ? b.it.hunk.newStart < a.it.hunk.newStart : b.it.hunk.newStart > a.it.hunk.newStart) ? b : a).i;
}

/** Whether block `i` carries its file's starting row and its ending row. */
export const edgesOf = (items: NavItem[], i: number): { top: boolean; end: boolean } => ({ top: edgeItem(items, i, "top") === i, end: edgeItem(items, i, "end") === i });

/** The lowest and highest cursor line of block `i`: the whole-file rows included where it has them. */
export function lineRange(items: NavItem[], i: number): { min: number; max: number } {
  const e = edgesOf(items, i), n = items[i]?.hunk.lines.length ?? 0;
  return { min: e.top ? -1 : 0, max: e.end ? n : Math.max(0, n - 1) };
}

export const clampLine = (items: NavItem[], at: At): number => { const r = lineRange(items, at.item); return Math.max(r.min, Math.min(r.max, at.line)); };

/** One row down or up, running on into the next block in reading order (and onto its whole-file row when it has one). */
export function stepLine(items: NavItem[], at: At, dir: 1 | -1): At | undefined {
  const r = lineRange(items, at.item), next = at.line + dir;
  if (next >= r.min && next <= r.max) return { item: at.item, line: next };
  const i = at.item + dir;
  if (i < 0 || i >= items.length) return undefined;
  const to = lineRange(items, i);
  return { item: i, line: dir > 0 ? to.min : to.max };
}

// ---------------------------------------------------------------- your own findings

export const SEVERITIES: readonly Severity[] = ["high", "medium", "low"];
/** Where a new finding goes: a line of a block, or (`file`) a file's starting row (`start`) or ending row. */
export type Spot = { hunk: string; side: "new" | "old"; line: number } | { hunk: string; file: "start" | "end" };

/** Which row the cursor is on in block `i`: a line, or one of the file's two rows. */
export const rowKind = (items: NavItem[], at: At): "line" | "start" | "end" => {
  const n = items[at.item]?.hunk.lines.length ?? 0;
  return at.line < 0 ? "start" : at.line >= n && edgesOf(items, at.item).end ? "end" : "line";
};

const freshId = (findings: Finding[]) => {
  const taken = new Set(findings.map((f) => f.id));
  let n = findings.filter((f) => f.source === "you").length + 1;
  while (taken.has(`you-${n}`)) n++;
  return `you-${n}`;
};

/**
 * Your own finding: a finding of source `you` with the words you wrote as its claim, made with the default action for its
 * severity, which is carried out as your comment with exactly those words (so it posts, and b/c/i change it like any
 * finding's). A file-level one is anchored to the file (`file`), on the row where you wrote it (line 0 starts the file's
 * diff, 1 ends it). The claim is cut to the schema's length; your comment keeps every word.
 */
export function ownFinding(findings: Finding[], h: Human, spot: Spot, severity: Severity, text: string, at: string, defaults: Defaults = DEFAULTS): { finding: Finding; human: Human } {
  const words = text.trim();
  if (!words) throw new Error("a finding needs its comment");
  const finding: Finding = {
    id: freshId(findings), source: "you", hunk: spot.hunk, kind: "finding", severity, claim: clip(words, 300), evidence: "", status: "unrefuted",
    ...("file" in spot ? { side: "new" as const, line: spot.file === "end" ? 1 : 0, file: true as const } : { side: spot.side, line: spot.line }),
  };
  const kind = defaultAction(finding, defaults);
  // A default of ignore means it stays on its default: nothing is posted until you pick block or comment.
  return { finding, human: kind === "ignore" ? h : decide(h, finding, kind, { text: words, at }) };
}

/** The typed text as rows `width` wide, a newline starting a new row, at least one row; the cursor is at the end of the last. */
export function inputLines(text: string, width: number): string[] {
  const w = Math.max(1, width), out: string[] = [];
  for (const para of text.split("\n")) {
    const cs = [...para];
    if (!cs.length) { out.push(""); continue; }
    for (let i = 0; i < cs.length; i += w) out.push(cs.slice(i, i + w).join(""));
  }
  return out.length ? out : [""];
}
