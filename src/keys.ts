// The keys, one table per screen state. Each row is an action: a stable id (`<state>.<action>`), the key that
// triggers it, the label the key panel shows and a one-line description of what it does. The panel (panel.ts) is drawn
// from the tables and the key handler resolves a keypress to an action id through the same tables, so what the panel
// shows is exactly what works: nothing listed does nothing, and nothing acts that is not listed. The footer keeps one
// permanent hint, the key of `nav.bindings`; the panel opens by itself in any state with keys of its own.
// Esc and paging (PgUp/PgDn, ctrl-u/ctrl-d) always act and are not listed, except in the preview, which lists paging.
// A `hidden` row acts but stays out of the panel: `[f` is the unspoken twin of `]f`.
// The tables below are the defaults. `effectiveKeys` lays the user's [keys] over them and `installKeymap` makes the
// result the one every hint, panel and lookup reads; nothing outside this file names a key directly.

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
export type NavAction = Action & { blind?: true };
/** One table per state: what the footer, the lookup and the key panel read. */
export type Keymap = { nav: NavAction[]; finding: Action[]; info: Action[] };

/**
 * The box, prompt or step a key is pressed in, or none. `prompt.kind` is the line being typed (`decide`: a block or
 * comment that decides a finding); in the preview `hook` and `coverage` are the current toggles, or null when the
 * submit has no such choice.
 */
export type KeyState =
  | { box: "finding" }
  | { box: "info"; copyable: boolean }
  | { box: null; blind: boolean }
  | { box: "prompt"; kind: PromptKind; decide?: boolean }
  | { box: "results" }
  | { box: "verdict" }
  | { box: "preview"; dryRun: boolean; hook: boolean | null; coverage: boolean | null };

/** The line being typed: `docs` is the question put to the offline docs search (`ask` is the one put to a model). */
export type PromptKind = "ask" | "comment" | "reason" | "docs";

/** Consecutive visible rows with the same label read as one panel entry: j and k, both "line", show as "j/k line". */
export function groups<R extends Action>(rows: R[]): R[][] {
  const out: R[][] = [];
  for (const r of rows.filter((x) => !x.hidden && x.key)) {
    const last = out[out.length - 1];
    if (last && last[0]!.label === r.label) last.push(r); else out.push([r]);
  }
  return out;
}

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

/** Every other box: the opening summary, `?` why, an `a` answer, `F` reveal and the notices. Hide records nothing. */
export const INFO_KEYS: Action[] = [
  { id: "info.hide", key: "h", label: "hide", description: "Close the box; nothing is recorded." },
  { id: "info.copy", key: "y", label: "copy", description: "Copy the box's text to the clipboard." },
  { id: "info.next_finding", key: "]f", label: "finding", description: "Go to the next finding anywhere in the review." },
  { id: "info.prev_finding", key: "[f", label: "previous finding", description: "Go to the previous finding anywhere in the review.", hidden: true },
];
/** A notice with no source text of its own (a hint, an error) has nothing for `y` to copy, so it does not list it and `y` does nothing. */
export const infoRows = (copyable: boolean): Action[] => copyable ? active.info : active.info.filter((k) => k.id !== "info.copy");

/**
 * No box open. `blind`: only with --blind.
 * Not listed but acting (documented exceptions, see NAV_ALIASES and the handler): a count before G or a chord
 * (`123G`), `gg`/`G`, the arrow keys, space, and `]c`/`[c`.
 */
