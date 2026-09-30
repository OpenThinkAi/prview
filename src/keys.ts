// The keys, one table per screen state. Each row is an action: a stable id (`<state>.<action>`), the key that
// triggers it, the label the footer shows and a one-line description of what it does. The footer is drawn from the
// table and the key handler resolves a keypress to an action id through the same table, so what the footer shows is
// exactly what works: nothing listed does nothing, and nothing acts that is not listed.
// Esc and paging (PgUp/PgDn, ctrl-u/ctrl-d) always act and are not listed, except PgUp/PgDn when a box scrolls.
// A `hidden` row acts but stays out of the footer: `[f` is the unspoken twin of `]f`.
// The tables below are the defaults. `effectiveKeys` lays the user's [keys] over them and `installKeymap` makes the
// result the one every footer, hint and lookup reads; nothing outside this file names a key directly.

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
export type NavAction = Action & { blind?: true; short?: number };
/** One table per state: what the footer, the lookup and the key panel read. */
export type Keymap = { nav: NavAction[]; finding: Action[]; info: Action[] };

export type KeyState = { box: "finding" } | { box: "info"; copyable: boolean } | { box: null; blind: boolean };

/** Consecutive visible rows with the same label read as one footer entry: j and k, both "line", show as "j/k line". */
function groups<R extends Action>(rows: R[]): R[][] {
  const out: R[][] = [];
  for (const r of rows.filter((x) => !x.hidden && x.key)) {
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
export const findingFooter = (): string => line(active.finding);

/** Every other box: the opening summary, `?` why, an `a` answer, `F` reveal and the notices. Hide records nothing. */
export const INFO_KEYS: Action[] = [
  { id: "info.hide", key: "h", label: "hide", description: "Close the box; nothing is recorded." },
  { id: "info.copy", key: "y", label: "copy", description: "Copy the box's text to the clipboard." },
  { id: "info.next_finding", key: "]f", label: "finding", description: "Go to the next finding anywhere in the review." },
  { id: "info.prev_finding", key: "[f", label: "previous finding", description: "Go to the previous finding anywhere in the review.", hidden: true },
];
/** A notice with no source text of its own (a hint, an error) has nothing for `y` to copy, so it does not list it and `y` does nothing. */
export const infoRows = (copyable: boolean): Action[] => copyable ? active.info : active.info.filter((k) => k.id !== "info.copy");
export const infoFooter = (copyable: boolean, scrolls: boolean): string => line(infoRows(copyable)) + (scrolls ? "  PgUp/PgDn page" : "");

/**
 * No box open. `blind`: only with --blind. `short`: on the first row of an entry, how many of its keys the narrow footer
 * shows (with the entry's label); entries without one are left out there.
 * Not listed but acting (documented exceptions, see NAV_ALIASES and the handler): a count before G or a chord
 * (`123G`), `gg`/`G`, the arrow keys, space, and `]c`/`[c`.
 */
export const NAV_KEYS: NavAction[] = [
  { id: "nav.line_down", key: "j", label: "line", short: 2, description: "Move the cursor down a line (a count moves that many)." },
  { id: "nav.line_up", key: "k", label: "line", description: "Move the cursor up a line (a count moves that many)." },
  { id: "nav.prev_hunk", key: "h", label: "hunk", short: 2, description: "Go to the previous hunk in reading order." },
  { id: "nav.next_hunk", key: "l", label: "hunk", description: "Go to the next hunk in reading order." },
  { id: "nav.next_chapter", key: "J", label: "chapter", description: "Go to the first hunk of the next chapter." },
  { id: "nav.prev_chapter", key: "K", label: "chapter", description: "Go to the first hunk of the previous chapter." },
  { id: "nav.next_finding", key: "]f", label: "find", short: 1, description: "Go to the next finding anywhere in the review and open it." },
  { id: "nav.finding_here", key: "f", label: "find", description: "Open the next finding in this hunk, from the cursor, wrapping." },
  { id: "nav.prev_finding", key: "[f", label: "find", description: "Go to the previous finding anywhere in the review and open it.", hidden: true },
  { id: "nav.reveal", key: "F", label: "reveal", blind: true, short: 1, description: "Reveal this chapter's findings before you have been through it." },
  { id: "nav.why", key: "?", label: "why", short: 1, description: "Explain why this chapter is here and what to check in it." },
  { id: "nav.copy", key: "y", label: "copy", short: 1, description: "Copy the cursor line's path:line reference." },
  { id: "nav.ask", key: "a", label: "ask", short: 1, description: "Ask the model a question about this hunk." },
  { id: "nav.edit", key: "e", label: "edit", description: "Open the file in the editor at the cursor line." },
  { id: "nav.note", key: "n", label: "note", short: 1, description: "Write a comment on the cursor line." },
  { id: "nav.general_note", key: "N", label: "note", description: "Write a general comment on the whole pull request." },
  { id: "nav.wrap", key: "w", label: "wrap", description: "Toggle wrapping long lines." },
  { id: "nav.pan_left", key: "H", label: "pan", description: "Scroll unwrapped code left." },
  { id: "nav.pan_right", key: "L", label: "pan", description: "Scroll unwrapped code right." },
  { id: "nav.submit", key: "s", label: "submit", short: 1, description: "Choose a verdict and preview the submission." },
  { id: "nav.bindings", key: "\\", label: "keys", short: 1, description: "Show the key bindings for this state." },
  { id: "nav.quit", key: "q", label: "quit", short: 1, description: "Leave prview; the review so far is kept." },
];
const navRows = (blind: boolean) => active.nav.filter((k) => !k.blind || blind);
/** The whole list when it fits in `cols` (with the footer's leading space), else the short one. */
export function navFooter(cols: number, blind: boolean): string {
  const full = line(navRows(blind));
  if (cols >= full.length + 2) return full;
  // A group whose first key was unbound still counts: the entry's size comes from whichever of its rows has one.
  return groups(navRows(blind)).flatMap((g) => { const n = Math.max(0, ...g.map((r) => r.short ?? 0)); return n ? [`${g.slice(0, n).map((r) => r.key).join("/")} ${g[0]!.label}`] : []; }).join("  ");
}

/** Keys that act with no box open without a row of their own: spare spellings of a listed action, left out of the footer. */
export const NAV_ALIASES: Record<string, string> = { " ": "nav.next_hunk", "]c": "nav.next_chapter", "[c": "nav.prev_chapter" };

/** The rows that act in a state: an unbound row (key "") does nothing and is not listed. */
export const rowsOf = (s: KeyState): Action[] => (s.box === "finding" ? active.finding : s.box === "info" ? infoRows(s.copyable) : navRows(s.blind)).filter((r) => r.key);

/** The one lookup: a key (or a finished chord) in a state, to the action it triggers, if any. */
export const actionOf = (s: KeyState, key: string): string | undefined =>
  rowsOf(s).find((r) => r.key === key)?.id ?? (s.box === null ? NAV_ALIASES[key] : undefined);

/** `]` or `[` starts a chord where some action in the state is bound to one beginning with it. */
export const startsChord = (s: KeyState, ch: string): boolean =>
  [...rowsOf(s).map((r) => r.key), ...(s.box === null ? Object.keys(NAV_ALIASES) : [])].some((k) => k.length === 2 && k[0] === ch);

/** Every action in every table, for the uniqueness check and anything that lists them (the key panel, docs). */
export const ALL_ACTIONS: Action[] = [...NAV_KEYS, ...FINDING_KEYS, ...INFO_KEYS];

// ---------------------------------------------------------------- the user's bindings

export const DEFAULT_KEYMAP: Keymap = { nav: NAV_KEYS, finding: FINDING_KEYS, info: INFO_KEYS };
let active: Keymap = DEFAULT_KEYMAP;
/** Make `km` the keymap every footer, hint and lookup reads. The CLI does this once at startup; tests restore DEFAULT_KEYMAP. */
export const installKeymap = (km: Keymap): void => { active = km; };
export const currentKeymap = (): Keymap => active;

/** The key an action is bound to right now, for hints that name a key in a sentence. */
export const keyOf = (id: string): string => [...active.nav, ...active.finding, ...active.info].find((a) => a.id === id)?.key || "(unbound)";

/** The action that shows the bindings: it can be rebound but never unbound, or the user could not find the others. */
export const BINDINGS_ACTION = "nav.bindings";

export class KeysError extends Error {}

const STATES = ["nav", "finding", "info"] as const;
/** Keys that act before the tables are consulted: a digit starts a count, g and G are gg/G and the go-to-line. */
const RAW = /^[0-9gG]$/;
const CHORD_FIRST = "[]";
const printable = (c: string) => /^[^\p{C}\s]$/u.test(c);

/** Why `key` cannot be a binding, or null when it can: one printable character, or a two-key chord starting with [ or ]. */
export function badKey(key: string): string | null {
  const cs = [...key];
  if (/^(esc|escape)$/i.test(key) || key === "\x1b") return "Esc always closes and cannot be rebound";
  if (cs.length === 1 && printable(key)) return RAW.test(key) ? "digits, g and G are taken by counts, gg and G" : null;
  if (cs.length === 2 && CHORD_FIRST.includes(cs[0]!) && printable(cs[1]!)) return null;
  return 'a key is one printable character or a chord like "]f" (a [ or ] and one more)';
}

/** The state's own tables, in order, with the spare spellings (space, ]c, [c) as rows of their own for the conflict check. */
function occupants(state: (typeof STATES)[number], km: Keymap): { id: string; key: string }[] {
  const rows: { id: string; key: string }[] = km[state].filter((r) => r.key);
  if (state !== "nav") return rows;
  const spare = Object.entries(NAV_ALIASES)
    .filter(([k, id]) => !rows.some((r) => r.id === id && r.key === k))
    .map(([k, id]) => ({ id: `${id} (its spare spelling)`, key: k }));
  return [...rows, ...spare];
}

/**
 * The defaults with `overrides` ({ "<state>.<action>": key }) laid over them. An empty key unbinds an action. Throws a
 * KeysError, worded for the person who wrote the config, on an unknown action, a key that cannot be a binding, the show-bindings
 * action unbound, or two actions in one state on the same key (or one key swallowing the other's chord).
 */
export function effectiveKeys(overrides: Record<string, string> = {}): Keymap {
  const known = new Set(ALL_ACTIONS.map((a) => a.id));
  for (const [id, key] of Object.entries(overrides)) {
    if (!known.has(id)) throw new KeysError(`[keys]: unknown action "${id}"; prview keys lists them`);
    if (key === "") {
      if (id === BINDINGS_ACTION) throw new KeysError(`[keys]: ${id} can be rebound but not unbound`);
      continue;
    }
    const why = badKey(key);
    if (why) throw new KeysError(`[keys]: ${id} = ${JSON.stringify(key)}: ${why}`);
  }
  const lay = <R extends Action>(rows: R[]): R[] => rows.map((r) => (r.id in overrides ? { ...r, key: overrides[r.id]! } : r));
  const km: Keymap = { nav: lay(NAV_KEYS), finding: lay(FINDING_KEYS), info: lay(INFO_KEYS) };
  for (const state of STATES) {
    const rows = occupants(state, km);
    rows.forEach((a, i) => {
      for (const b of rows.slice(i + 1)) {
        if (a.key === b.key) throw new KeysError(`[keys]: ${a.id} and ${b.id} are both ${JSON.stringify(a.key)} in the ${state} state`);
        for (const [x, y] of [[a, b], [b, a]] as const) {
          if ([...x.key].length === 1 && [...y.key].length === 2 && y.key[0] === x.key) throw new KeysError(`[keys]: ${x.id} = ${JSON.stringify(x.key)} would swallow ${y.id}, bound to ${JSON.stringify(y.key)}, in the ${state} state`);
        }
      }
    });
  }
  return km;
}

const STATE_NAMES: Record<(typeof STATES)[number], string> = { nav: "nav: reading, no box open", finding: "finding: a finding's box is open", info: "info: any other box is open" };

/** `prview keys`: the effective bindings grouped by state, as aligned columns of action, key and description. */
export function describeKeymap(km: Keymap = active): string {
  const out: string[] = [];
  for (const state of STATES) {
    const rows: Action[] = km[state];
    const w = Math.max(...rows.map((r) => r.id.length)), kw = Math.max(...rows.map((r) => (r.key || "(unbound)").length));
    out.push(STATE_NAMES[state]);
    for (const r of rows) out.push(`  ${r.id.padEnd(w)}  ${(r.key || "(unbound)").padEnd(kw)}  ${r.description}`);
    out.push("");
  }
  out.push("Always on, not rebindable: Esc closes, PgUp/PgDn and ctrl-u/ctrl-d page, 123G and gg/G, the arrow keys, space, ]c and [c.");
  return out.join("\n");
}

/** The body of the in-screen bindings box: what each listed key does in `s`. */
export function bindingsBody(s: KeyState): string {
  return rowsOf(s).map((r) => `${r.key.padEnd(3)} ${r.description}`).join("\n");
}
