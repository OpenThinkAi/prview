// The keys (key map v2). Every action is a row: a stable id, the states it acts in, a primary key, an optional
// secondary key (the vim/helix spelling), the label the key panel shows and a one-line description. Arrows move around
// the review; letter prefixes hold everything else: `a` AI, `f` filter, `v` view, `g` go to. A prefixed row's key is
// its second key, pressed after the prefix. The key panel (panel.ts) is drawn from these rows and the key handler
// resolves a keypress through the same rows (chord.ts), so what the panel lists is exactly what acts.
//
// Ids are `<state>.<action>` for an action of one state, and `<group>.<action>` for one shared by several: the
// prefix groups (`ai`, `filter`, `view`, `go`) and `review`, the keys that act anywhere outside a finding.
// Esc is not a row: it always backs out of whatever is open (a pending prefix, a finding, the content area, a prompt).
// Keys are tokens: one printable character, or a name (`down`, `shift-down`, `enter`, `tab`, `pgdn`, `ctrl-d`, ...).
// The rows below are the defaults. `effectiveKeys` lays the user's [keys] over them and `installKeymap` makes the result
// the one every hint, panel and lookup reads; nothing outside this file names a key directly.

export const STATES = ["toc", "code", "finding", "content", "prompt", "submit", "settings"] as const;
export type State = (typeof STATES)[number];
/** The states whose keys can be remapped; prompts, the submit steps and settings keep theirs. */
export const REMAPPABLE_STATES: readonly State[] = ["toc", "code", "finding", "content"];

export const PREFIXES = { a: "AI", f: "filter", v: "view", g: "go to" } as const;
export type Prefix = keyof typeof PREFIXES;
export const isPrefix = (k: string): k is Prefix => k in PREFIXES;

export type Action = {
  /** Stable across key changes: bindings, the key panel and the docs name the action by it. */
  id: string;
  /** Where it acts. */
  states: readonly State[];
  /** Pressed after this prefix: `key` is then the second key. */
  prefix?: Prefix;
  /** The primary key, a token; "" when unbound. */
  key: string;
  /** The alias (vim/helix spelling), if any. */
  secondary?: string;
  label: string;
  description: string;
  /** Not remappable: Tab, the prompt and submit steps, settings, and `g <digits> g` (the number closes on the prefix key itself, Enter alike). */
  fixed?: true;
  /**
   * Submit only: the steps it is pressed in; in the comment step, whether only while typing (true) or only while not
   * (false); and `needs: "boxes"`, in the send step only when the submit has a checkbox (a command, a coverage line).
   * Inside a finding, `needs: "answer"`: only while an answer about it waits for `a a` / `a x`.
   */
  steps?: readonly SubmitStep[];
  typing?: boolean;
  needs?: "boxes" | "answer";
};

/** The submit flow's steps (submit-flow.ts): the findings checklist, the verdict, the top-level comment, then send. */
export type SubmitStep = "findings" | "verdict" | "comment" | "send";

/** A line being typed: `docs` is the question put to the docs search (`ask` is the one put to a model). */
export type PromptKind = "ask" | "comment" | "reason" | "docs" | "severity" | "finding";

/**
 * Where a key is pressed. `content` with `results`: docs search answers, where the arrows select. In the submit flow's
 * comment step `typing` is whether the box takes the keys; in its send step `boxes` is whether there is a checkbox.
 */
export type KeyState =
  | { state: "toc" | "code" | "settings" }
  /** `answer`: an answer about this finding is waiting to be accepted or discarded. */
  | { state: "finding"; answer?: boolean }
  | { state: "content"; results?: boolean }
  | { state: "prompt"; kind: PromptKind; decide?: boolean }
  | { state: "submit"; step: "findings" | "verdict" }
  | { state: "submit"; step: "comment"; typing: boolean }
  | { state: "submit"; step: "send"; dryRun: boolean; boxes: boolean };

const TOC: readonly State[] = ["toc"], CODE: readonly State[] = ["code"], FINDING: readonly State[] = ["finding"], CONTENT: readonly State[] = ["content"];
const OUTSIDE: readonly State[] = ["toc", "code"], READING: readonly State[] = ["toc", "code", "finding"];