export const NAV_KEYS: NavAction[] = [
  { id: "nav.line_down", key: "j", label: "line", description: "Move the cursor down a line (a count moves that many)." },
  { id: "nav.line_up", key: "k", label: "line", description: "Move the cursor up a line (a count moves that many)." },
  { id: "nav.prev_hunk", key: "h", label: "hunk", description: "Go to the previous hunk in reading order." },
  { id: "nav.next_hunk", key: "l", label: "hunk", description: "Go to the next hunk in reading order." },
  { id: "nav.next_chapter", key: "J", label: "chapter", description: "Go to the first hunk of the next chapter." },
  { id: "nav.prev_chapter", key: "K", label: "chapter", description: "Go to the first hunk of the previous chapter." },
  { id: "nav.next_finding", key: "]f", label: "find", description: "Go to the next finding anywhere in the review and open it." },
  { id: "nav.finding_here", key: "f", label: "find", description: "Open the next finding in this hunk, from the cursor, wrapping." },
  { id: "nav.prev_finding", key: "[f", label: "find", description: "Go to the previous finding anywhere in the review and open it.", hidden: true },
  { id: "nav.reveal", key: "F", label: "reveal", blind: true, description: "Reveal this chapter's findings before you have been through it." },
  { id: "nav.withdrawn", key: "W", label: "withdrawn", description: "Show or hide the findings the second look withdrew, dimmed in the gutter with its reason; they are never decided or posted." },
  { id: "nav.why", key: "?", label: "why", description: "Explain why this chapter is here and what to check in it." },
  { id: "nav.summary", key: "S", label: "summary", description: "Show the summary of this change again: the overview, any suggested verdicts and who prepared it." },
  { id: "nav.copy", key: "y", label: "copy", description: "Copy the cursor line's path:line reference." },
  { id: "nav.ask", key: "a", label: "ask", description: "Ask the model a question about this hunk." },
  { id: "nav.ask_docs", key: "/", label: "ask the docs", description: "Ask how to do something in your own words and see the actions that answer it, with your keys; offline, no model." },
  { id: "nav.edit", key: "e", label: "edit", description: "Open the file in the editor at the cursor line." },
  { id: "nav.note", key: "n", label: "note", description: "Write a comment on the cursor line." },
  { id: "nav.general_note", key: "N", label: "note", description: "Write a general comment on the whole pull request." },
  { id: "nav.wrap", key: "w", label: "wrap", description: "Toggle wrapping long lines." },
  { id: "nav.pan_left", key: "H", label: "pan", description: "Scroll unwrapped code left." },
  { id: "nav.pan_right", key: "L", label: "pan", description: "Scroll unwrapped code right." },
  { id: "nav.submit", key: "s", label: "submit", description: "Choose a verdict and preview the submission." },
  { id: "nav.bindings", key: "\\", label: "bindings", description: "Show or hide the panel of keys for where you are; it works in every state but a prompt, where it is text." },
  { id: "nav.quit", key: "q", label: "quit", description: "Leave prview; the review so far is kept." },
];
const navRows = (blind: boolean) => active.nav.filter((k) => !k.blind || blind);
/** Keys that act with no box open without a row of their own: spare spellings of a listed action, left out of the footer. */
export const NAV_ALIASES: Record<string, string> = { " ": "nav.next_hunk", "]c": "nav.next_chapter", "[c": "nav.prev_chapter" };

/** A line being typed: Enter, ctrl-u, ctrl-w and Esc act in every prompt, and what Enter does is worded per prompt. Text goes in as typed, so the bindings key cannot open the panel here. */
export const PROMPT_KEYS: Action[] = [
  { id: "prompt.send", key: "Enter", label: "send", description: "Send the line." },
  { id: "prompt.clear", key: "ctrl-u", label: "clear line", description: "Clear the whole line." },
  { id: "prompt.word", key: "ctrl-w", label: "delete word", description: "Delete the last word." },
  { id: "prompt.cancel", key: "Esc", label: "cancel", description: "Cancel; nothing is recorded." },
];
const promptRows = (s: { kind: PromptKind; decide?: boolean }): Action[] => {
  const send = s.kind === "ask" ? "ask" : s.kind === "docs" ? "search" : s.kind === "reason" ? "decide" : s.decide ? "save" : "send";
  return PROMPT_KEYS.filter((r) => s.kind !== "reason" || r.id !== "prompt.word").map((r) =>
    r.id === "prompt.send" ? { ...r, label: send } : r.id === "prompt.cancel" && s.decide ? { ...r, label: "cancel decision" } : r);
};

/** The answers to a docs question: pick one, copy it, close. Not remappable, like the other steps. */
export const RESULT_KEYS: Action[] = [
  { id: "results.down", key: "j", label: "select", description: "Select the next result." },
  { id: "results.up", key: "k", label: "select", description: "Select the previous result." },
  { id: "results.copy", key: "y", label: "copy", description: "Copy the selected result as plain text." },
  { id: "results.close", key: "Esc", label: "close", description: "Close the results." },
];

/** The verdict step after `s`. Enter takes the default: request changes when anything is blocking. */
export const VERDICT_KEYS: Action[] = [
  { id: "verdict.approve", key: "a", label: "approve", description: "Approve the change." },
  { id: "verdict.request_changes", key: "r", label: "request changes", description: "Request changes." },
  { id: "verdict.comment", key: "c", label: "comment", description: "Leave a comment verdict, neither approving nor blocking." },
  { id: "verdict.default", key: "Enter", label: "default verdict", description: "Take the default verdict: request changes when anything is blocking, else the one already chosen." },
  { id: "verdict.cancel", key: "Esc", label: "cancel", description: "Go back to the review without a verdict." },
];

