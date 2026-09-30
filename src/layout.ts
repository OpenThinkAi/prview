// The geometry of the screen, pure so the corner cases (an 80-column terminal, a 24-row one, text longer than the
// content area, a page key past the end) are tested without drawing anything. Top to bottom:
//
//   status area    the title, then the fields (status.ts)                  STATUS_H rows: border, two lines, border
//   middle         the table of contents (the rail) and the code            what is left
//   bottom panel   the content area (left) and the key panel (right)        a third of the screen, 8 to 14 rows
//   footer         what a key just did, or the chord being typed            one row
//
// `v z` (zen) hides the rail and gives the code its width; `v c` makes the bottom panel the whole screen under the
// status area, so the content area can be read at length (the key panel stays beside it).

/** Below this many columns the rail shrinks to chapter numbers so the code keeps the room. */
export const NARROW = 100;
export const STATUS_H = 4;
export const FOOTER_H = 1;
/** The bottom panel's height: a third of the screen, never below 8 rows or above 14, tuned for 32 to 60 row terminals. */
export const BOTTOM_MIN = 8;
export const BOTTOM_MAX = 14;
/** The middle keeps this many rows (the path, the intent and a few code lines); on a short terminal the bottom panel gives them up first. */
export const MIDDLE_MIN = 8;

/** Rows of the bottom panel, borders and title included, for `rows` rows of screen. */
export function bottomHeight(rows: number): number {
  const want = Math.max(BOTTOM_MIN, Math.min(BOTTOM_MAX, Math.floor(rows / 3)));
  return Math.max(4, Math.min(want, rows - STATUS_H - FOOTER_H - MIDDLE_MIN));
}

export type Layout = {
  narrow: boolean; zen: boolean; full: boolean;
  /** The middle: the rail (0 in zen), the code beside it, and the finding box under its line. */
  middleH: number; railW: number; mainW: number; gutterW: number; codeW: number; boxW: number; boxInner: number;
  /** The bottom panel: the content area, whose text is `contentInner` wide and `contentRows` tall, and the key panel. */
  bottomH: number; contentW: number; contentInner: number; contentRows: number; panelW: number;
};

export function layoutOf(cols: number, rows: number, { zen = false, full = false }: { zen?: boolean; full?: boolean } = {}): Layout {
  const narrow = cols < NARROW;
  const railW = zen ? 0 : narrow ? 8 : Math.min(34, Math.max(24, Math.floor(cols * 0.28)));
  const mainW = cols - railW - 1;
  const gutterW = 5;
  const codeW = mainW - gutterW - 5; // paddingLeft, number, space, mark, space, and one to spare
  const boxW = mainW - gutterW - 4;
  const bottomH = full ? Math.max(4, rows - STATUS_H - FOOTER_H) : bottomHeight(rows);
  const middleH = full ? 0 : Math.max(0, rows - STATUS_H - FOOTER_H - bottomH);
  // The key panel is about a third of the width: room for two columns of keys at 120 columns and up.
  const panelW = Math.max(24, Math.floor(cols * 0.36));
  const contentW = cols - panelW;
  return { narrow, zen, full, middleH, railW, mainW, gutterW, codeW, boxW, boxInner: boxW - 4, bottomH, contentW, contentInner: contentW - 4, contentRows: Math.max(1, bottomH - 3), panelW };
}

/**
 * Lines of the finding's text the box on its line shows under the bold title: two, fewer when the middle is so short
 * that the code window would drop under three rows (the box itself takes its border twice and the title).
 */
export const boxLines = (middleH: number): number => Math.max(0, Math.min(2, middleH - 2 - 3 - 3));

export const clampScroll = (scroll: number, textLines: number, visible: number) => Math.max(0, Math.min(scroll, textLines - visible));
/** A page keeps one line of the previous page in view, so the eye has something to hold on to. */
export const pageStep = (visible: number) => Math.max(1, visible - 1);

/**
 * Which lines of the hunk to draw: the cursor's line always, then as many neighbours as fit in `budget` rows,
 * taking one from above and one from below in turn so the cursor stays near the middle.
 * `heights` is the rows each line takes (more than one when wrapping, or with a note under it).
 */
export function windowOf(heights: number[], cursor: number, budget: number): { start: number; end: number } {
  if (!heights.length) return { start: 0, end: 0 };
  const at = Math.max(0, Math.min(cursor, heights.length - 1));
  let lo = at, hi = at + 1, used = heights[at]!;
  for (;;) {
    let grew = false;
    if (lo > 0 && used + heights[lo - 1]! <= budget) { used += heights[--lo]!; grew = true; }
    if (hi < heights.length && used + heights[hi]! <= budget) { used += heights[hi++]!; grew = true; }
    if (!grew) return { start: lo, end: hi };
  }
}

/** Rows a line of `len` columns takes when wrapped to `width`. */
export const rowsFor = (len: number, width: number) => Math.max(1, Math.ceil(len / Math.max(1, width)));

export function wrapText(s: string, width: number): string[] {
  const out: string[] = [];
  for (const para of s.split("\n")) {
    let cur = "";
    // A word wider than the box (a long path, say) is broken across rows rather than cut: a box can
    // hold a command the reader is asked to allow, and every character of it has to be visible.
    const words = para.split(/\s+/).filter(Boolean).flatMap((w) => w.length <= width || width < 1 ? [w] : w.match(new RegExp(`.{1,${width}}`, "g"))!);
    for (const w of words) {
      if (cur && (cur + " " + w).length > width) { out.push(cur); cur = w; } else cur = cur ? `${cur} ${w}` : w;
    }
    out.push(cur);
  }
  return out;
}