export const DEFAULT_ACTIONS: readonly Action[] = [
  // ---- the table of contents, where a review opens: the cursor is on a chapter or one of its blocks
  { id: "toc.down", states: TOC, key: "down", secondary: "j", label: "block", description: "Move to the next block in the table of contents; a collapsed chapter is one stop." },
  { id: "toc.up", states: TOC, key: "up", secondary: "k", label: "block", description: "Move to the previous block in the table of contents; a collapsed chapter is one stop." },
  { id: "toc.next_chapter", states: TOC, key: "shift-down", secondary: "J", label: "chapter", description: "Move to the next chapter in the table of contents." },
  { id: "toc.prev_chapter", states: TOC, key: "shift-up", secondary: "K", label: "chapter", description: "Move to the previous chapter in the table of contents." },
  { id: "toc.expand", states: TOC, key: "right", secondary: "l", label: "expand / enter", description: "Expand the chapter under the cursor (on an expanded one, go to its first block), or enter the block's code." },
  { id: "toc.collapse", states: TOC, key: "left", secondary: "h", label: "collapse", description: "Collapse the chapter under the cursor; on a block, go up to its chapter." },
  { id: "toc.focus_content", states: TOC, key: "tab", label: "content", description: "Move focus into the content area to scroll it.", fixed: true },

  // ---- the code
  { id: "code.down", states: CODE, key: "down", secondary: "j", label: "line", description: "Move down a line; at the end of a block it runs on into the next one." },
  { id: "code.up", states: CODE, key: "up", secondary: "k", label: "line", description: "Move up a line; at the start of a block it runs on into the one before." },
  { id: "code.next_chapter", states: CODE, key: "shift-down", secondary: "J", label: "chapter", description: "Go to the first block of the next chapter." },
  { id: "code.prev_chapter", states: CODE, key: "shift-up", secondary: "K", label: "chapter", description: "Go to the first block of the previous chapter." },
  { id: "code.open_finding", states: CODE, key: "right", secondary: "l", label: "open finding", description: "Open the finding on the cursor line." },
  { id: "code.to_toc", states: CODE, key: "left", secondary: "h", label: "contents", description: "Back to the table of contents at this block, which shows the chapter's intent and why." },
  { id: "code.focus_content", states: CODE, key: "tab", label: "content", description: "Move focus into the content area to scroll it.", fixed: true },
  { id: "code.new_finding", states: CODE, key: "enter", label: "new finding", description: "Write a finding of your own on the cursor line, or on a file's whole-file row: pick a severity, then write the comment, which posts if the finding's action is block or comment." },

  // ---- anywhere outside a finding
  { id: "review.submit", states: OUTSIDE, key: "s", label: "submit", description: "Submit the review: tick the findings to post, pick a verdict, write the top-level comment, see exactly what posts, then send." },
  { id: "review.copy", states: OUTSIDE, key: "y", label: "copy", description: "Copy the content area's main text; with nothing there, the cursor line's path and line number." },
  { id: "review.search_docs", states: OUTSIDE, key: "?", label: "search docs", description: "Search the docs in your own words and see the actions that answer it, with your keys; offline, no model." },
  { id: "review.settings", states: OUTSIDE, key: "\\", label: "settings", description: "Open the settings: keys, default actions, models, editor and display, saved to the config file." },
  { id: "review.quit", states: OUTSIDE, key: "q", label: "quit", description: "Leave prview; the review so far is kept." },

  // ---- inside a finding
  { id: "finding.close", states: FINDING, key: "x", label: "close", description: "Close the finding; its action stays as it is." },
  { id: "finding.back", states: FINDING, key: "left", secondary: "h", label: "back", description: "Close the finding and go back to its line in the code." },
  { id: "finding.block", states: FINDING, key: "b", label: "block", description: "Set the finding's action to block: a comment that requests changes, prefilled with its text or your comment." },
  { id: "finding.comment", states: FINDING, key: "c", label: "comment", description: "Set the finding's action to comment: a comment that does not block, prefilled with its text or your comment." },
  { id: "finding.ignore", states: FINDING, key: "i", label: "ignore", description: "Set the finding's action to ignore, with an optional private note that is never posted." },
  { id: "finding.copy", states: FINDING, key: "y", label: "copy", description: "Copy the finding's text to the clipboard." },
  { id: "finding.page_down", states: FINDING, key: "pgdn", secondary: "ctrl-d", label: "page", description: "Page the finding's text down." },
  { id: "finding.page_up", states: FINDING, key: "pgup", secondary: "ctrl-u", label: "page", description: "Page the finding's text up." },
  { id: "finding.focus_content", states: FINDING, key: "tab", label: "content", description: "Move focus into the content area to scroll the finding's detail; the finding stays open.", fixed: true },

  // ---- the content area, with focus in it
  { id: "content.down", states: CONTENT, key: "down", secondary: "j", label: "scroll", description: "Scroll the content area down, or select the next search result." },
  { id: "content.up", states: CONTENT, key: "up", secondary: "k", label: "scroll", description: "Scroll the content area up, or select the previous search result." },
  { id: "content.page_down", states: CONTENT, key: "pgdn", secondary: "ctrl-d", label: "page", description: "Page the content area down." },
  { id: "content.page_up", states: CONTENT, key: "pgup", secondary: "ctrl-u", label: "page", description: "Page the content area up." },
  { id: "content.copy", states: CONTENT, key: "y", label: "copy", description: "Copy the content area's main text, or the selected search result." },
  { id: "content.back", states: CONTENT, key: "tab", label: "back", description: "Move focus back out of the content area, to the open finding, the code or the table of contents where it was.", fixed: true },

  // ---- a: AI
  { id: "ai.info", states: OUTSIDE, prefix: "a", key: "i", label: "info", description: "Show the summary of this change: the overview, suggested verdicts and who prepared it." },
  { id: "ai.ask", states: READING, prefix: "a", key: "?", label: "ask", description: "Ask the agent about the block under the cursor (code), the chapter (table of contents) or the open finding; it reads the code to answer, and follow-ups keep the conversation." },
  { id: "ai.draft", states: OUTSIDE, prefix: "a", key: "s", label: "draft submission", description: "Have the model draft a submission: the findings to include, a verdict and a comment, for you to review." },
  { id: "ai.accept", states: FINDING, needs: "answer", prefix: "a", key: "a", label: "accept answer", description: "Accept the agent's answer about this finding: its proposed severity, title, claim or ignore is applied, and the finding notes it was revised." },
  { id: "ai.discard", states: FINDING, needs: "answer", prefix: "a", key: "x", label: "discard answer", description: "Discard the agent's answer about this finding and leave the finding as it was." },

  // ---- f: filter
  { id: "filter.high", states: OUTSIDE, prefix: "f", key: "h", label: "high only", description: "Show only the high severity findings." },
  { id: "filter.medium", states: OUTSIDE, prefix: "f", key: "m", label: "high and medium", description: "Show the high and medium severity findings." },
  { id: "filter.all", states: OUTSIDE, prefix: "f", key: "a", label: "all", description: "Show every finding." },

  // ---- v: view
  { id: "view.zen", states: READING, prefix: "v", key: "z", label: "zen", description: "Hide or show the table of contents." },
  { id: "view.fullscreen", states: [...READING, "content"], prefix: "v", key: "c", label: "full-screen content", description: "Make the content area full-screen, where the arrows scroll it, or restore it; Esc restores it too." },
  { id: "view.editor", states: READING, prefix: "v", key: "e", label: "editor", description: "Open the file in your editor at the cursor line." },
  { id: "view.wrap", states: READING, prefix: "v", key: "w", label: "wrap", description: "Wrap long lines onto more rows, or cut them again." },

  // ---- g: go to
  { id: "go.next_finding", states: READING, prefix: "g", key: "f", label: "next finding", description: "Go to the next finding anywhere in the review and open it, wrapping round at the end." },
  { id: "go.prev_finding", states: READING, prefix: "g", key: "F", label: "previous finding", description: "Go to the previous finding anywhere in the review and open it, wrapping round at the start." },
  { id: "go.next_severity", states: READING, prefix: "g", key: "h", label: "next by severity", description: "Go to the next finding by severity: every high one in order, then the medium ones, then the low ones." },
  { id: "go.prev_severity", states: READING, prefix: "g", key: "H", label: "previous by severity", description: "Go to the previous finding by severity, the reverse of next by severity." },
  { id: "go.top", states: READING, prefix: "g", key: "g", label: "top of file", description: "Go to the first line of this file's first block." },
  { id: "go.end", states: READING, prefix: "g", key: "e", label: "end of file", description: "Go to the last line of this file's last block." },
  { id: "go.line", states: READING, prefix: "g", key: "<n>", label: "line", description: "Type a line number, then close it with the go prefix key again or Enter, to go to that line of this file, or the nearest line shown.", fixed: true },
  { id: "go.chapter", states: READING, prefix: "g", key: "c", label: "chapter", description: "Type a chapter number, then close it with the go prefix key again or Enter, to go to that chapter's first block." },

  // ---- a line being typed
  { id: "prompt.send", states: ["prompt"], key: "enter", label: "send", description: "Send the line.", fixed: true },
  { id: "prompt.clear", states: ["prompt"], key: "ctrl-u", label: "clear line", description: "Clear the whole line.", fixed: true },
  { id: "prompt.word", states: ["prompt"], key: "ctrl-w", label: "delete word", description: "Delete the last word.", fixed: true },
  { id: "prompt.cancel", states: ["prompt"], key: "esc", label: "cancel", description: "Cancel; nothing is recorded.", fixed: true },
  { id: "prompt.up", states: ["prompt"], key: "up", secondary: "k", label: "severity", description: "Pick the previous severity for your new finding.", fixed: true },
  { id: "prompt.down", states: ["prompt"], key: "down", secondary: "j", label: "severity", description: "Pick the next severity for your new finding.", fixed: true },
  { id: "prompt.newline", states: ["prompt"], key: "ctrl-n", label: "new line", description: "Start a new line in a comment of several lines.", fixed: true },

  // ---- submit: the findings checklist, the verdict, the top-level comment, then send (submit-flow.ts). Tab and ⇧Tab
  // move between the steps; Esc leaves without sending, except while typing the comment, where it stops the typing.
  { id: "submit.down", states: ["submit"], steps: ["findings", "verdict", "send"], needs: "boxes", key: "down", secondary: "j", label: "move", description: "Move to the next finding, verdict or checkbox.", fixed: true },
  { id: "submit.up", states: ["submit"], steps: ["findings", "verdict", "send"], needs: "boxes", key: "up", secondary: "k", label: "move", description: "Move to the previous finding, verdict or checkbox.", fixed: true },
  { id: "submit.tick", states: ["submit"], steps: ["findings", "send"], needs: "boxes", key: "space", label: "tick", description: "Tick or untick the finding (or the checkbox) under the cursor.", fixed: true },
  { id: "submit.tick_all", states: ["submit"], steps: ["findings"], key: "a", label: "tick all", description: "Tick every finding, or untick them all when every one is ticked.", fixed: true },
  { id: "submit.newline", states: ["submit"], steps: ["comment"], typing: true, key: "enter", label: "new line", description: "Start a new line in the comment.", fixed: true },
  { id: "submit.clear_line", states: ["submit"], steps: ["comment"], typing: true, key: "ctrl-u", label: "clear line", description: "Clear the line being typed.", fixed: true },
  { id: "submit.word", states: ["submit"], steps: ["comment"], typing: true, key: "ctrl-w", label: "delete word", description: "Delete the last word.", fixed: true },
  { id: "submit.stop_typing", states: ["submit"], steps: ["comment"], typing: true, key: "esc", label: "done typing", description: "Stop typing; the comment stays as it is.", fixed: true },
  { id: "submit.edit", states: ["submit"], steps: ["comment"], typing: false, key: "enter", label: "type", description: "Type in the comment again.", fixed: true },
  { id: "view.comment_editor", states: ["submit"], steps: ["comment"], typing: false, prefix: "v", key: "e", label: "editor", description: "Write the comment in your editor; it comes back here when you quit it.", fixed: true },
  { id: "submit.send", states: ["submit"], steps: ["send"], key: "enter", label: "send", description: "Send: write the document, post it, and run the command if ticked (a dry run only prints the calls).", fixed: true },
  { id: "submit.page_down", states: ["submit"], steps: ["send"], key: "pgdn", secondary: "ctrl-d", label: "page", description: "Page the preview down.", fixed: true },
  { id: "submit.page_up", states: ["submit"], steps: ["send"], key: "pgup", secondary: "ctrl-u", label: "page", description: "Page the preview up.", fixed: true },
  { id: "submit.next", states: ["submit"], steps: ["findings", "verdict", "comment"], key: "tab", label: "next step", description: "Go on to the next step.", fixed: true },
  { id: "submit.back", states: ["submit"], steps: ["verdict", "comment", "send"], key: "shift-tab", label: "step back", description: "Go back to the step before.", fixed: true },
  { id: "submit.leave", states: ["submit"], steps: ["findings", "verdict", "comment", "send"], typing: false, key: "esc", label: "leave", description: "Leave the submit flow; nothing is sent.", fixed: true },

  // ---- settings (settings.ts): the arrows walk the fields, Enter edits one, Esc leaves. Fixed, so a rebinding can never lock you out of the view that fixes it.
  { id: "settings.down", states: ["settings"], key: "down", secondary: "j", label: "field", description: "Move to the next field.", fixed: true },
  { id: "settings.up", states: ["settings"], key: "up", secondary: "k", label: "field", description: "Move to the previous field.", fixed: true },
  { id: "settings.right", states: ["settings"], key: "right", secondary: "l", label: "primary / secondary", description: "On a key, move to its secondary binding.", fixed: true },
  { id: "settings.left", states: ["settings"], key: "left", secondary: "h", label: "primary / secondary", description: "On a key, move to its primary binding.", fixed: true },
  { id: "settings.edit", states: ["settings"], key: "enter", label: "edit", description: "Edit the field: for a key the next keypress becomes the binding; a choice steps to its next value; the editor takes a line.", fixed: true },
  { id: "settings.clear", states: ["settings"], key: "backspace", label: "clear secondary", description: "Clear a key's secondary binding.", fixed: true },
  { id: "settings.leave", states: ["settings"], key: "esc", label: "leave", description: "Leave the settings, asking first when there are unsaved changes.", fixed: true },
];

