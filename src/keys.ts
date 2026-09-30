// The keys, one table per screen state. Each row is an action: a stable id (`<state>.<action>`), the key that
// triggers it, the label the footer shows and a one-line description of what it does. The footer is drawn from the
// table and the key handler resolves a keypress to an action id through the same table, so what the footer shows is
// exactly what works: nothing listed does nothing, and nothing acts that is not listed.
// Esc and paging (PgUp/PgDn, ctrl-u/ctrl-d) always act and are not listed, except PgUp/PgDn when a box scrolls.
// A `hidden` row acts but stays out of the footer: `[f` is the unspoken twin of `]f`.

export type Action = {
  /** Stable across key changes: bindings, the key panel and docs name the action by it. */
  id: string;
  /** One key, or a two-key chord like "]f". */
  key: string;
  label: string;
  description: string;
  hidden?: true;
};

/** Where a key is pressed: the open box, or none. The same key means different actions in each. */
export type KeyState = { box: "finding" } | { box: "info"; copyable: boolean } | { box: null; blind: boolean };

/** Consecutive visible rows with the same label read as one footer entry: j and k, both "line", show as "j/k line". */
function groups<R extends Action>(rows: R[]): R[][] {
  const out: R[][] = [];
  for (const r of rows.filter((x) => !x.hidden)) {
    const last = out[out.length - 1];
    if (last && last[0]!.label === r.label) last.push(r); else out.push([r]);
  }
  return out;
}
const line = (rows: Action[]) => groups(rows).map((g) => `${g.map((r) => r.key).join("/")} ${g[0]!.label}`).join("  ");

/** A finding's box: the decisions, plus hide, the next finding and copy. */
export const FINDING_KEYS: Action[] = [
  { id: "finding.not_an_issue", key: "n", label: "not an issue", description: "Dismiss the finding as not an issue, with a reason." },
  { id: "finding.block", key: "b", label: "block", description: "Block on the finding with a comment that requests changes." },
  { id: "finding.comment", key: "c", label: "comment", description: "Answer the finding with a comment that does not block." },
  { id: "finding.undo", key: "u", label: "undo", description: "Take back the decision made on this finding." },
  { id: "finding.hide", key: "h", label: "hide", description: "Close the box without deciding anything." },
  { id: "finding.next", key: "]f", label: "next", description: "Go to the next finding anywhere in the review." },
  { id: "finding.prev", key: "[f", label: "previous", description: "Go to the previous finding anywhere in the review.", hidden: true },
  { id: "finding.copy", key: "y", label: "copy", description: "Copy the finding's text to the clipboard." },
];
export const findingFooter = (): string => line(FINDING_KEYS);

/** Every other box: the opening summary, `?` why, an `a` answer, `F` reveal and the notices. Hide records nothing. */
export const INFO_KEYS: Action[] = [
  { id: "info.hide", key: "h", label: "hide", description: "Close the box; nothing is recorded." },
  { id: "info.copy", key: "y", label: "copy", description: "Copy the box's text to the clipboard." },
  { id: "info.next_finding", key: "]f", label: "finding", description: "Go to the next finding anywhere in the review." },
  { id: "info.prev_finding", key: "[f", label: "previous finding", description: "Go to the previous finding anywhere in the review.", hidden: true },
];
/** A notice with no source text of its own (a hint, an error) has nothing for `y` to copy, so it does not list it and `y` does nothing. */
export const infoRows = (copyable: boolean): Action[] => copyable ? INFO_KEYS : INFO_KEYS.filter((k) => k.id !== "info.copy");
export const infoFooter = (copyable: boolean, scrolls: boolean): string => line(infoRows(copyable)) + (scrolls ? "  PgUp/PgDn page" : "");

/**
 * No box open. `blind`: only with --blind. `short`: the entry as the narrow footer words it, on the first row of an
 * entry; entries without one are left out there.
 * Not listed but acting (documented exceptions, see NAV_ALIASES and the handler): a count before G or a chord
 * (`123G`), `gg`/`G`, the arrow keys, space, and `]c`/`[c`.
 */
