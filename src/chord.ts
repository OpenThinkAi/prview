// From a keypress to an action: the terminal's bytes (or Ink's reading of them) to a key token, then a token, in a
// state, with or without a prefix pending, to what happens. Pure, so every chord is tested without a screen:
//
//   a prefix, then its second key            `g f`, `v w`, `a ?`
//   g, digits, g (or Enter)                   `g 120 g`: that line of this file
//   g c, digits, g (or Enter)                 `g c 3 g`: that chapter
//
// The number closes on the prefix key it opened with (the g prefix is not remappable, so that is always g); Enter does
// the same. With no digits typed yet, `g` or Enter after `g c` cancels the chord; a bare `g g` is go.top.
//
// Esc cancels a pending prefix (and a half-typed number); any key that is not one of the prefix's second keys
// cancels it too, and does nothing else. With nothing pending, Esc is `escape`: the screen backs out of whatever is open.

import { isPrefix, keysOf, prefixesOf, prefixRows, rowsOf, type KeyState, type Keymap, type Prefix, currentKeymap } from "./keys.ts";

/** A prefix waiting for its second key; with `digits` a number is being typed after g (`chapter`: after g c). */
export type Pending = { prefix: Prefix; digits?: string; chapter?: boolean };

export type Step =
  | { kind: "act"; id: string; n?: number }
  | { kind: "pending" }
  | { kind: "cancel" }
  | { kind: "escape" }
  | { kind: "none" };

/** One key: the new pending prefix (or null) and what the key did. */
export function step(ks: KeyState, pending: Pending | null, token: string, km: Keymap = currentKeymap()): { pending: Pending | null; out: Step } {
  const idle = (out: Step) => ({ pending: null, out });
  if (token === "esc") {
    if (pending) return idle({ kind: "cancel" });
    // The steps that list Esc (a prompt's cancel, the submit's back) act on it; everywhere else it backs out.
    const row = rowsOf(ks, km).find((r) => keysOf(r).includes("esc"));
    return idle(row ? { kind: "act", id: row.id } : { kind: "escape" });
  }
  if (pending?.digits !== undefined) {
    if (/^[0-9]$/.test(token)) return { pending: { ...pending, digits: pending.digits + token }, out: { kind: "pending" } };
    if (token === "backspace") return { pending: { ...pending, digits: pending.digits.slice(0, -1) }, out: { kind: "pending" } };
    if ((token === "enter" || token === pending.prefix) && pending.digits) return idle({ kind: "act", id: pending.chapter ? "go.chapter" : "go.line", n: parseInt(pending.digits, 10) });
    return idle({ kind: "cancel" });
  }
  if (pending) {
    const rows = prefixRows(ks, pending.prefix, km);
    if (pending.prefix === "g" && /^[0-9]$/.test(token) && rows.some((r) => r.id === "go.line")) return { pending: { prefix: "g", digits: token }, out: { kind: "pending" } };
    const hit = rows.find((r) => r.id !== "go.line" && keysOf(r).includes(token));
    if (!hit) return idle({ kind: "cancel" });
    if (hit.id === "go.chapter") return { pending: { prefix: "g", digits: "", chapter: true }, out: { kind: "pending" } };
    return idle({ kind: "act", id: hit.id });
  }
  const hit = rowsOf(ks, km).find((r) => keysOf(r).includes(token));
  if (hit) return idle({ kind: "act", id: hit.id });
  if (isPrefix(token) && prefixesOf(ks, km).includes(token)) return { pending: { prefix: token }, out: { kind: "pending" } };
  return idle({ kind: "none" });
}

/** What the footer shows while a chord is being typed: `g`, `g 12`, `g c 3`. */
export const pendingText = (p: Pending | null): string => !p ? "" : `${p.prefix}${p.chapter ? " c" : ""}${p.digits !== undefined ? ` ${p.digits}` : ""}`;

// ---------------------------------------------------------------- the terminal's keys

/** What Ink hands a key handler about the key, the fields read here. */
export type InkKey = {
  upArrow?: boolean; downArrow?: boolean; leftArrow?: boolean; rightArrow?: boolean; pageUp?: boolean; pageDown?: boolean;
  home?: boolean; end?: boolean; return?: boolean; escape?: boolean; ctrl?: boolean; shift?: boolean; tab?: boolean;
  backspace?: boolean; delete?: boolean; meta?: boolean;
};

const ARROW: Record<string, string> = { A: "up", B: "down", C: "right", D: "left" };

/**
 * A raw escape sequence to its token: the plain arrows (CSI and SS3), shift-arrows as xterm sends them
 * (`\x1b[1;2A`..`D`) and as rxvt does (`\x1b[a`..`d`), shift-Tab, paging, Home and End. Null for anything else.
 */
export function parseSequence(seq: string): string | null {
  let m: RegExpMatchArray | null;
  if ((m = seq.match(/^\x1b[[O]([ABCD])$/))) return ARROW[m[1]!]!;
  if ((m = seq.match(/^\x1b\[1;(\d+)([ABCD])$/))) return (((Number(m[1]) - 1) & 1) ? "shift-" : "") + ARROW[m[2]!]!;
  if ((m = seq.match(/^\x1b\[([abcd])$/))) return "shift-" + ARROW[m[1]!.toUpperCase()]!;
  if (seq === "\x1b[Z") return "shift-tab";
  if (seq === "\x1b[5~") return "pgup";
  if (seq === "\x1b[6~") return "pgdn";
  if (seq === "\x1b[H" || seq === "\x1b[1~" || seq === "\x1bOH") return "home";
  if (seq === "\x1b[F" || seq === "\x1b[4~" || seq === "\x1bOF") return "end";
  return null;
}

/** Ink's reading of a key to a token, or null for one that means nothing here (a bare modifier, an unknown sequence). */
export function tokenOf(input: string, key: InkKey): string | null {
  const arrow = key.upArrow ? "up" : key.downArrow ? "down" : key.leftArrow ? "left" : key.rightArrow ? "right" : null;
  if (arrow) return key.shift ? `shift-${arrow}` : arrow;
  if (key.tab) return key.shift ? "shift-tab" : "tab";
  if (key.return) return "enter";
  if (key.escape && !input) return "esc";
  if (key.pageUp) return "pgup";
  if (key.pageDown) return "pgdn";
  if (key.home) return "home";
  if (key.end) return "end";
  if (key.backspace || key.delete) return "backspace";
  if (key.ctrl && /^[a-z]$/.test(input)) return `ctrl-${input}`;
  if (input === " ") return "space";
  // One raw control character, as a paste or a split chunk delivers it.
  const RAW: Record<string, string> = { "\r": "enter", "\n": "enter", "\t": "tab", "\x7f": "backspace", "\b": "backspace", "\x1b": "esc" };
  if (RAW[input]) return RAW[input]!;
  if (/^[\x01-\x1a]$/.test(input)) return `ctrl-${String.fromCharCode(input.charCodeAt(0) + 96)}`;
  // A sequence Ink did not recognise reaches here with its ESC stripped ("[1;2B"): read it ourselves.
  if (/^[[O][0-9;]*[A-Za-z~]$/.test(input)) return parseSequence("\x1b" + input);
  if ([...input].length === 1 && !key.ctrl && !key.meta) return input;
  if (key.escape) return "esc";
  return null;
}