/**
 * Old `[keys]` action ids (before key map v2), each to the action that took its place, or null when it was removed.
 * A config naming one is refused with this, so an old binding never silently does nothing.
 */
export const RENAMED: Readonly<Record<string, string | null>> = {
  "nav.line_down": "code.down", "nav.line_up": "code.up", "nav.next_chapter": "code.next_chapter", "nav.prev_chapter": "code.prev_chapter",
  "nav.next_hunk": null, "nav.prev_hunk": null, "nav.finding_here": "code.open_finding", "nav.next_finding": "go.next_finding",
  "nav.prev_finding": "go.prev_finding", "nav.reveal": null, "nav.withdrawn": null, "nav.why": "code.to_toc", "nav.summary": "ai.info",
  "nav.copy": "review.copy", "nav.ask": "ai.ask", "nav.ask_docs": "review.search_docs", "nav.edit": "view.editor", "nav.note": "code.new_finding",
  "nav.general_note": null, "nav.wrap": "view.wrap", "nav.pan_left": null, "nav.pan_right": null, "nav.submit": "review.submit",
  "nav.bindings": null, "nav.quit": "review.quit",
  "finding.not_an_issue": "finding.ignore", "finding.undo": null, "finding.hide": "finding.close", "finding.next": "go.next_finding",
  "finding.prev": "go.prev_finding",
  "info.hide": null, "info.copy": "review.copy", "info.next_finding": "go.next_finding", "info.prev_finding": "go.prev_finding",
};

