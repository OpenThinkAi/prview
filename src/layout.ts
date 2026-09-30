// The geometry of the screen and of the float, pure so the corner cases (an 80-column terminal, a float
// taller than the window, a page key past the end) are tested without drawing anything.

/** Below this many columns the rail shrinks to chapter numbers so the code keeps the room. */
export const NARROW = 100;

export type Layout = { narrow: boolean; railW: number; mainW: number; gutterW: number; codeW: number; floatW: number; floatInner: number };

export function layoutOf(cols: number): Layout {
  const narrow = cols < NARROW;
  const railW = narrow ? 8 : Math.min(34, Math.max(24, Math.floor(cols * 0.28)));
  const mainW = cols - railW - 1;
  const gutterW = 5;
  const codeW = mainW - gutterW - 5; // paddingLeft, number, space, mark, space, and one to spare
  const floatW = mainW - gutterW - 4;
  return { narrow, railW, mainW, gutterW, codeW, floatW, floatInner: floatW - 4 }; // border and padding on each side
}

/**
 * Total rows of the float box: its text plus border, title, border, capped so the code window keeps at least
 * three rows, which is what guarantees the cursor line is never covered however tall the float wants to be.
 */
export function floatHeight(textLines: number, rows: number, tall: boolean): number {
  const wanted = tall ? rows - 8 : Math.max(5, Math.floor(rows / 2));
  const cap = Math.max(4, Math.min(wanted, rows - 8));
  return Math.min(textLines + 3, cap);
}

export const floatRows = (floatH: number) => Math.max(1, floatH - 3);
export const clampScroll = (scroll: number, textLines: number, floatH: number) => Math.max(0, Math.min(scroll, textLines - floatRows(floatH)));
/** A page keeps one line of the previous page in view, so the eye has something to hold on to. */
export const pageStep = (floatH: number) => Math.max(1, floatRows(floatH) - 1);

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
