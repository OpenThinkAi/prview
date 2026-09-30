// One place that strips terminal control characters from text that did not come from the human at this
// keyboard: an imported document, a PR's title and body, a model's reply. It runs at each boundary, before
// the text is stored or rendered, so nothing downstream can be made to rewrite the screen, set the window
// title, or hide text with an escape sequence. Newline and tab are kept; everything else in C0 and C1 goes.

// Whole sequences first, so their payload does not survive as plain text: OSC (ESC ] … BEL|ST), the string
// controls DCS/SOS/PM/APC (… ST), CSI (ESC [ params final), then any other two-character ESC sequence.
// An unterminated string sequence is cut at the end of its line rather than eating the rest of the text.
/* eslint-disable no-control-regex */
const SEQUENCES = new RegExp([
  "(?:\\x1b\\]|\\x9d)[^\\x07\\x1b\\x9c\\n]*(?:\\x07|\\x1b\\\\|\\x9c)?",
  "(?:\\x1b[PX^_]|[\\x90\\x98\\x9e\\x9f])[^\\x1b\\x9c\\n]*(?:\\x1b\\\\|\\x9c)?",
  "(?:\\x1b\\[|\\x9b)[\\x30-\\x3f]*[\\x20-\\x2f]*[\\x40-\\x7e]?",
  "\\x1b[\\x20-\\x7e]?",
].join("|"), "g");
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
/* eslint-enable no-control-regex */

export const clean = (s: string): string => s.replace(SEQUENCES, "").replace(CONTROLS, "");

/** Does this string carry anything `clean` would remove? For values that must be refused, not quietly changed. */
export const isClean = (s: string): boolean => clean(s) === s;

/**
 * Diff text and file paths come from the PR's author and are shown as they are, but never as live escape codes: each
 * control character becomes a visible stand-in (ESC is ␛, the other C0 their control picture, DEL ␡, a C1 its `\xNN`), so the
 * reviewer sees that something odd is in the code instead of it silently vanishing. Render-time only: models and files keep the raw text.
 */
export const visible = (s: string): string =>
  s.replace(/[\x00-\x08\x0a-\x1f\x7f-\x9f]/g, (c) => { // tab is left to the caller, which widens it
    const n = c.charCodeAt(0);
    return n < 0x20 ? String.fromCharCode(0x2400 + n) : n === 0x7f ? "␡" : `\\x${n.toString(16)}`;
  });