// ---------------------------------------------------------------- key tokens

/** The named keys a binding may use besides one printable character. */
export const NAMED_KEYS = ["up", "down", "left", "right", "shift-up", "shift-down", "shift-left", "shift-right", "tab", "shift-tab", "enter", "esc", "backspace", "pgup", "pgdn", "space", "home", "end"] as const;
const SHOWN: Record<string, string> = {
  up: "↑", down: "↓", left: "←", right: "→", "shift-up": "⇧↑", "shift-down": "⇧↓", "shift-left": "⇧←", "shift-right": "⇧→",
  tab: "Tab", "shift-tab": "⇧Tab", enter: "Enter", esc: "Esc", backspace: "Backspace", pgup: "PgUp", pgdn: "PgDn", space: "Space", home: "Home", end: "End", "<n>": "<n> g",
};
/** A token as the panel and hints draw it: arrows as arrows, names capitalised, a character as itself. */
export const showKey = (token: string): string => SHOWN[token] ?? token;

/**
 * A go-to row's typed form: `<n> g` / `c <n> g` (the number closes on the prefix key, which is not remappable), and with
 * `alt` the Enter spelling `<n> Enter` / `c <n> Enter`. Null for any other row.
 */
export function gotoTyped(a: Action, alt = false): string | null {
  const end = alt ? "Enter" : (a.prefix ?? "g");
  if (a.id === "go.line") return `<n> ${end}`;
  if (a.id === "go.chapter") return `${showKey(a.key)} <n> ${end}`;
  return null;
}