export const NAV_KEYS: (Action & { blind?: true; short?: string })[] = [
  { id: "nav.line_down", key: "j", label: "line", short: "j/k line", description: "Move the cursor down a line (a count moves that many)." },
  { id: "nav.line_up", key: "k", label: "line", description: "Move the cursor up a line (a count moves that many)." },
  { id: "nav.prev_hunk", key: "h", label: "hunk", short: "h/l hunk", description: "Go to the previous hunk in reading order." },
  { id: "nav.next_hunk", key: "l", label: "hunk", description: "Go to the next hunk in reading order." },
  { id: "nav.next_chapter", key: "J", label: "chapter", description: "Go to the first hunk of the next chapter." },
  { id: "nav.prev_chapter", key: "K", label: "chapter", description: "Go to the first hunk of the previous chapter." },
  { id: "nav.next_finding", key: "]f", label: "find", short: "]f find", description: "Go to the next finding anywhere in the review and open it." },
  { id: "nav.finding_here", key: "f", label: "find", description: "Open the next finding in this hunk, from the cursor, wrapping." },
  { id: "nav.prev_finding", key: "[f", label: "find", description: "Go to the previous finding anywhere in the review and open it.", hidden: true },
  { id: "nav.reveal", key: "F", label: "reveal", blind: true, short: "F reveal", description: "Reveal this chapter's findings before you have been through it." },
  { id: "nav.why", key: "?", label: "why", short: "? why", description: "Explain why this chapter is here and what to check in it." },
  { id: "nav.copy", key: "y", label: "copy", short: "y copy", description: "Copy the cursor line's path:line reference." },
  { id: "nav.ask", key: "a", label: "ask", short: "a ask", description: "Ask the model a question about this hunk." },
  { id: "nav.edit", key: "e", label: "edit", description: "Open the file in the editor at the cursor line." },
  { id: "nav.note", key: "n", label: "note", short: "n note", description: "Write a comment on the cursor line." },
  { id: "nav.general_note", key: "N", label: "note", description: "Write a general comment on the whole pull request." },
  { id: "nav.wrap", key: "w", label: "wrap", description: "Toggle wrapping long lines." },
  { id: "nav.pan_left", key: "H", label: "pan", description: "Scroll unwrapped code left." },
  { id: "nav.pan_right", key: "L", label: "pan", description: "Scroll unwrapped code right." },
  { id: "nav.submit", key: "s", label: "submit", short: "s submit", description: "Choose a verdict and preview the submission." },
  { id: "nav.quit", key: "q", label: "quit", short: "q quit", description: "Leave prview; the review so far is kept." },
];
const navRows = (blind: boolean) => NAV_KEYS.filter((k) => !k.blind || blind);
/** The whole list when it fits in `cols` (with the footer's leading space), else the short one. */
export function navFooter(cols: number, blind: boolean): string {
  const full = line(navRows(blind));
  return cols >= full.length + 2 ? full : groups(navRows(blind)).map((g) => g[0]!.short).filter(Boolean).join("  ");
}

/** Keys that act with no box open without a row of their own: spare spellings of a listed action, left out of the footer. */
export const NAV_ALIASES: Record<string, string> = { " ": "nav.next_hunk", "]c": "nav.next_chapter", "[c": "nav.prev_chapter" };

export const rowsOf = (s: KeyState): Action[] => s.box === "finding" ? FINDING_KEYS : s.box === "info" ? infoRows(s.copyable) : navRows(s.blind);

/** The one lookup: a key (or a finished chord) in a state, to the action it triggers, if any. */
export const actionOf = (s: KeyState, key: string): string | undefined =>
  rowsOf(s).find((r) => r.key === key)?.id ?? (s.box === null ? NAV_ALIASES[key] : undefined);

/** `]` or `[` starts a chord where some action in the state is bound to one beginning with it. */
export const startsChord = (s: KeyState, ch: string): boolean =>
  [...rowsOf(s).map((r) => r.key), ...(s.box === null ? Object.keys(NAV_ALIASES) : [])].some((k) => k.length === 2 && k[0] === ch);

/** Every action in every table, for the uniqueness check and anything that lists them (the key panel, docs). */
export const ALL_ACTIONS: Action[] = [...NAV_KEYS, ...FINDING_KEYS, ...INFO_KEYS];
