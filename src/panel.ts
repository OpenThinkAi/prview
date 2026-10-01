// The key panel's shape: which entries a state lists, and how they lay out in the room there is. Pure, so a narrow
// terminal and a short one are tested without drawing anything. The entries come from the action tables in keys.ts
// (through `rowsOf`, which reads the installed keymap), never from a list of their own.
//
// The panel sits at the right of the bottom panel, beside the content area, at a fixed height. It lays its entries
// out as a grid of as few columns as fit that height; when the grid is too wide it drops the secondary keys (the
// primaries still name every action), and when even that is too wide it flows the entries along the rows.

import type { Pending } from "./chord.ts";
import { groups, PREFIXES, prefixesOf, prefixRows, rowsOf, showKey, type Action, type KeyState } from "./keys.ts";

/** `keys` is how a listing reads (`↓/↑ j/k`); `prim` and `sec` are its two halves, the secondary drawn dim. */
export type Entry = { keys: string; prim: string; sec: string; label: string };

const entry = (prim: string, sec: string, label: string): Entry => ({ keys: [prim, sec].filter(Boolean).join(" "), prim, sec, label });

/** A group's keys: the primaries, then the secondaries: `↓/↑ j/k`. */
const keysOfGroup = (g: Action[]): Entry => {
  const prim = g.map((r) => (r.key ? showKey(r.key) : "")).filter(Boolean), sec = g.map((r) => (r.secondary ? showKey(r.secondary) : "")).filter(Boolean);
  return entry(prim.join("/"), sec.join("/"), g[0]!.label);
};

/**
 * What a state lists, in table order; rows with the same label share an entry (↓/↑ j/k line), then one entry per prefix
 * (`g go to…`). While a prefix is pending, its second keys instead; while a number is typed after g, how to finish it.
 */
export function entriesOf(s: KeyState, pending: Pending | null = null): Entry[] {
  if (pending?.digits !== undefined) return [entry("0-9", "", pending.chapter ? "chapter number" : "line number"), entry("Enter", "", "go"), entry("Esc", "", "cancel")];
  if (pending) return groups(prefixRows(s, pending.prefix)).map((g) => g[0]!.id === "go.line" ? entry("0-9", "", g[0]!.label) : keysOfGroup(g));
  return [...groups(rowsOf(s)).map(keysOfGroup), ...prefixesOf(s).map((p) => entry(p, "", `${PREFIXES[p]}…`))];
}

const TITLES: Record<string, string> = { toc: "contents", code: "keys", finding: "finding", content: "content", settings: "settings" };
export const panelTitle = (s: KeyState, pending: Pending | null = null): string =>
  pending ? `${pending.prefix} ${PREFIXES[pending.prefix]}`
  : s.state === "prompt" ? (s.kind === "reason" ? "ignore" : s.kind === "docs" ? "search the docs" : s.kind === "finding" ? "new finding" : s.kind)
  : s.state === "submit" ? (s.step === "verdict" ? "verdict" : "submit")
  : s.state === "content" && s.results ? "search the docs" : TITLES[s.state]!;

/** A run of text in a panel line; `dim` for a secondary key. */
export type Seg = { text: string; dim?: boolean };
/**
 * The panel's lines inside its border, `width` by `height` with border and title. `fit` says how the entries were
 * laid out: `grid` in full, `primaries` a grid without the secondary keys, `flow` along the rows (cut with `…` if even
 * that does not fit).
 */
export type PanelShape = { title: string; lines: Seg[][]; width: number; height: number; fit: "grid" | "primaries" | "flow" };

/** A panel line as plain text, as it reads on the screen. */
export const plain = (line: Seg[]): string => line.map((s) => s.text).join("");
const len = (s: string) => [...s].length;
const pad = (n: number): Seg[] => (n > 0 ? [{ text: " ".repeat(n) }] : []);
const COL_GAP = 2;

export function panelOf(title: string, entries: Entry[], width: number, height: number): PanelShape {
  const inner = Math.max(1, height - 3), innerW = Math.max(1, width - 4); // border twice and the title; border and padding each side
  const shape = (lines: Seg[][], fit: PanelShape["fit"]): PanelShape => ({ title, lines, width, height, fit });
  if (!entries.length) return shape([], "grid");
  for (const withSec of [true, false]) {
    const keysW = (e: Entry) => len(e.prim) + (withSec && e.sec ? 1 + len(e.sec) : 0);
    const per = Math.max(1, Math.min(inner, entries.length)), n = Math.ceil(entries.length / per);
    const cols = Array.from({ length: n }, (_, c) => entries.slice(c * per, (c + 1) * per));
    const keyWs = cols.map((c) => Math.max(...c.map(keysW)));
    const ws = cols.map((c, i) => Math.max(...c.map((e) => keyWs[i]! + 2 + len(e.label))));
    if (ws.reduce((a, b) => a + b, 0) + COL_GAP * (n - 1) > innerW) continue;
    const lines = Array.from({ length: per }, (_, r) => cols.flatMap((c, i): Seg[] => {
      const e = c[r];
      if (!e) return [];
      const last = i === n - 1 || !cols[i + 1]![r];
      return [
        ...(i ? pad(COL_GAP) : []),
        { text: e.prim }, ...(withSec && e.sec ? [{ text: ` ${e.sec}`, dim: true }] : []),
        ...pad(keyWs[i]! - keysW(e) + 2), { text: e.label },
        ...(last ? [] : pad(ws[i]! - keyWs[i]! - 2 - len(e.label))),
      ];
    }));
    return shape(lines.filter((l) => l.length), withSec ? "grid" : "primaries");
  }
  // Flow: `keys label` units along each row, two spaces apart, with the secondaries (dim) when they all fit whole, else
  // without; what does not fit even then ends in `…`.
  let cut = false;
  const flow = (withSec: boolean): Seg[][][] => {
    const units = entries.map((e): Seg[] => {
      const segs: Seg[] = [{ text: e.prim }, ...(withSec && e.sec ? [{ text: ` ${e.sec}`, dim: true }] : []), { text: ` ${e.label}` }];
      const t = plain(segs);
      if (len(t) <= innerW) return segs;
      cut = true;
      return [{ text: [...t].slice(0, Math.max(1, innerW - 1)).join("") + "…" }];
    });
    const rows: Seg[][][] = [[]];
    for (const u of units) {
      const row = rows[rows.length - 1]!;
      if (row.length && rowW(row) + COL_GAP + len(plain(u)) > innerW) rows.push([u]); else row.push(u);
    }
    return rows;
  };
  const rowW = (row: Seg[][]) => row.reduce((a, u) => a + len(plain(u)), 0) + COL_GAP * Math.max(0, row.length - 1);
  const joined = (row: Seg[][]): Seg[] => row.flatMap((u, i) => (i ? [...pad(COL_GAP), ...u] : u));
  const full = flow(true);
  if (full.length <= inner && !cut) return shape(full.map(joined), "flow");
  const rows = flow(false);
  if (rows.length > inner) {
    const kept = rows.slice(0, inner), last = kept[kept.length - 1]!;
    while (last.length > 1 && rowW(last) + COL_GAP + 1 > innerW) last.pop();
    last.push([{ text: "…" }]);
    return shape(kept.map(joined), "flow");
  }
  return shape(rows.map(joined), "flow");
}