const ALIASES: Record<string, string> = { return: "enter", escape: "esc", pagedown: "pgdn", pageup: "pgup", "page-down": "pgdn", "page-up": "pgup", " ": "space", "↑": "up", "↓": "down", "←": "left", "→": "right" };
const printable = (c: string) => /^[^\p{C}\s]$/u.test(c);

/** A key as written in the config to its token (`Shift+Down` → `shift-down`), or null when it is no key at all. */
export function normKey(raw: string): string | null {
  if ([...raw].length === 1) return ALIASES[raw] ?? (printable(raw) ? raw : null);
  const s = raw.trim().toLowerCase().replace(/\s*\+\s*/g, "-");
  const t = ALIASES[s] ?? s;
  if ((NAMED_KEYS as readonly string[]).includes(t)) return t;
  if (/^ctrl-[a-z]$/.test(t)) return t;
  return null;
}

// ---------------------------------------------------------------- the installed keymap

export type Keymap = { actions: readonly Action[] };
export const DEFAULT_KEYMAP: Keymap = { actions: DEFAULT_ACTIONS };
let active: Keymap = DEFAULT_KEYMAP;
/** Make `km` the keymap every panel, hint and lookup reads. The CLI does this once at startup; tests restore DEFAULT_KEYMAP. */
export const installKeymap = (km: Keymap): void => { active = km; };
export const currentKeymap = (): Keymap => active;

