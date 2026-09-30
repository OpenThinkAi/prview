// The key panel's shape: which entries a state lists, and how they lay out in the room there is. Pure, so a narrow
// terminal and a short one are tested without drawing anything. The entries come from the action tables in keys.ts
// (through `rowsOf`, which reads the installed keymap), never from a list of their own.

import { groups, rowsOf, type KeyState } from "./keys.ts";

export type Entry = { keys: string; label: string };

/** What a state lists, in table order; rows with the same label share an entry (j/k line). */
export const entriesOf = (s: KeyState): Entry[] => groups(rowsOf(s)).map((g) => ({ keys: g.map((r) => r.key).join("/"), label: g[0]!.label }));

const TITLES: Record<string, string> = { finding: "finding", info: "box", results: "ask the docs", verdict: "verdict", preview: "submit" };
export const panelTitle = (s: KeyState): string =>
  s.box === null ? "keys" : s.box === "prompt" ? (s.kind === "reason" ? "not an issue" : s.kind === "docs" ? "ask the docs" : s.kind) : TITLES[s.box]!;

/**
 * A bordered grid (`boxed`) of `lines`, or, when even the widest grid the width allows is too tall, one dim line cut
 * with `…`. `height` counts the border and title. The grid uses the fewest columns that fit the height, so a short
 * list is one tidy column and a long one (navigation) spreads sideways instead of down.
 */
export type PanelShape = { boxed: boolean; title: string; lines: string[]; width: number; height: number };

/** Most rows the panel may take: a third of the screen, and never so many that a box and the code lose their room (18 rows stay for them, or the panel is one line). */
export const panelCap = (rows: number) => Math.max(1, Math.min(Math.floor(rows / 3), rows - 18));

export function panelOf(title: string, entries: Entry[], cols: number, rows: number): PanelShape {
  const keyW = Math.max(0, ...entries.map((e) => e.keys.length));
  const cell = (e: Entry) => `${e.keys.padEnd(keyW)}  ${e.label}`;
  const inner = panelCap(rows) - 3; // border twice and the title
  if (inner >= 1) {
    for (let n = 1; n <= entries.length; n++) {
      const per = Math.ceil(entries.length / n);
      if (per > inner) continue;
      const cols_ = Array.from({ length: Math.ceil(entries.length / per) }, (_, c) => entries.slice(c * per, (c + 1) * per).map(cell));
      const widths = cols_.map((c) => Math.max(...c.map((t) => t.length)));
      const width = widths.reduce((a, b) => a + b, 0) + 3 * (cols_.length - 1) + 4; // gaps, then border and padding each side
      if (width > cols) continue;
      const lines = Array.from({ length: per }, (_, r) => cols_.map((c, i) => (c[r] ?? "").padEnd(widths[i]!)).join("   ").trimEnd());
      return { boxed: true, title, lines, width, height: per + 3 };
    }
  }
  const text = entries.map((e) => `${e.keys} ${e.label}`).join("  ");
  const room = Math.max(1, cols - 1);
  return { boxed: false, title, lines: [text.length > room ? text.slice(0, room - 1) + "…" : text], width: Math.min(text.length, room), height: 1 };
}