/** The submit preview. `x` and `v` exist only when the submit has a command or a platform adapter to choose about. */
export const PREVIEW_KEYS: (Action & { needs?: "hook" | "coverage" })[] = [
  { id: "preview.submit", key: "Enter", label: "submit", description: "Submit: write the document and post it (a dry run only prints the calls)." },
  { id: "preview.hook", key: "x", label: "allow command", needs: "hook", description: "Allow or disallow the document's on_submit command for this submit." },
  { id: "preview.coverage", key: "v", label: "coverage line", needs: "coverage", description: "Add or drop the line saying how much you read in the posted summary." },
  { id: "preview.scroll_down", key: "j", label: "scroll", description: "Scroll the preview down a line." },
  { id: "preview.scroll_up", key: "k", label: "scroll", description: "Scroll the preview up a line." },
  { id: "preview.page", key: "PgUp/PgDn", label: "page", description: "Page the preview (ctrl-u and ctrl-d do the same)." },
  { id: "preview.back", key: "Esc", label: "back", description: "Go back to the verdict." },
];
const previewRows = (s: { dryRun: boolean; hook: boolean | null; coverage: boolean | null }): Action[] =>
  PREVIEW_KEYS.filter((r) => !r.needs || s[r.needs] !== null).map((r) =>
    r.id === "preview.submit" && s.dryRun ? { ...r, label: "print the calls" }
    : r.needs === "hook" ? { ...r, label: s.hook ? "disallow command" : "allow command" }
    : r.needs === "coverage" ? { ...r, label: s.coverage ? "drop coverage line" : "add coverage line" } : r);

/** The show-bindings row as it is bound now. One action, one key, in every state that can show the panel. */
const bindingsRow = (): Action => active.nav.find((r) => r.id === BINDINGS_ACTION)!;

/** The rows that act in a state: an unbound row (key "") does nothing and is not listed. A prompt takes text, so it has no bindings row. */
export const rowsOf = (s: KeyState): Action[] => {
  const rows: Action[] = s.box === "finding" ? active.finding : s.box === "info" ? infoRows(s.copyable) : s.box === "prompt" ? promptRows(s)
    : s.box === "results" ? RESULT_KEYS : s.box === "verdict" ? VERDICT_KEYS : s.box === "preview" ? previewRows(s) : navRows(s.blind);
  return [...rows, ...(s.box === null || s.box === "prompt" ? [] : [bindingsRow()])].filter((r) => r.key);
};

/** The one lookup: a key (or a finished chord) in a state, to the action it triggers, if any. */
export const actionOf = (s: KeyState, key: string): string | undefined =>
  rowsOf(s).find((r) => r.key === key)?.id ?? (s.box === null ? NAV_ALIASES[key] : undefined);

/** `]` or `[` starts a chord where some action in the state is bound to one beginning with it. */
export const startsChord = (s: KeyState, ch: string): boolean =>
  [...rowsOf(s).map((r) => r.key), ...(s.box === null ? Object.keys(NAV_ALIASES) : [])].some((k) => k.length === 2 && k[0] === ch);

/** Every remappable action, for the uniqueness check and anything that lists them (docs). */
export const ALL_ACTIONS: Action[] = [...NAV_KEYS, ...FINDING_KEYS, ...INFO_KEYS];
/** The prompt, verdict and preview steps: listed in the key panel and acted on there, not remappable and not in the docs, since they are the last step of a flow the docs already describe. */
export const STEP_ACTIONS: Action[] = [...PROMPT_KEYS, ...RESULT_KEYS, ...VERDICT_KEYS, ...PREVIEW_KEYS];

// ---------------------------------------------------------------- the user's bindings

export const DEFAULT_KEYMAP: Keymap = { nav: NAV_KEYS, finding: FINDING_KEYS, info: INFO_KEYS };
let active: Keymap = DEFAULT_KEYMAP;
/** Make `km` the keymap every footer, hint and lookup reads. The CLI does this once at startup; tests restore DEFAULT_KEYMAP. */
export const installKeymap = (km: Keymap): void => { active = km; };
export const currentKeymap = (): Keymap => active;

/** The key an action is bound to right now, for hints that name a key in a sentence. */
export const rowById = (id: string): Action | undefined => [...active.nav, ...active.finding, ...active.info].find((a) => a.id === id);
export const keyOf = (id: string): string => rowById(id)?.key || "(unbound)";

/** The action that shows the bindings: it can be rebound but never unbound, or the user could not find the others. */
export const BINDINGS_ACTION = "nav.bindings";
/** The footer's one permanent hint, from the effective binding. */
export const bindingsHint = (): string => `${keyOf(BINDINGS_ACTION)} ${bindingsRow().label}`;

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
  // The bindings key works in a box too, so it occupies its key there and another action cannot take it.
  if (state !== "nav") return [...rows, ...km.nav.filter((r) => r.id === BINDINGS_ACTION && r.key)];
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