/** Every action a reader presses while reading (the docs describe these); the prompt, submit and settings steps are STEP_ACTIONS. */
export const ALL_ACTIONS: readonly Action[] = DEFAULT_ACTIONS.filter((a) => a.states.some((s) => REMAPPABLE_STATES.includes(s)));
export const STEP_ACTIONS: readonly Action[] = DEFAULT_ACTIONS.filter((a) => !ALL_ACTIONS.includes(a));

export const rowById = (id: string, km: Keymap = active): Action | undefined => km.actions.find((a) => a.id === id);
/** The keys that trigger a row, primary first; the unbound ones left out. */
export const keysOf = (a: Action): string[] => [a.key, a.secondary ?? ""].filter(Boolean);
/** The key an action is bound to right now, for hints that name a key in a sentence: `g f`, `⇧↓`, `Enter`. */
export function keyOf(id: string, km: Keymap = active): string {
  const a = rowById(id, km);
  const k = a ? keysOf(a)[0] : undefined;
  if (!a || !k) return "(unbound)";
  const second = gotoTyped(a) ?? showKey(k);
  return a.prefix ? `${a.prefix} ${second}` : second;
}

const inState = (ks: KeyState) => (a: Action): boolean => {
  if (!a.states.includes(ks.state)) return false;
  if (a.needs === "answer") return ks.state === "finding" && !!ks.answer;
  if (ks.state !== "submit") return true;
  if (!a.steps?.includes(ks.step)) return false;
  if (ks.step === "comment" && a.typing !== undefined && a.typing !== ks.typing) return false;
  return ks.step !== "send" || a.needs !== "boxes" || ks.boxes;
};

/** How a row reads in this state: labels that say what Enter, x or v will do right now. */
function worded(ks: KeyState, a: Action): Action {
  if (ks.state === "prompt") {
    if (a.id === "prompt.send") return { ...a, label: ks.kind === "ask" ? "ask" : ks.kind === "docs" ? "search" : ks.kind === "reason" ? "ignore" : ks.kind === "severity" ? "choose" : ks.decide || ks.kind === "finding" ? "save" : "send" };
    if (a.id === "prompt.cancel" && ks.decide) return { ...a, label: "cancel" };
  }
  if (ks.state === "content" && ks.results && (a.id === "content.down" || a.id === "content.up")) return { ...a, label: "select" };
  if (ks.state === "content" && ks.results && a.id === "content.back") return { ...a, label: "close" };
  if (ks.state === "submit") {
    if (a.id === "submit.send" && ks.step === "send" && ks.dryRun) return { ...a, label: "print the calls" };
    if (a.id === "submit.down" || a.id === "submit.up") return { ...a, label: ks.step === "findings" ? "finding" : ks.step === "verdict" ? "verdict" : "checkbox" };
  }
  return a;
}

/** The top-level rows that act in a state (no prefix), bound ones only, in table order. A prompt drops ctrl-w for the one-word ignore note. */
export const rowsOf = (ks: KeyState, km: Keymap = active): Action[] =>
  km.actions.filter((a) => !a.prefix && inState(ks)(a) && keysOf(a).length && !(ks.state === "prompt" && promptHides(ks.kind, a.id))).map((a) => worded(ks, a));

/** What a prompt does not list: the ignore note is one word (no ctrl-w); the arrows only pick a severity; a new line only where a comment can have several. The severity pick takes no text. */
const promptHides = (kind: PromptKind, id: string): boolean =>
  (kind === "reason" && id === "prompt.word") || ((id === "prompt.up" || id === "prompt.down") && kind !== "severity")
  || (id === "prompt.newline" && kind !== "finding" && kind !== "comment") || (kind === "severity" && (id === "prompt.clear" || id === "prompt.word"));

/** The second keys of prefix `p` in a state. */
export const prefixRows = (ks: KeyState, p: Prefix, km: Keymap = active): Action[] =>
  km.actions.filter((a) => a.prefix === p && inState(ks)(a) && keysOf(a).length);

/** The prefixes that have second keys in a state, in a/f/v/g order. */
export const prefixesOf = (ks: KeyState, km: Keymap = active): Prefix[] => (Object.keys(PREFIXES) as Prefix[]).filter((p) => prefixRows(ks, p, km).length);

/** Consecutive rows with the same label read as one panel entry: ↓ and ↑, both "line", show as "↓/↑ j/k line". */
export function groups<R extends Action>(rows: R[]): R[][] {
  const out: R[][] = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && last[0]!.label === r.label) last.push(r); else out.push([r]);
  }
  return out;
}

