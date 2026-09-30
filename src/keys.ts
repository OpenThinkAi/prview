// The keys, one table per screen state. The footer is drawn from the table and the key handler gates on it, so
// what the footer shows is exactly what works: nothing listed does nothing, and nothing acts that is not listed.
// Esc and paging (PgUp/PgDn, ctrl-u/ctrl-d) always act and are not listed, except PgUp/PgDn when a box scrolls.

export type KeyRow = { key: string; label: string };
const line = (rows: KeyRow[]) => rows.map((k) => `${k.key} ${k.label}`).join("  ");

/** A key like "j/k" is two keys; "]f" is a two-key chord, so `]` and `[` (its `[f` twin) start it. */
export const keysOf = (rows: KeyRow[]): string[] => rows.flatMap((r) => r.key.split("/").flatMap((k) => k === "]f" ? ["]", "["] : [k]));
export const accepts = (rows: KeyRow[], ch: string): boolean => keysOf(rows).includes(ch);

/** A finding's box: the decisions, plus hide, the next finding and copy. */
export const FINDING_KEYS: KeyRow[] = [
  { key: "n", label: "not an issue" }, { key: "b", label: "block" }, { key: "c", label: "comment" }, { key: "u", label: "undo" },
  { key: "h", label: "hide" }, { key: "]f", label: "next" }, { key: "y", label: "copy" },
];
export const findingFooter = (): string => line(FINDING_KEYS);

/** Every other box: the opening summary, `?` why, an `a` answer, `F` reveal and the notices. Hide records nothing. */
export const INFO_KEYS: KeyRow[] = [{ key: "h", label: "hide" }, { key: "y", label: "copy" }, { key: "]f", label: "finding" }];
/** A notice with no source text of its own (a hint, an error) has nothing for `y` to copy, so it does not list it and `y` does nothing. */
export const infoRows = (copyable: boolean): KeyRow[] => copyable ? INFO_KEYS : INFO_KEYS.filter((k) => k.key !== "y");
export const infoFooter = (copyable: boolean, scrolls: boolean): string => line(infoRows(copyable)) + (scrolls ? "  PgUp/PgDn page" : "");

/**
 * No box open. `blind`: only with --blind. `short`: the row as the narrow footer words it; rows without one are left out there.
 * Not listed but acting: a count before G or a chord (`123G`), `gg`/`G`, the arrow keys and space.
 */
export const NAV_KEYS: (KeyRow & { blind?: true; short?: string })[] = [
  { key: "j/k", label: "line", short: "j/k line" }, { key: "h/l", label: "hunk", short: "h/l hunk" }, { key: "J/K", label: "chapter" },
  { key: "]f/f", label: "find", short: "]f find" }, { key: "F", label: "reveal", blind: true, short: "F reveal" },
  { key: "?", label: "why", short: "? why" }, { key: "y", label: "copy", short: "y copy" }, { key: "a", label: "ask", short: "a ask" },
  { key: "e", label: "edit" }, { key: "n/N", label: "note", short: "n note" }, { key: "w", label: "wrap" }, { key: "H/L", label: "pan" },
  { key: "s", label: "submit", short: "s submit" }, { key: "q", label: "quit", short: "q quit" },
];
const navRows = (blind: boolean) => NAV_KEYS.filter((k) => !k.blind || blind);
/** The whole list when it fits in `cols` (with the footer's leading space), else the short one. */
export function navFooter(cols: number, blind: boolean): string {
  const full = line(navRows(blind));
  return cols >= full.length + 2 ? full : navRows(blind).filter((k) => k.short).map((k) => k.short).join("  ");
}
export const navAccepts = (blind: boolean, ch: string): boolean => accepts(navRows(blind), ch);