// ---------------------------------------------------------------- the user's bindings

export class KeysError extends Error {}

/** A [keys] entry: `"<action>" = "k"` sets the primary; `{ primary = "k", secondary = "j" }` either or both, `secondary = ""` removes it. */
export type Binding = { primary?: string; secondary?: string };

/** Why `token` cannot be `a`'s key, or null when it can. */
function badKey(a: Action, token: string): string | null {
  if (token === "esc") return "Esc always backs out and cannot be rebound";
  if (token === "tab" || token === "shift-tab") return "Tab moves focus to the content area and back, and cannot be rebound";
  if (a.prefix === "g" && /^[0-9]$/.test(token)) return "after g a digit starts a line number";
  return null;
}

/**
 * The defaults with `overrides` ({ "<id>": binding }) laid over them. Throws a KeysError, worded for the person who
 * wrote the config, on an old or unknown action, a fixed one, a key that is no key, Esc or Tab, or two bindings on one
 * key in one state (primary or secondary, a prefix's second keys among themselves, or a key that is a prefix there).
 */
export function effectiveKeys(overrides: Record<string, Binding> = {}): Keymap {
  const byId = new Map(DEFAULT_ACTIONS.map((a) => [a.id, a]));
  const set = new Map<string, Binding>();
  for (const [id, b] of Object.entries(overrides)) {
    const a = byId.get(id);
    if (!a) {
      if (id in RENAMED) {
        const now = RENAMED[id];
        throw new KeysError(now ? `[keys]: "${id}" is from the old key map; it is now "${now}" (prview keys lists them)` : `[keys]: "${id}" was removed in the new key map; delete that line (prview keys lists what there is)`);
      }
      throw new KeysError(`[keys]: unknown action "${id}"; prview keys lists them`);
    }
    if (a.fixed) throw new KeysError(`[keys]: ${id} is fixed (${showKey(a.key)}) and cannot be rebound`);
    const norm: Binding = {};
    for (const slot of ["primary", "secondary"] as const) {
      const raw = b[slot];
      if (raw === undefined) continue;
      if (raw === "") { norm[slot] = ""; continue; }
      const t = normKey(raw);
      if (!t) throw new KeysError(`[keys]: ${id} ${slot} = ${JSON.stringify(raw)}: a key is one printable character or a name (${NAMED_KEYS.filter((k) => !/tab|esc/.test(k)).join(", ")}, ctrl-<letter>)`);
      const why = badKey(a, t);
      if (why) throw new KeysError(`[keys]: ${id} ${slot} = ${JSON.stringify(raw)}: ${why}`);
      norm[slot] = t;
    }
    set.set(id, norm);
  }
  const actions = DEFAULT_ACTIONS.map((a) => {
    const b = set.get(a.id);
    if (!b) return a;
    const key = b.primary ?? a.key, secondary = b.secondary ?? a.secondary;
    return { ...a, key, secondary: secondary || undefined };
  });
  const km: Keymap = { actions };
  checkConflicts(km);
  return km;
}

const where = (a: Action, slot: "primary" | "secondary") => `${a.id}${slot === "secondary" ? " (secondary)" : ""}`;

/** Two bindings on one key in one state, per layer: the keys pressed first, and each prefix's second keys. */
function checkConflicts(km: Keymap): void {
  // A finding with an answer waiting has two keys more (a a, a x): it is checked as a state of its own.
  const variants: KeyState[] = [...REMAPPABLE_STATES.map((state) => ({ state }) as KeyState), { state: "finding", answer: true }];
  for (const ks of variants) {
    const state = ks.state;
    const layers: [string, Action[]][] = [["", rowsOf(ks, km)], ...prefixesOf(ks, km).map((p): [string, Action[]] => [p, prefixRows(ks, p, km)])];
    const prefixes = prefixesOf(ks, km);
    for (const [layer, rows] of layers) {
      const seen = new Map<string, string>();
      for (const a of rows) {
        for (const slot of ["primary", "secondary"] as const) {
          const k = slot === "primary" ? a.key : a.secondary;
          if (!k) continue;
          const at = layer ? ` after ${layer}` : "";
          if (!layer && isPrefix(k) && prefixes.includes(k)) throw new KeysError(`[keys]: ${where(a, slot)} = ${JSON.stringify(k)}, but ${k} is the ${PREFIXES[k]} prefix in the ${state} state`);
          const other = seen.get(k);
          if (other) throw new KeysError(other.startsWith(a.id + " ") || other === a.id ? `[keys]: ${a.id} has ${JSON.stringify(k)} as both primary and secondary` : `[keys]: ${other} and ${where(a, slot)} are both ${JSON.stringify(k)}${at} in the ${state} state`);
          seen.set(k, where(a, slot));
        }
      }
    }
  }
}

const STATE_NAMES: Record<State, string> = {
  toc: "toc: the table of contents", code: "code: reading the code, no finding open", finding: "finding: a finding is open",
  content: "content: focus in the content area (Tab)", prompt: "prompt: a line being typed", submit: "submit: the findings checklist, the verdict, the comment, then send",
  settings: "settings: the settings view",
};

/** `prview keys`: every action by state, then each prefix group, as aligned columns of action, primary, secondary and description. */
export function describeKeymap(km: Keymap = active): string {
  const all = km.actions;
  const w = Math.max(...all.map((a) => a.id.length));
  const shown = (a: Action, k: string | undefined, alt = false) => { const go = gotoTyped(a, alt); return go ? `${a.prefix} ${go}` : k ? (a.prefix ? `${a.prefix} ${showKey(k)}` : showKey(k)) : "-"; };
  const kw = Math.max(7, ...all.map((a) => shown(a, a.key || undefined).length)), sw = Math.max(9, ...all.map((a) => shown(a, a.secondary, true).length));
  const line = (a: Action) => `  ${a.id.padEnd(w)}  ${(a.key ? shown(a, a.key) : "(unbound)").padEnd(kw)}  ${shown(a, a.secondary, true).padEnd(sw)}  ${a.description}${a.fixed ? " (fixed)" : ""}`;
  const out: string[] = [`  ${"action".padEnd(w)}  ${"primary".padEnd(kw)}  ${"secondary".padEnd(sw)}  description`, ""];
  for (const state of STATES) {
    const rows = all.filter((a) => !a.prefix && a.states.includes(state) && (a.states[0] === state || a.states.length === 1));
    const shared = all.filter((a) => !a.prefix && a.states.length > 1 && a.states[0] !== state && a.states.includes(state));
    if (!rows.length && !shared.length) continue;
    out.push(STATE_NAMES[state]);
    for (const a of rows) out.push(line(a));
    if (shared.length) out.push(`  (and ${shared.map((a) => a.id).join(", ")}, listed above)`);
    out.push("");
  }
  for (const p of Object.keys(PREFIXES) as Prefix[]) {
    const rows = all.filter((a) => a.prefix === p);
    const states = [...new Set(rows.flatMap((a) => a.states))];
    out.push(`${p} then: ${PREFIXES[p]} (${states.join(", ")})`);
    for (const a of rows) out.push(line(a));
    out.push("");
  }
  out.push("Always: Esc backs out of anything (a pending prefix, a finding, the content area, a prompt). Esc and Tab cannot be rebound.");
  return out.join("\n");
}

// ---------------------------------------------------------------- the README's key map

const MD_SECTIONS: [string, (a: Action) => boolean][] = [
  ["Table of contents", (a) => !a.prefix && a.id.startsWith("toc.")],
  ["Code", (a) => !a.prefix && a.id.startsWith("code.")],
  ["Anywhere outside a finding", (a) => !a.prefix && a.id.startsWith("review.")],
  ["Inside a finding", (a) => !a.prefix && a.id.startsWith("finding.")],
  ["Content area, with focus in it", (a) => !a.prefix && a.id.startsWith("content.")],
  ["`a` AI", (a) => a.prefix === "a"],
  ["`f` filter", (a) => a.prefix === "f"],
  ["`v` view", (a) => a.prefix === "v" && a.id !== "view.comment_editor"],
  ["`g` go to", (a) => a.prefix === "g"],
];

/** The key map as Markdown tables, one per state or prefix, generated from the default rows so the README cannot drift from them. */
export function keysMarkdown(): string {
  const cell = (a: Action, k: string | undefined, alt = false): string => {
    const go = gotoTyped(a, alt);
    if (go) return `\`${a.prefix} ${go}\``;
    if (!k) return "";
    const typed = showKey(k);
    return `\`${a.prefix ? `${a.prefix} ${typed}` : typed}\``;
  };
  const out: string[] = [];
  for (const [title, pick] of MD_SECTIONS) {
    const rows = ALL_ACTIONS.filter(pick);
    if (!rows.length) continue;
    out.push(`**${title}**`, "", "| Key | Alt | Action | What it does |", "|---|---|---|---|");
    for (const a of rows) out.push(`| ${cell(a, a.key)} | ${cell(a, a.secondary, true)} | \`${a.id}\` | ${a.description.replace(/\|/g, "\\|")} |`);
    out.push("");
  }
  return out.join("\n").trimEnd();
}
